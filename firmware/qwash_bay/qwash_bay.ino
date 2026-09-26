// QWASH peron firmware'i (Faz 3 SPIKE) - Arduino IDE.
// Kontrat: docs/IOT.md. Kurulum ve test: firmware/README.md
//
// Uzaktan (0.7.0, ADR-0013): SET_CONFIG ile QR adresi degisir; OTA ile imzali imaj indirilir,
// sha256 + ECDSA imzasi (gomulu acik anahtar) dogrulanmadan yazilmaz. Yeni surum 3 acilista
// saglikli olamazsa (MQTT'ye baglanip 60 sn calisamazsa) cihaz eski surume doner.
//
// Dokunmatik menu (0.6.0): musteri QR'i okutup telefonda onaylayinca backend SHOW_MENU gonderir,
// ekran o hesaba bagli paket/sure menusune gecer. Cihaz yalniz secimi bildirir (MENU_START);
// tutar, bakiye ve seans karari backend'dedir. DURDUR roleyi cihazda hemen kapatir; tahsilat
// bildirilen kalan sureden yapilir (SESSION_ENDED). Seans bitince 30 sn "tekrar sec", sonra QR.
//
// Fail-safe ilkeleri:
//  - Acilista once tum roleler kapatilir.
//  - Sure ESP32'nin kendi millis() sayacindan gelir; Wi-Fi/MQTT kopsa da sure dolunca roleler kapanir.
//  - Kalan sure NVS'e yazilir; guc kesilip gelirse kalan sureyle devam edilir.
//  - Ayni commandId ikinci kez gelirse role tekrar cekilmez.
//  - WDT 15 sn; loop() takilirsa cihaz yeniden baslar.

#include <WiFi.h>
#include <WiFiClientSecure.h>
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
#include <HTTPClient.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <mbedtls/base64.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>
#include "config.h"
#if __has_include("ota_pubkey.h")
#include "ota_pubkey.h"  // pnpm firmware:keys
#else
#error "ota_pubkey.h yok: depo kokunde pnpm firmware:keys calistir"
#endif
#if __has_include("mqtt_ca.h")
#include "mqtt_ca.h"  // pnpm mqtt:certs
#else
#error "mqtt_ca.h yok: depo kokunde pnpm mqtt:certs calistir"
#endif
#include "display.h"

// ---------- Kimlik ve ayarlar ----------
static char deviceId[13];  // MAC, ayiracsiz buyuk harf (docs/IOT.md)
static char mqttHost[64] = DEFAULT_MQTT_HOST;
static char mqttPortStr[8] = DEFAULT_MQTT_PORT;
static char mqttPass[65] = "";  // Kullanici adi deviceId; sifre portaldan girilir (docker/mosquitto/acl).
static char stationId[32] = DEFAULT_STATION_ID;
static char bayId[32] = DEFAULT_BAY_ID;
static char qrBase[96] = DEFAULT_QR_BASE;

static Preferences prefs;
static WiFiManager wm;
// Broker sertifikasi MQTT_CA_CERT ile dogrulanir; CA'sini bilmedigimiz sunucuya baglanilmaz.
static WiFiClientSecure net;
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
// Yeniden baslamada NVS'ten kurtarilan seans: bildirim cevrimdisiyken seans bitse bile
// kurtarma aninin kalan suresi kanit olarak gonderilir.
static char recoveredSid[40] = "";
static uint32_t recoveredRem = 0;
static bool paramsChanged = false;
static UiMode uiMode = UiMode::BOOT;
static uint32_t lastUiSec = 0xFFFFFFFF;
static bool lastWifi = false, lastMqtt = false;
static uint32_t doneUntilMs = 0;
static bool uiDirty = true;  // Ekran tamamen yeniden cizilmeli

// ---------- Dokunmatik menu durumu ----------
struct MenuProgram {
  char code[17];
  char label[20];
  uint32_t pricePerSec;  // kurus/sn
};
struct Menu {
  bool active = false;  // Ekran bir musterinin hesabina bagli (claim)
  char claimId[40] = "";
  char holder[28] = "";  // Maskeli hesap etiketi
  long long availableKurus = 0;
  MenuProgram programs[MENU_MAX_PROGRAMS];
  uint8_t programCount = 0;
  uint32_t durations[MENU_MAX_DURATIONS] = {};
  uint8_t durationCount = 0;
  uint32_t deadlineMs = 0;
  bool afterSession = false;
  int8_t selected = -1;  // Sure ekranindaki paket
};
static Menu menu;
static char menuMsg[32] = "";
static uint32_t menuMsgUntil = 0;
static uint32_t waitingSinceMs = 0;
// Ayni secim tekrar denenirse ayni anahtar gider: ilk mesaj ulastiysa backend ikinci seans acmaz.
static char pendingReq[40] = "";
static int8_t pendingProg = -1;
static uint32_t pendingDur = 0;
static bool stopSent = false;

// ---------- Uzaktan guncelleme durumu ----------
static bool otaPending = false;  // Yeni surumle acildik, henuz saglikli sayilmadi
static char otaId[40] = "";

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
  strlcpy(mqttPortStr, prefs.getString("mqttTlsPort", DEFAULT_MQTT_PORT).c_str(), sizeof(mqttPortStr));
  strlcpy(mqttPass, prefs.getString("mqttPass", DEFAULT_MQTT_PASS).c_str(), sizeof(mqttPass));
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
    p["qrBase"] = qrBase;  // Backend istenenden farkliysa SET_CONFIG gonderir
    p["resetReason"] = (int)esp_reset_reason();  // 1 guc, 3 yazilim, 4 panic, 5-7 WDT, 9 brownout
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
    // Seans surerken kalan sure backend'e "kanitlanmis kullanim" olarak gider: cihaz
    // kaybolursa yalnizca buna kadarki sure tahsil edilir (ADR-0010 #8).
    if (sess.active) {
      p["sessionId"] = sess.sessionId;
      p["remainingSec"] = remainingSec();
      p["relayIndex"] = sess.relay;  // Device twin: backend istenen roleyle karsilastirir.
    }
  });
}

// Son biten seans NVS'te tutulur ve her MQTT baglantisinda yeniden gonderilir.
// PubSubClient QoS 0 yayinlar ve cihaz cevrimdisiyken biten seansin bildirimi
// kaybolur; tekrar gondermek zararsizdir (backend ayni seansi ikinci kez kapatmaz).
struct LastEnd {
  char sessionId[40] = "";
  char commandId[40] = "";
  char reason[16] = "";
  uint32_t remainingSec = 0;
};
static LastEnd lastEnd;

static void loadLastEnd() {
  strlcpy(lastEnd.sessionId, prefs.getString("eSid", "").c_str(), sizeof(lastEnd.sessionId));
  strlcpy(lastEnd.commandId, prefs.getString("eCid", "").c_str(), sizeof(lastEnd.commandId));
  strlcpy(lastEnd.reason, prefs.getString("eRsn", "").c_str(), sizeof(lastEnd.reason));
  lastEnd.remainingSec = prefs.getUInt("eRem", 0);
}

static void publishLastEnd() {
  if (!lastEnd.sessionId[0]) return;
  publishEvent(tEvents, false, [&](JsonObject p) {
    p["type"] = "SESSION_ENDED";
    p["sessionId"] = lastEnd.sessionId;
    p["commandId"] = lastEnd.commandId;
    p["reason"] = lastEnd.reason;
    p["remainingSec"] = lastEnd.remainingSec;
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

// ---------- Dokunmatik menu ----------
static void setMode(UiMode m) {
  uiMode = m;
  uiDirty = true;
  lastUiSec = 0xFFFFFFFF;
}

static uint32_t menuLeftSec() {
  int32_t left = (int32_t)(menu.deadlineMs - millis());
  return left > 0 ? (uint32_t)((left + 999) / 1000) : 0;
}

static void menuMessage(const char* msg) {
  strlcpy(menuMsg, msg, sizeof(menuMsg));
  menuMsgUntil = millis() + MENU_MESSAGE_MS;
  uiDirty = true;
}

// Bag bitti: ekran QR'a doner (seans suruyorsa seans ekrani kalir).
static void menuClose() {
  menu.active = false;
  menu.claimId[0] = 0;
  pendingReq[0] = 0;
  if (!sess.active) setMode(UiMode::IDLE);
}

static void handleShowMenu(JsonObject pl) {
  const char* claimId = pl["claimId"] | "";
  if (!claimId[0]) return;
  bool sameClaim = menu.active && strcmp(menu.claimId, claimId) == 0;
  menu.active = true;
  strlcpy(menu.claimId, claimId, sizeof(menu.claimId));
  strlcpy(menu.holder, pl["holder"] | "", sizeof(menu.holder));
  menu.availableKurus = pl["availableKurus"].as<long long>();
  menu.afterSession = pl["afterSession"] | false;
  uint32_t timeoutSec = pl["timeoutSec"] | 60;
  menu.deadlineMs = millis() + timeoutSec * 1000UL;
  menu.programCount = 0;
  for (JsonObject p : pl["programs"].as<JsonArray>()) {
    if (menu.programCount >= MENU_MAX_PROGRAMS) break;
    MenuProgram& mp = menu.programs[menu.programCount++];
    strlcpy(mp.code, p["code"] | "", sizeof(mp.code));
    strlcpy(mp.label, p["label"] | "", sizeof(mp.label));
    mp.pricePerSec = p["pricePerSecondKurus"] | 0;
  }
  menu.durationCount = 0;
  for (JsonVariant d : pl["durationsSec"].as<JsonArray>()) {
    if (menu.durationCount >= MENU_MAX_DURATIONS) break;
    uint32_t v = d.as<uint32_t>();
    if (v > 0 && v <= MAX_SESSION_SEC) menu.durations[menu.durationCount++] = v;
  }
  if (!sameClaim) {
    menu.selected = -1;
    pendingReq[0] = 0;
  }
  Serial.printf("[menu] %s: %u paket, %us\n", menu.afterSession ? "tekrar sec" : "acildi", menu.programCount,
                (unsigned)timeoutSec);
  if (sess.active) return;  // Seans bitince acilir (endSession).
  // Ayni musteri sure ekranindaysa orada kal (bakiye tazelendi).
  if (sameClaim && uiMode == UiMode::MENU_DURATIONS && menu.selected >= 0 && menu.selected < menu.programCount) {
    uiDirty = true;
    return;
  }
  setMode(UiMode::MENU_PROGRAMS);
}

static void handleShowQr(JsonObject pl) {
  const char* claimId = pl["claimId"] | "";
  if (claimId[0] && strcmp(claimId, menu.claimId) != 0) return;  // Eski bir bagin komutu
  Serial.println("[menu] bag kapandi, QR");
  menuClose();
}

static void handleMenuError(JsonObject pl) {
  const char* claimId = pl["claimId"] | "";
  if (!menu.active || strcmp(claimId, menu.claimId) != 0) return;
  menu.deadlineMs = millis() + AFTER_SESSION_MENU_SEC * 1000UL;  // Backend de bagi uzatti
  pendingReq[0] = 0;
  menuMessage(pl["message"] | "BASLATILAMADI");
  if (uiMode == UiMode::MENU_WAITING) setMode(menu.selected >= 0 ? UiMode::MENU_DURATIONS : UiMode::MENU_PROGRAMS);
}

static void menuStart(uint8_t durIdx) {
  if (menu.selected < 0 || durIdx >= menu.durationCount) return;
  if (!mqtt.connected()) {
    menuMessage("SUNUCU YOK");
    return;
  }
  uint32_t dur = menu.durations[durIdx];
  if (!pendingReq[0] || pendingProg != menu.selected || pendingDur != dur) {
    newUuid(pendingReq);
    pendingProg = menu.selected;
    pendingDur = dur;
  }
  const MenuProgram& p = menu.programs[menu.selected];
  publishEvent(tEvents, false, [&](JsonObject o) {
    o["type"] = "MENU_START";
    o["claimId"] = menu.claimId;
    o["programCode"] = p.code;
    o["durationSec"] = dur;
    o["requestId"] = pendingReq;
  });
  Serial.printf("[menu] secildi %s %us\n", p.code, (unsigned)dur);
  waitingSinceMs = millis();
  setMode(UiMode::MENU_WAITING);
}

static void drawMenu() {
  gfx.fillScreen(TFT_BLACK);
  char bal[20], sub[64];
  fmtTl(bal, sizeof(bal), menu.availableKurus);
  snprintf(sub, sizeof(sub), "%s  BAKIYE %s", menu.holder, bal);
  if (uiMode == UiMode::MENU_PROGRAMS) {
    uiHeader(menu.afterSession ? "TEKRAR SECEBILIRSINIZ" : "PAKET SECIN", sub);
    for (uint8_t i = 0; i < menu.programCount; i++) {
      const MenuProgram& p = menu.programs[i];
      char price[20], line2[28];
      fmtTl(price, sizeof(price), (long long)p.pricePerSec * 60);
      snprintf(line2, sizeof(line2), "%s / DK", price);
      uiButton(programBtn(i), p.label, line2, TFT_NAVY, TFT_WHITE);
    }
    uiButton(BTN_EXIT, "CIKIS", nullptr, TFT_DARKGREY, TFT_WHITE);
  } else if (uiMode == UiMode::MENU_DURATIONS && menu.selected >= 0) {
    const MenuProgram& p = menu.programs[menu.selected];
    uiHeader(p.label, sub);
    for (uint8_t i = 0; i < menu.durationCount; i++) {
      uint32_t d = menu.durations[i];
      long long cost = (long long)p.pricePerSec * d;
      bool ok = cost <= menu.availableKurus;
      char amount[20], row[48];
      fmtTl(amount, sizeof(amount), cost);
      if (d % 60 == 0) snprintf(row, sizeof(row), "%u DK   %s", (unsigned)(d / 60), amount);
      else snprintf(row, sizeof(row), "%u SN   %s", (unsigned)d, amount);
      uiButton(durationBtn(i), row, ok ? nullptr : "BAKIYE YETERSIZ", ok ? TFT_DARKGREEN : TFT_DARKGREY, TFT_WHITE);
    }
    uiButton(BTN_BACK, "GERI", nullptr, TFT_DARKGREY, TFT_WHITE);
  } else {
    uiMessage("BASLATILIYOR", TFT_YELLOW);
  }
  if (menuMsg[0]) uiFooterMessage(menuMsg, TFT_ORANGE);
}

// ---------- Uzaktan ayar ve guncelleme (ADR-0013) ----------
static void publishOta(const char* updateId, const char* status, const char* detail = nullptr) {
  publishEvent(tEvents, false, [&](JsonObject p) {
    p["type"] = "OTA_STATUS";
    p["updateId"] = updateId;
    p["status"] = status;
    if (detail) p["detail"] = detail;
  });
}

static void handleSetConfig(JsonObject pl) {
  const char* q = pl["qrBase"] | "";
  size_t n = strlen(q);
  bool ok = n > 8 && n < sizeof(qrBase) && (!strncmp(q, "http://", 7) || !strncmp(q, "https://", 8)) && q[n - 1] == '/';
  if (!ok) {
    Serial.println("[config] gecersiz qrBase, yok sayildi");
    return;
  }
  if (strcmp(q, qrBase) != 0) {
    strlcpy(qrBase, q, sizeof(qrBase));
    prefs.putString("qrBase", qrBase);
    Serial.printf("[config] QR adresi: %s\n", qrBase);
    if (uiMode == UiMode::IDLE) uiDirty = true;
  }
  publishStatus(sess.active ? "BUSY" : "ONLINE");  // Backend yeni adresi gorsun
}

// Imza: ECDSA P-256, imajin SHA-256'si uzerinde, DER + base64 (scripts/firmware-sign.mjs).
static bool verifySignature(const uint8_t hash[32], const char* sigB64) {
  uint8_t sig[96];
  size_t sigLen = 0;
  if (mbedtls_base64_decode(sig, sizeof(sig), &sigLen, (const uint8_t*)sigB64, strlen(sigB64)) != 0) return false;
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  int rc = mbedtls_pk_parse_public_key(&pk, (const uint8_t*)OTA_PUBLIC_KEY_PEM, strlen(OTA_PUBLIC_KEY_PEM) + 1);
  if (rc == 0) rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, 32, sig, sigLen);
  mbedtls_pk_free(&pk);
  return rc == 0;
}

static void uiOtaProgress(uint32_t got, uint32_t size) {
  char buf[24];
  snprintf(buf, sizeof(buf), "%u%%", (unsigned)(size ? got * 100ULL / size : 0));
  gfx.fillRect(0, 150, gfx.width(), 40, TFT_BLACK);
  uiCenterText(buf, 155, 3, TFT_WHITE);
}

// Imaji indirir, yazarken SHA-256 hesaplar; sha256 ve imza tutmazsa hic acilmaz (Update.abort).
static bool downloadAndFlash(const char* url, uint32_t size, const char* shaHex, const char* sigB64, char* err,
                             size_t errN) {
  WiFiClient plain;
  WiFiClientSecure tls;
  bool https = !strncmp(url, "https://", 8);
  // Butunluk ve kaynak imzayla dogrulanir; TLS yalniz tasima (sertifika paketi sonraki is, ADR-0013).
  if (https) tls.setInsecure();
  WiFiClient* client = https ? (WiFiClient*)&tls : &plain;
  HTTPClient http;
  http.setTimeout(OTA_STALL_MS);
  if (!http.begin(*client, url)) {
    strlcpy(err, "HTTP_BEGIN", errN);
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    snprintf(err, errN, "HTTP_%d", code);
    http.end();
    return false;
  }
  if (http.getSize() != (int)size) {
    strlcpy(err, "SIZE_MISMATCH", errN);
    http.end();
    return false;
  }
  if (!Update.begin(size, U_FLASH)) {
    strlcpy(err, "UPDATE_BEGIN", errN);
    http.end();
    return false;
  }
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  WiFiClient* stream = http.getStreamPtr();
  static uint8_t buf[4096];
  uint32_t got = 0, lastData = millis();
  int lastTenth = -1;
  bool writeFailed = false;
  while (got < size) {
    esp_task_wdt_reset();
    size_t avail = stream->available();
    if (!avail) {
      if (millis() - lastData > OTA_STALL_MS) break;
      delay(2);
      continue;
    }
    size_t want = avail;
    if (want > sizeof(buf)) want = sizeof(buf);
    if (want > size - got) want = size - got;
    int n = stream->readBytes(buf, want);
    if (n <= 0) continue;
    lastData = millis();
    mbedtls_sha256_update(&ctx, buf, n);
    if (Update.write(buf, n) != (size_t)n) {
      writeFailed = true;
      break;
    }
    got += n;
    int tenth = (int)(got * 10ULL / size);
    if (tenth != lastTenth) {
      lastTenth = tenth;
      uiOtaProgress(got, size);
    }
  }
  http.end();
  uint8_t hash[32];
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);
  if (writeFailed || got != size) {
    Update.abort();
    strlcpy(err, writeFailed ? "WRITE" : "INCOMPLETE", errN);
    return false;
  }
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", hash[i]);
  if (strcasecmp(hex, shaHex) != 0) {
    Update.abort();
    strlcpy(err, "SHA256", errN);
    return false;
  }
  if (!verifySignature(hash, sigB64)) {
    Update.abort();
    strlcpy(err, "SIGNATURE", errN);
    return false;
  }
  if (!Update.end()) {  // Imaj basligini dogrular ve acilis bolumunu yeni imaja cevirir
    snprintf(err, errN, "UPDATE_END_%u", (unsigned)Update.getError());
    return false;
  }
  return true;
}

static void handleOta(JsonObject pl) {
  // Komut metinleri once kopyalanir: yayinlar PubSubClient'in ortak tamponunu kullanir.
  char updateId[40], version[33], url[200], shaHex[65], sig[128];
  strlcpy(updateId, pl["updateId"] | "", sizeof(updateId));
  strlcpy(version, pl["version"] | "", sizeof(version));
  strlcpy(url, pl["url"] | "", sizeof(url));
  strlcpy(shaHex, pl["sha256"] | "", sizeof(shaHex));
  strlcpy(sig, pl["signature"] | "", sizeof(sig));
  uint32_t size = pl["sizeBytes"] | 0;
  if (!updateId[0]) return;
  if (!strcmp(version, FW_VERSION)) return;  // Tekrar gelen komut; zaten bu surumdeyiz
  if (!url[0] || strlen(shaHex) != 64 || !sig[0] || size == 0) {
    publishOta(updateId, "FAILED", "INVALID_COMMAND");
    return;
  }
  // Su akarken veya musteri ekranda secim yaparken guncelleme yok.
  if (sess.active || menu.active) {
    publishOta(updateId, "FAILED", "BUSY");
    return;
  }
  const esp_partition_t* target = esp_ota_get_next_update_partition(NULL);
  if (!target || size > target->size) {
    publishOta(updateId, "FAILED", "TOO_LARGE");
    return;
  }
  Serial.printf("[ota] %s -> %s indiriliyor (%u bayt)\n", FW_VERSION, version, (unsigned)size);
  publishOta(updateId, "DOWNLOADING");
  publishStatus("UPDATING");  // Peron guncelleme bitene kadar kullanilamaz
  uiMessage("GUNCELLENIYOR", TFT_YELLOW);
  char err[32] = "";
  if (!downloadAndFlash(url, size, shaHex, sig, err, sizeof(err))) {
    Serial.printf("[ota] basarisiz: %s\n", err);
    publishOta(updateId, "FAILED", err);
    publishStatus("ONLINE");
    setMode(UiMode::IDLE);
    return;
  }
  // Yeni surum saglikli oldugunu kanitlayana kadar "deneme" sayilir (bkz. setup).
  prefs.putString("otaId", updateId);
  prefs.putUChar("otaTries", 0);
  prefs.putBool("otaPend", true);
  Serial.println("[ota] dogrulandi, yeniden baslatiliyor");
  publishOta(updateId, "REBOOTING");
  uiMessage("YENIDEN BASLIYOR", TFT_GREEN);
  mqtt.loop();
  delay(500);
  relaysAllOff();
  ESP.restart();
}

// Yeni surum MQTT'ye baglanip bir sure calistiysa saglikli: deneme isaretini kaldir, bildir.
static void otaHealthCheck() {
  if (!otaPending || !mqtt.connected() || millis() < OTA_HEALTHY_AFTER_MS) return;
  otaPending = false;
  prefs.putBool("otaPend", false);
  Serial.printf("[ota] %s saglikli\n", FW_VERSION);
  publishOta(otaId, "SUCCEEDED");
}

// ---------- Seans ----------
static void endSession(const char* reason) {
  if (!sess.active) return;
  relaysAllOff();  // Once fiziksel kapat, sonra bildir.
  uint32_t rem = remainingSec();
  // Once bitis kaydini kalici yaz, sonra seansi kapat: arada guc kesilirse ya seans
  // kurtarilir ya da bitis bildirimi bir sonraki baglantida gider.
  strlcpy(lastEnd.sessionId, sess.sessionId, sizeof(lastEnd.sessionId));
  strlcpy(lastEnd.commandId, sess.commandId, sizeof(lastEnd.commandId));
  strlcpy(lastEnd.reason, reason, sizeof(lastEnd.reason));
  lastEnd.remainingSec = rem;
  prefs.putString("eSid", lastEnd.sessionId);
  prefs.putString("eCid", lastEnd.commandId);
  prefs.putString("eRsn", lastEnd.reason);
  prefs.putUInt("eRem", rem);
  sess.active = false;
  prefs.putBool("sActive", false);
  Serial.printf("[session] bitti: %s (kalan %us)\n", reason, rem);
  publishLastEnd();
  publishStatus("ONLINE");  // Retained BUSY'yi temizle.
  stopSent = false;
  if (menu.active) {
    // Ekrana bagli musteri: 30 sn "tekrar sec". Backend guncel bakiyeyle yeni SHOW_MENU da gonderir.
    menu.afterSession = true;
    menu.deadlineMs = millis() + AFTER_SESSION_MENU_SEC * 1000UL;
    menu.selected = -1;
    pendingReq[0] = 0;
    setMode(UiMode::MENU_PROGRAMS);
  } else {
    setMode(UiMode::DONE);
    doneUntilMs = millis() + 5000;
  }
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
  stopSent = false;
  pendingReq[0] = 0;
  setMode(UiMode::RUNNING);
  publishAck("STARTED_ACK", commandId, sessionId, "SUCCESS");
  publishStatus("BUSY");
}

static void handleStop(JsonObject pl, const char* commandId, const char* sessionId) {
  if (seenCommand(commandId)) {
    publishAck("STOPPED_ACK", commandId, sessionId, "DUPLICATE");
    return;
  }
  rememberCommand(commandId);
  uint32_t rem = remainingSec();
  // STOP yalnizca kendi seansini durdurur. Backend zaman asiminda tedbiren STOP gonderir;
  // bu komut gec ulasirsa ayni perondaki yeni musterinin seansini kesmemeli.
  // sessionId bos ise (servis/admin) aktif seans ne olursa olsun durdurulur.
  bool matches = !sessionId[0] || strcmp(sess.sessionId, sessionId) == 0;
  bool was = sess.active && matches;
  if (was) endSession(pl["reason"] | "USER_STOP");
  publishEvent(tAck, false, [&](JsonObject p) {
    p["type"] = "STOPPED_ACK";
    p["commandId"] = commandId;
    p["sessionId"] = sessionId;
    p["status"] = was ? "SUCCESS" : "NOT_ACTIVE";
    p["remainingSec"] = was ? rem : 0;
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
  // Ekran komutlari rolelere dokunmaz; tekrar gelmeleri zararsizdir (commandId halkasina yazilmaz).
  else if (!strcmp(type, "SHOW_MENU")) handleShowMenu(pl);
  else if (!strcmp(type, "SHOW_QR")) handleShowQr(pl);
  else if (!strcmp(type, "MENU_ERROR")) handleMenuError(pl);
  else if (!strcmp(type, "SET_CONFIG")) handleSetConfig(pl);
  else if (!strcmp(type, "OTA")) handleOta(pl);
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
// Kayitli sifre portalda gosterilmez; bos birakilirsa mevcut sifre korunur.
static WiFiManagerParameter pPass("pass", "MQTT sifre (bos = degistirme)", "", 64, "type='password'");
static WiFiManagerParameter pStation("station", "Istasyon ID", DEFAULT_STATION_ID, 31);
static WiFiManagerParameter pBay("bay", "Peron ID", DEFAULT_BAY_ID, 31);
static WiFiManagerParameter pQr("qr", "QR taban adresi", DEFAULT_QR_BASE, 95);

static void applyPortalParams() {
  prefs.putString("mqttHost", pHost.getValue());
  prefs.putString("mqttTlsPort", pPort.getValue());
  if (strlen(pPass.getValue()) > 0) prefs.putString("mqttPass", pPass.getValue());
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
  // rc=4/5 donerse kullanici/sifre ya da yetki hatasi: sifreyi portaldan gir.
  if (mqtt.connect(clientId, deviceId, mqttPass, tStatus, 1, true, lwt)) {
    Serial.printf("[mqtt] baglandi %s:%s\n", mqttHost, mqttPortStr);
    mqtt.subscribe(tCmd, 1);
    publishStatus(sess.active ? "BUSY" : "ONLINE");
    publishLastEnd();  // Cevrimdisiyken biten seans varsa bildirimi simdi gider.
    if (prefs.getBool("otaRolled", false)) {  // Yeni surum acilamadi, eskiye donuldu
      publishOta(otaId, "FAILED", "ROLLED_BACK");
      prefs.putBool("otaRolled", false);
    }
    if (recoveredPending) {
      char detail[32];
      snprintf(detail, sizeof(detail), "RESET_REASON_%d", (int)esp_reset_reason());
      publishEvent(tEvents, false, [&](JsonObject p) {
        p["type"] = "SESSION_RECOVERED";
        p["detail"] = detail;
        p["sessionId"] = recoveredSid;
        p["remainingSec"] = recoveredRem;
      });
      recoveredPending = false;
    }
  } else {
    Serial.printf("[mqtt] baglanamadi rc=%d\n", mqtt.state());
  }
}

// ---------- Ekran guncelleme ----------
static void updateUi() {
  bool w = WiFi.isConnected(), m = mqtt.connected();
  if (uiMode == UiMode::BOOT) setMode(UiMode::IDLE);
  if (uiMode == UiMode::DONE && (int32_t)(millis() - doneUntilMs) >= 0) setMode(UiMode::IDLE);

  bool inMenu = uiMode == UiMode::MENU_PROGRAMS || uiMode == UiMode::MENU_DURATIONS || uiMode == UiMode::MENU_WAITING;
  if (inMenu && uiMode != UiMode::MENU_WAITING && menuLeftSec() == 0) {
    Serial.println("[menu] sure doldu, QR");
    menuClose();  // Backend de ayni anda bagi kapatir (tarama).
    inMenu = false;
  }
  if (uiMode == UiMode::MENU_WAITING && millis() - waitingSinceMs >= MENU_WAIT_TIMEOUT_MS) {
    menuMessage("CEVAP YOK, TEKRAR DENE");
    setMode(UiMode::MENU_DURATIONS);
  }
  if (menuMsg[0] && (int32_t)(millis() - menuMsgUntil) >= 0) {
    menuMsg[0] = 0;
    if (inMenu) uiDirty = true;
  }

  switch (uiMode) {
    case UiMode::RUNNING: {
      uint32_t r = remainingSec();
      if (uiDirty) {
        uiDirty = false;
        lastUiSec = r;
        uiRunning(r, "CALISIYOR", TFT_GREEN, true, stopSent);
      } else if (r != lastUiSec) {
        lastUiSec = r;
        uiRunningTime(r);
      }
      break;
    }
    case UiMode::DONE:
      if (uiDirty) {
        uiDirty = false;
        uiRunning(0, "BITTI", TFT_CYAN, false, false);
      }
      break;
    case UiMode::IDLE:
      if (uiDirty || w != lastWifi || m != lastMqtt) {
        uiDirty = false;
        lastWifi = w;
        lastMqtt = m;
        char url[160];
        snprintf(url, sizeof(url), "%s%s", qrBase, bayId);
        uiIdle(url, bayId, w, m);
      }
      break;
    case UiMode::MENU_PROGRAMS:
    case UiMode::MENU_DURATIONS:
    case UiMode::MENU_WAITING: {
      if (uiDirty) {
        uiDirty = false;
        drawMenu();
        lastUiSec = 0xFFFFFFFF;
      }
      uint32_t left = menuLeftSec();
      if (uiMode != UiMode::MENU_WAITING && left != lastUiSec) {
        lastUiSec = left;
        uiCountdown(left);
      }
      break;
    }
    default:
      break;
  }
}

// ---------- Dokunmatik ----------
static void onTap(int32_t x, int32_t y) {
  switch (uiMode) {
    case UiMode::MENU_PROGRAMS:
      for (uint8_t i = 0; i < menu.programCount; i++) {
        if (programBtn(i).hit(x, y)) {
          menu.selected = i;
          setMode(UiMode::MENU_DURATIONS);
          return;
        }
      }
      if (BTN_EXIT.hit(x, y)) {
        publishEvent(tEvents, false, [&](JsonObject o) {
          o["type"] = "MENU_EXIT";
          o["claimId"] = menu.claimId;
        });
        menuClose();
      }
      break;
    case UiMode::MENU_DURATIONS:
      for (uint8_t i = 0; i < menu.durationCount; i++) {
        if (durationBtn(i).hit(x, y)) {
          long long cost = (long long)menu.programs[menu.selected].pricePerSec * menu.durations[i];
          if (cost > menu.availableKurus) menuMessage("BAKIYE YETERSIZ");
          else menuStart(i);
          return;
        }
      }
      if (BTN_BACK.hit(x, y)) setMode(UiMode::MENU_PROGRAMS);
      break;
    case UiMode::RUNNING:
      // Roleyi burada hemen kapat: su aninda kesilir, ag yokken de calisir. Tahsilat, bildirilen
      // kalan sureden yapilir (SESSION_ENDED; cevrimdisiysa baglaninca gider).
      if (BTN_STOP.hit(x, y) && sess.active && !stopSent) {
        stopSent = true;
        Serial.println("[touch] DURDUR");
        endSession("SCREEN_STOP");
      }
      break;
    default:
      break;
  }
}

static void pollTouch() {
  static bool wasDown = false;
  static uint32_t lastTapMs = 0;
  int32_t x, y;
  bool down = gfx.getTouch(&x, &y) > 0;
  if (!down) {
    wasDown = false;
    return;
  }
  if (wasDown) return;  // Basili tutmak tek dokunus sayilir
  wasDown = true;
  if (millis() - lastTapMs < 300) return;  // Direncli ekranda ziplama
  lastTapMs = millis();
  Serial.printf("[touch] %ld,%ld\n", (long)x, (long)y);
  onTap(x, y);
}

// Acilista ekrana ~2 sn basili tutulursa kalibrasyon (4 kose). Seans kurtarildiysa yapilmaz:
// kalibrasyon ekrani loop()'u bekletir, role acikken sayac duramaz.
static void maybeCalibrateTouch() {
  int32_t x, y;
  if (!gfx.getTouch(&x, &y)) return;
  uint32_t t0 = millis();
  uiMessage("BASILI TUTUN", TFT_YELLOW);
  while (gfx.getTouch(&x, &y) && millis() - t0 < TOUCH_CALIBRATE_HOLD_MS) delay(20);
  if (millis() - t0 < TOUCH_CALIBRATE_HOLD_MS) return;
  uiMessage("BIRAKIN", TFT_WHITE);
  while (gfx.getTouch(&x, &y)) delay(20);
  delay(300);
  uint16_t cal[8];
  gfx.fillScreen(TFT_BLACK);
  uiCenterText("OKLARIN UCUNA DOKUNUN", 100, 1, TFT_WHITE);
  gfx.calibrateTouch(cal, TFT_WHITE, TFT_BLACK, 20);
  prefs.putBytes("tcal", cal, sizeof(cal));
  Serial.println("[touch] kalibrasyon kaydedildi");
  uiMessage("KALIBRE EDILDI", TFT_GREEN);
  delay(1000);
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

  // Yeni surumle acilis: saglikli oldugu kanitlanmadan OTA_MAX_BOOT_TRIES kez acildiysa
  // (cokme, WDT, MQTT'ye hic baglanamama) onceki bolume don.
  strlcpy(otaId, prefs.getString("otaId", "").c_str(), sizeof(otaId));
  if (prefs.getBool("otaPend", false)) {
    uint8_t tries = prefs.getUChar("otaTries", 0) + 1;
    prefs.putUChar("otaTries", tries);
    Serial.printf("[ota] yeni surum deneme %u/%u\n", tries, OTA_MAX_BOOT_TRIES);
    if (tries > OTA_MAX_BOOT_TRIES) {
      prefs.putBool("otaPend", false);
      prefs.putBool("otaRolled", true);
      const esp_partition_t* prev = esp_ota_get_next_update_partition(NULL);
      if (prev && esp_ota_set_boot_partition(prev) == ESP_OK) {
        Serial.println("[ota] eski surume donuluyor");
        delay(100);
        ESP.restart();
      }
    } else {
      otaPending = true;
    }
  }
  loadLastEnd();
  buildTopics();
  uiBegin();
  uiMessage("QWASH", TFT_WHITE);
  {
    uint16_t cal[8];
    if (prefs.getBytes("tcal", cal, sizeof(cal)) == sizeof(cal)) gfx.setTouchCalibrate(cal);
  }

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
      strlcpy(recoveredSid, sess.sessionId, sizeof(recoveredSid));
      recoveredRem = rem;
      uiMode = UiMode::RUNNING;
      Serial.printf("[session] kurtarildi, kalan %us\n", rem);
    } else {
      prefs.putBool("sActive", false);
    }
  }

  if (!sess.active) maybeCalibrateTouch();

  mqtt.setBufferSize(2048);  // SHOW_MENU (6 paket) 1 KB'i asabilir
  // Varsayilan 15 sn: broker TCP'yi kabul edip CONNACK vermezse (Docker'in port yonlendirmesi
  // boyle davranir) baglanma denemesi 15 sn'lik WDT'yi asip cihazi seans ortasinda resetliyordu.
  mqtt.setSocketTimeout(3);
  net.setCACert(MQTT_CA_CERT);
  // TCP (3 sn) + TLS el sikismasi (6 sn) toplami 15 sn WDT'nin altinda kalmali.
  net.setTimeout(3);
  net.setHandshakeTimeout(6);
  // Varsayilan 15 sn: broker 1,5x = 22,5 sn sessizlikte baglantiyi dusuruyordu. Zayif Wi-Fi'da
  // (RSSI -76) paket kaybi bunu asabiliyordu. 30 sn -> 45 sn tolerans; backend deviceStaleMs (90 sn) altinda.
  mqtt.setKeepAlive(30);
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
  wm.addParameter(&pPass);
  wm.addParameter(&pStation);
  wm.addParameter(&pBay);
  wm.addParameter(&pQr);
  bool ok = wm.autoConnect(apName, DEFAULT_AP_PASS);  // Baglanamazsa AP acik kalir; wm.process() loop'ta.
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

  uint32_t hbEvery = sess.active ? SESSION_HEARTBEAT_EVERY_MS : HEARTBEAT_EVERY_MS;
  if (mqtt.connected() && millis() - lastHeartbeat >= hbEvery) {
    lastHeartbeat = millis();
    publishHeartbeat();
  }

  otaHealthCheck();
  pollTouch();
  updateUi();
}
