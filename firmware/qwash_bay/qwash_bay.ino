// QWASH peron firmware'i (Faz 3 SPIKE) - Arduino IDE.
// Kontrat: docs/IOT.md. Kurulum ve test: firmware/README.md
//
// Fail-safe ilkeleri:
//  - Acilista once tum roleler kapatilir.
//  - Sure ESP32'nin kendi millis() sayacindan gelir; Wi-Fi/MQTT kopsa da sure dolunca roleler kapanir.
//  - Kalan sure NVS'e yazilir; guc kesilip gelirse kalan sureyle devam edilir.
//  - Ayni commandId ikinci kez gelirse role tekrar cekilmez.
//  - WDT 15 sn; loop() takilirsa cihaz yeniden baslar.

#include <WiFi.h>
#include <WiFiManager.h>  // tzapu/WiFiManager
#include <PubSubClient.h>
#include <ArduinoJson.h>  // v7
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#if __has_include(<esp_mac.h>)
#include <esp_mac.h>  // Arduino-ESP32 3.x
#endif
#include <time.h>
#include <functional>
#include "config.h"
#include "display.h"

// ---------- Kimlik ve ayarlar ----------
static char deviceId[13];  // MAC, ayiracsiz buyuk harf (docs/IOT.md)
static char mqttHost[64] = DEFAULT_MQTT_HOST;
static char mqttPortStr[8] = DEFAULT_MQTT_PORT;
static char stationId[32] = DEFAULT_STATION_ID;
static char bayId[32] = DEFAULT_BAY_ID;
static char qrBase[96] = DEFAULT_QR_BASE;

static Preferences prefs;
static WiFiManager wm;
static WiFiClient net;
static PubSubClient mqtt(net);

static char tCmd[96], tAck[96], tStatus[96], tHeartbeat[96], tEvents[96];

// ---------- Seans durumu ----------
struct Session {
  bool active = false;
  char sessionId[40] = "";
  char commandId[40] = "";
  char program[16] = "";
  uint8_t relay = 0;  // 1..4
  uint32_t durationSec = 0;
  uint32_t endMs = 0;
};
static Session sess;
static char recentCmds[8][40];
static uint8_t recentIdx = 0;
static uint32_t lastNvsSave = 0, lastHeartbeat = 0, lastMqttTry = 0;
static bool recoveredPending = false;
static bool paramsChanged = false;
static UiMode uiMode = UiMode::BOOT;
static uint32_t lastUiSec = 0xFFFFFFFF;
static bool lastWifi = false, lastMqtt = false;
static uint32_t doneUntilMs = 0;

// ---------- Yardimcilar ----------
static void newUuid(char* out) {  // v4
  uint8_t b[16];
  esp_fill_random(b, sizeof(b));
  b[6] = (b[6] & 0x0F) | 0x40;
  b[8] = (b[8] & 0x3F) | 0x80;
  snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4],
           b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
}

static bool timeSynced() { return time(nullptr) > 1700000000; }

static void isoNow(char* out, size_t n) {
  time_t t = time(nullptr);
  struct tm tmv;
  gmtime_r(&t, &tmv);
  strftime(out, n, "%Y-%m-%dT%H:%M:%S.000Z", &tmv);
}

// "2026-09-17T01:30:10.000Z" -> epoch (TZ=UTC oldugu icin mktime dogrudur). Hata: 0.
static time_t parseIso(const char* s) {
  struct tm tmv = {};
  int y, mo, d, h, mi, se;
  if (!s || sscanf(s, "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &se) != 6) return 0;
  tmv.tm_year = y - 1900;
  tmv.tm_mon = mo - 1;
  tmv.tm_mday = d;
  tmv.tm_hour = h;
  tmv.tm_min = mi;
  tmv.tm_sec = se;
  return mktime(&tmv);
}

static void relaysAllOff() {
  for (int i = 0; i < 4; i++) {
    if (RELAY_PINS[i] < 0) continue;
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], RELAY_ACTIVE_HIGH ? LOW : HIGH);
  }
}

static void relaySet(uint8_t idx1, bool on) {
  if (idx1 < 1 || idx1 > 4) return;
  int pin = RELAY_PINS[idx1 - 1];
  Serial.printf("[relay] %u -> %s%s\n", idx1, on ? "ON" : "OFF", pin < 0 ? " (pin yok, kuru calisma)" : "");
  if (pin < 0) return;
  digitalWrite(pin, (on == RELAY_ACTIVE_HIGH) ? HIGH : LOW);
}

static bool seenCommand(const char* id) {
  for (auto& c : recentCmds)
    if (c[0] && strcmp(c, id) == 0) return true;
  return false;
}

static void rememberCommand(const char* id) {
  strlcpy(recentCmds[recentIdx], id, sizeof(recentCmds[0]));
  recentIdx = (recentIdx + 1) % 8;
  prefs.putString("lastCmd", id);
}

static uint32_t remainingSec() {
  if (!sess.active) return 0;
  int32_t left = (int32_t)(sess.endMs - millis());
  return left > 0 ? (uint32_t)((left + 999) / 1000) : 0;
}

// ---------- NVS ----------
static void loadSettings() {
  strlcpy(mqttHost, prefs.getString("mqttHost", DEFAULT_MQTT_HOST).c_str(), sizeof(mqttHost));
  strlcpy(mqttPortStr, prefs.getString("mqttPort", DEFAULT_MQTT_PORT).c_str(), sizeof(mqttPortStr));
  strlcpy(stationId, prefs.getString("station", DEFAULT_STATION_ID).c_str(), sizeof(stationId));
  strlcpy(bayId, prefs.getString("bay", DEFAULT_BAY_ID).c_str(), sizeof(bayId));
  strlcpy(qrBase, prefs.getString("qrBase", DEFAULT_QR_BASE).c_str(), sizeof(qrBase));
  strlcpy(recentCmds[0], prefs.getString("lastCmd", "").c_str(), sizeof(recentCmds[0]));
  recentIdx = recentCmds[0][0] ? 1 : 0;
}

static void saveSession() {
  prefs.putBool("sActive", sess.active);
  if (!sess.active) return;
  prefs.putString("sSid", sess.sessionId);
  prefs.putString("sCid", sess.commandId);
  prefs.putString("sProg", sess.program);
  prefs.putUChar("sRel", sess.relay);
  prefs.putUInt("sRem", remainingSec());
}

static void buildTopics() {
  snprintf(tCmd, sizeof(tCmd), "qwash/station/%s/bay/%s/cmd", stationId, bayId);
  snprintf(tAck, sizeof(tAck), "qwash/station/%s/bay/%s/ack", stationId, bayId);
  snprintf(tStatus, sizeof(tStatus), "qwash/station/%s/bay/%s/status", stationId, bayId);
  snprintf(tHeartbeat, sizeof(tHeartbeat), "qwash/station/%s/bay/%s/heartbeat", stationId, bayId);
  snprintf(tEvents, sizeof(tEvents), "qwash/station/%s/bay/%s/events", stationId, bayId);
}

// ---------- MQTT yayin ----------
// EventEnvelope (docs/IOT.md 4.B). payloadFill payload nesnesini doldurur.
// (Arduino IDE'nin prototip uretici'si template'lerde takildigi icin std::function kullanilir.)
static void publishEvent(const char* topic, bool retain, std::function<void(JsonObject)> payloadFill) {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  char id[40], ts[32];
  newUuid(id);
  isoNow(ts, sizeof(ts));
  doc["eventId"] = id;
  doc["deviceId"] = deviceId;
  doc["stationId"] = stationId;
  doc["bayId"] = bayId;
  if (timeSynced()) doc["timestamp"] = ts;  // Saat yoksa yanlis tarih yerine hic gonderme.
  JsonObject p = doc["payload"].to<JsonObject>();
  payloadFill(p);
  char buf[512];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topic, (const uint8_t*)buf, n, retain);
}

static void publishStatus(const char* status) {
  publishEvent(tStatus, true, [&](JsonObject p) {
    p["type"] = "DEVICE_STATUS";
    p["status"] = status;
    p["firmwareVersion"] = FW_VERSION;
  });
}

static void publishAck(const char* type, const char* commandId, const char* sessionId, const char* status,
                       const char* reason = nullptr) {
  publishEvent(tAck, false, [&](JsonObject p) {
    p["type"] = type;
    p["commandId"] = commandId;
    p["sessionId"] = sessionId;
    p["status"] = status;
    if (reason) p["reason"] = reason;
    if (sess.active) {
      p["activeProgram"] = sess.program;
      p["activeRelayIndex"] = sess.relay;
      p["relayState"] = "ON";
      p["remainingSec"] = remainingSec();
    } else {
      p["relayState"] = "OFF";
    }
  });
}

static void publishHeartbeat() {
  publishEvent(tHeartbeat, false, [&](JsonObject p) {
    p["type"] = "HEARTBEAT";
    p["rssi"] = WiFi.RSSI();
    p["uptimeSec"] = millis() / 1000;
    p["firmwareVersion"] = FW_VERSION;
    p["heapFree"] = ESP.getFreeHeap();
    p["sessionActive"] = sess.active;
  });
}

static void publishSimpleEvent(const char* type, const char* detail = nullptr) {
  publishEvent(tEvents, false, [&](JsonObject p) {
    p["type"] = type;
    if (detail) p["detail"] = detail;
    if (sess.active) {
      p["sessionId"] = sess.sessionId;
      p["remainingSec"] = remainingSec();
    }
  });
}

// ---------- Seans ----------
static void endSession(const char* reason) {
  if (!sess.active) return;
  relaysAllOff();  // Once fiziksel kapat, sonra bildir.
  uint32_t rem = remainingSec();
  char sid[40], cid[40];
  strlcpy(sid, sess.sessionId, sizeof(sid));
  strlcpy(cid, sess.commandId, sizeof(cid));
  sess.active = false;
  prefs.putBool("sActive", false);
  Serial.printf("[session] bitti: %s (kalan %us)\n", reason, rem);
  publishEvent(tEvents, false, [&](JsonObject p) {
    p["type"] = "SESSION_ENDED";
    p["sessionId"] = sid;
    p["commandId"] = cid;
    p["reason"] = reason;
    p["remainingSec"] = rem;
  });
  uiMode = UiMode::DONE;
  doneUntilMs = millis() + 5000;
  lastUiSec = 0xFFFFFFFF;
}

static void handleStart(JsonObject env, JsonObject pl, const char* commandId, const char* sessionId) {
  // Tekrar eden komut: role'ye dokunma, yalniz ACK'i yeniden gonder.
  if (seenCommand(commandId)) {
    bool same = sess.active && strcmp(sess.commandId, commandId) == 0;
    publishAck("STARTED_ACK", commandId, sessionId, same ? "SUCCESS" : "DUPLICATE");
    Serial.println("[cmd] tekrar eden START, role degismedi");
    return;
  }
  const char* exp = env["expiresAt"] | "";
  if (exp[0] && timeSynced()) {
    time_t e = parseIso(exp);
    if (e && time(nullptr) > e) {
      publishAck("STARTED_ACK", commandId, sessionId, "REJECTED", "EXPIRED");
      return;
    }
  }
  int relay = pl["relayIndex"] | 0;
  uint32_t dur = pl["durationSec"] | 0;
  if (relay < 1 || relay > 4) {
    publishAck("STARTED_ACK", commandId, sessionId, "REJECTED", "INVALID_RELAY");
    return;
  }
  if (dur == 0 || dur > MAX_SESSION_SEC) {
    publishAck("STARTED_ACK", commandId, sessionId, "REJECTED", "INVALID_DURATION");
    return;
  }
  if (sess.active) {
    publishAck("STARTED_ACK", commandId, sessionId, "REJECTED", "BUSY");
    return;
  }
  rememberCommand(commandId);
  sess.active = true;
  strlcpy(sess.sessionId, sessionId, sizeof(sess.sessionId));
  strlcpy(sess.commandId, commandId, sizeof(sess.commandId));
  strlcpy(sess.program, pl["program"] | "", sizeof(sess.program));
  sess.relay = relay;
  sess.durationSec = dur;
  sess.endMs = millis() + dur * 1000UL;
  saveSession();  // Role cekilmeden once kalici yaz (guc kesilirse kurtarilabilsin).
  relaySet(sess.relay, true);
  lastNvsSave = millis();
  uiMode = UiMode::RUNNING;
  lastUiSec = 0xFFFFFFFF;
  publishAck("STARTED_ACK", commandId, sessionId, "SUCCESS");
}

static void handleStop(JsonObject pl, const char* commandId, const char* sessionId) {
  if (seenCommand(commandId)) {
    publishAck("STOPPED_ACK", commandId, sessionId, "DUPLICATE");
    return;
  }
  rememberCommand(commandId);
  uint32_t rem = remainingSec();
  bool was = sess.active;
  if (was) endSession(pl["reason"] | "USER_STOP");
  publishEvent(tAck, false, [&](JsonObject p) {
    p["type"] = "STOPPED_ACK";
    p["commandId"] = commandId;
    p["sessionId"] = sessionId;
    p["status"] = was ? "SUCCESS" : "NOT_ACTIVE";
    p["remainingSec"] = rem;
    p["relayState"] = "OFF";
  });
}

static void onMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    Serial.println("[cmd] gecersiz JSON");
    return;
  }
  JsonObject env = doc.as<JsonObject>();
  JsonObject pl = env["payload"];
  const char* commandId = env["commandId"] | "";
  const char* sessionId = env["sessionId"] | "";
  const char* type = pl["type"] | "";
  if (!commandId[0]) {
    Serial.println("[cmd] commandId yok, yok sayildi");
    return;
  }
  Serial.printf("[cmd] %s (commandId=%s)\n", type, commandId);
  if (!strcmp(type, "START")) handleStart(env, pl, commandId, sessionId);
  else if (!strcmp(type, "STOP")) handleStop(pl, commandId, sessionId);
  else if (!strcmp(type, "RESET")) {
    relaysAllOff();
    delay(200);
    ESP.restart();
  }
}

// ---------- Wi-Fi / MQTT ----------
static void onSaveParams() { paramsChanged = true; }

static WiFiManagerParameter pHost("host", "MQTT sunucu (IP)", DEFAULT_MQTT_HOST, 63);
static WiFiManagerParameter pPort("port", "MQTT port", DEFAULT_MQTT_PORT, 7);
static WiFiManagerParameter pStation("station", "Istasyon ID", DEFAULT_STATION_ID, 31);
static WiFiManagerParameter pBay("bay", "Peron ID", DEFAULT_BAY_ID, 31);
static WiFiManagerParameter pQr("qr", "QR taban adresi", DEFAULT_QR_BASE, 95);

static void applyPortalParams() {
  prefs.putString("mqttHost", pHost.getValue());
  prefs.putString("mqttPort", pPort.getValue());
  prefs.putString("station", pStation.getValue());
  prefs.putString("bay", pBay.getValue());
  prefs.putString("qrBase", pQr.getValue());
  Serial.println("[portal] ayarlar kaydedildi, yeniden baslatiliyor");
  if (!sess.active) {  // Seans sirasinda yeniden baslatma; seans bitince baslar.
    delay(300);
    ESP.restart();
  }
}

static void mqttTryConnect() {
  if (!WiFi.isConnected()) return;
  if (millis() - lastMqttTry < MQTT_RETRY_MS) return;
  lastMqttTry = millis();
  mqtt.setServer(mqttHost, atoi(mqttPortStr));
  char clientId[32];
  snprintf(clientId, sizeof(clientId), "qwash-%s", deviceId);
  // LWT: beklenmedik kopmada broker OFFLINE (retained) yayinlar.
  static char lwt[192];
  snprintf(lwt, sizeof(lwt),
           "{\"deviceId\":\"%s\",\"stationId\":\"%s\",\"bayId\":\"%s\",\"payload\":{\"type\":\"DEVICE_STATUS\",\"status\":\"OFFLINE\"}}",
           deviceId, stationId, bayId);
  if (mqtt.connect(clientId, nullptr, nullptr, tStatus, 1, true, lwt)) {
    Serial.printf("[mqtt] baglandi %s:%s\n", mqttHost, mqttPortStr);
    mqtt.subscribe(tCmd, 1);
    publishStatus(sess.active ? "BUSY" : "ONLINE");
    if (recoveredPending) {
      publishSimpleEvent("SESSION_RECOVERED", "POWER_LOSS_OR_RESET");
      recoveredPending = false;
    }
  } else {
    Serial.printf("[mqtt] baglanamadi rc=%d\n", mqtt.state());
  }
}

// ---------- Ekran guncelleme ----------
static void updateUi() {
  bool w = WiFi.isConnected(), m = mqtt.connected();
  if (uiMode == UiMode::DONE && (int32_t)(millis() - doneUntilMs) >= 0) {
    uiMode = UiMode::IDLE;
    lastUiSec = 0xFFFFFFFF;
  }
  if (uiMode == UiMode::BOOT) uiMode = UiMode::IDLE;
  if (uiMode == UiMode::RUNNING) {
    uint32_t r = remainingSec();
    if (r != lastUiSec) {
      lastUiSec = r;
      uiRunning(r, "CALISIYOR", TFT_GREEN);
    }
  } else if (uiMode == UiMode::DONE) {
    if (lastUiSec != 0) {
      lastUiSec = 0;
      uiRunning(0, "BITTI", TFT_CYAN);
    }
  } else if (uiMode == UiMode::IDLE) {
    if (lastUiSec != 1 || w != lastWifi || m != lastMqtt) {
      lastUiSec = 1;
      lastWifi = w;
      lastMqtt = m;
      char url[160];
      snprintf(url, sizeof(url), "%s%s", qrBase, bayId);
      uiIdle(url, bayId, w, m);
    }
  }
}

// ---------- setup / loop ----------
static void startWatchdog() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_deinit();
  esp_task_wdt_config_t cfg = {.timeout_ms = WDT_TIMEOUT_SEC * 1000, .idle_core_mask = 0, .trigger_panic = true};
  esp_task_wdt_init(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif
  esp_task_wdt_add(NULL);
}

void setup() {
  relaysAllOff();  // Her seyden once.
  Serial.begin(115200);
  delay(100);
  setenv("TZ", "UTC0", 1);
  tzset();

  // WiFi.macAddress() Wi-Fi baslamadan 00:00:.. dondurur; eFuse'daki STA MAC'i dogrudan oku.
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(deviceId, sizeof(deviceId), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.printf("\nQWASH bay %s fw %s reset=%d\n", deviceId, FW_VERSION, (int)esp_reset_reason());

  prefs.begin("qwash", false);
  loadSettings();
  buildTopics();
  uiBegin();
  uiMessage("QWASH", TFT_WHITE);

  // NVS seans kurtarma: role hemen tekrar cekilir, kalan sureyle devam.
  if (prefs.getBool("sActive", false)) {
    uint32_t rem = prefs.getUInt("sRem", 0);
    uint8_t rel = prefs.getUChar("sRel", 0);
    if (rem > 0 && rem <= MAX_SESSION_SEC && rel >= 1 && rel <= 4) {
      sess.active = true;
      strlcpy(sess.sessionId, prefs.getString("sSid", "").c_str(), sizeof(sess.sessionId));
      strlcpy(sess.commandId, prefs.getString("sCid", "").c_str(), sizeof(sess.commandId));
      strlcpy(sess.program, prefs.getString("sProg", "").c_str(), sizeof(sess.program));
      sess.relay = rel;
      sess.durationSec = rem;
      sess.endMs = millis() + rem * 1000UL;
      relaySet(rel, true);
      recoveredPending = true;
      uiMode = UiMode::RUNNING;
      Serial.printf("[session] kurtarildi, kalan %us\n", rem);
    } else {
      prefs.putBool("sActive", false);
    }
  }

  mqtt.setBufferSize(1024);
  mqtt.setCallback(onMessage);

  // Bloklamayan portal: seans sirasinda Wi-Fi yoksa bile loop() (sayac, WDT) calismaya devam eder.
  char apName[32];
  snprintf(apName, sizeof(apName), "QWASH-AP-%s", deviceId);
  WiFi.mode(WIFI_STA);
  wm.setConfigPortalBlocking(false);
  wm.setConnectTimeout(20);
  wm.setSaveParamsCallback(onSaveParams);
  pHost.setValue(mqttHost, 63);
  pPort.setValue(mqttPortStr, 7);
  pStation.setValue(stationId, 31);
  pBay.setValue(bayId, 31);
  pQr.setValue(qrBase, 95);
  wm.addParameter(&pHost);
  wm.addParameter(&pPort);
  wm.addParameter(&pStation);
  wm.addParameter(&pBay);
  wm.addParameter(&pQr);
  bool ok = wm.autoConnect(apName);  // Baglanamazsa AP acik kalir; wm.process() loop'ta.
  if (ok) configTime(0, 0, "pool.ntp.org", "time.google.com");

  startWatchdog();
}

void loop() {
  esp_task_wdt_reset();
  wm.process();
  static bool ntpStarted = false;
  if (WiFi.isConnected() && !ntpStarted) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    ntpStarted = true;
  }
  // Kendi yeniden baglanma dongumuz: core'un auto-reconnect'i AP tamamen kaybolunca
  // (NO_AP_FOUND) vazgeciyor; modem yeniden baslayinca peron kalici cevrimdisi kaliyordu.
  static uint32_t wifiLostAt = 0, lastWifiRetry = 0;
  if (WiFi.isConnected()) {
    wifiLostAt = 0;
  } else if (!wm.getConfigPortalActive()) {
    if (!wifiLostAt) wifiLostAt = millis();
    if (millis() - wifiLostAt >= WIFI_RETRY_MS && millis() - lastWifiRetry >= WIFI_RETRY_MS) {
      lastWifiRetry = millis();
      Serial.println("[wifi] yeniden baglaniliyor");
      WiFi.disconnect(false);
      WiFi.begin();  // NVS'teki kayitli SSID/sifre ile
    }
  }
  static bool ntpLogged = false;
  if (!ntpLogged && timeSynced()) {
    ntpLogged = true;
    Serial.println("[ntp] saat senkronlandi");
  }
  if (paramsChanged) {
    paramsChanged = false;
    applyPortalParams();
  }

  if (!mqtt.connected()) mqttTryConnect();
  else mqtt.loop();

  // Otonom sayac: ag durumundan bagimsiz.
  if (sess.active) {
    if ((int32_t)(millis() - sess.endMs) >= 0) {
      endSession("COMPLETED");
    } else if (millis() - lastNvsSave >= NVS_SAVE_EVERY_MS) {
      lastNvsSave = millis();
      prefs.putUInt("sRem", remainingSec());
    }
  }

  if (mqtt.connected() && millis() - lastHeartbeat >= HEARTBEAT_EVERY_MS) {
    lastHeartbeat = millis();
    publishHeartbeat();
  }

  updateUi();
}
