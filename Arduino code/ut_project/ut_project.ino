// =============================================================
// QWash Bay Controller – ESP32 Firmware  v4
// • strEqI() tek yerde → normalizePackage + isCancelValue lambda tekrarı yok
// • strtrim() geri eklendi → mqttCallback temizlendi
// • initiateCancelFlow() → sendCancelRequest + cancelPaymentWait tekrarı yok
// • resetForBackendCommand() kaldırıldı, resetUiFlow() yeterli
// • isCancelValue: 8x if → array + döngü
// • drawStatusScreenIfNeeded: char* param → static yerel değişken
// • setCurrentStatus zaten stateChanged=true yapıyor, gereksiz tekrarlar silindi
// NOT: SU/KOPUK dokunmatik mapping mevcut davranışla aynı bırakıldı.
// =============================================================

#include <WiFi.h>
#include <FS.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <WiFiManager.h>
#include <esp_mac.h>

#include <WiFiClientSecure.h>
#include <PubSubClient.h>

#include <TFT_eSPI.h>
#include <time.h>
#include <esp_task_wdt.h>
#include <esp_idf_version.h>

#include "qrcode.h"
#include "secrets.h"

// ================= DEBUG =================
#define DEBUG_LOG 1

#if DEBUG_LOG
  #define LOG_PRINT(x)   Serial.print(x)
  #define LOG_PRINTLN(x) Serial.println(x)
#else
  #define LOG_PRINT(x)
  #define LOG_PRINTLN(x)
#endif

// ================= UI / DOKUNMATIK =================
// Arduino .ino otomatik prototype sorunlarını önlemek için enum/struct en üstte.
enum UiMode {
  UI_NORMAL,
  UI_ERROR,
  UI_TEMP_CANCEL,
  UI_TEMP_FORWARDING,
  UI_PAYMENT_PENDING,
  UI_CANCEL_WAITING_BACKEND,
  UI_WIFI_RESET
};

struct TouchButton {
  uint16_t x1, y1, x2, y2;
};

const TouchButton BTN_SU    = { 20,  80,  150, 170 };
const TouchButton BTN_KOPUK = { 170, 80,  300, 170 };
const TouchButton BTN_IPTAL = { 100, 200, 220, 235 };

// ================= SABITLER =================
// Watchdog
const int WDT_TIMEOUT_SEC = 15;

// Zamanlama (ms)
const unsigned long WIFI_TIMEOUT_MS            = 10000;
const unsigned long WIFI_RETRY_INTERVAL_MS     = 10000;
const unsigned long WIFI_RECONNECT_TIMEOUT_MS  = 10000;
const unsigned long MQTT_RETRY_INTERVAL_MS     = 15000;
const unsigned long NTP_RETRY_INTERVAL_MS      = 30000;
const unsigned long HEARTBEAT_INTERVAL_MS      = 30000;
const unsigned long STATUS_PUBLISH_DEBOUNCE_MS = 1000;
const unsigned long PAYMENT_TIMEOUT_MS         = 30000;
const unsigned long CANCEL_EVENT_DEBOUNCE_MS   = 2000;
const unsigned long CANCEL_BACKEND_TIMEOUT_MS  = 1500;
const unsigned long WAITING_TIMEOUT_MS         = 60000;
const unsigned long ERROR_SCREEN_MS            = 2000;
const unsigned long CANCEL_SCREEN_MS           = 300;
const unsigned long FORWARDING_SCREEN_MS       = 500;
const unsigned long BUTTON_DEBOUNCE_MS         = 200;

// WiFi reset butonu
const unsigned long WIFI_RESET_HOLD_START_MS   = 2000;
const unsigned long WIFI_RESET_HOLD_TOTAL_MS   = 10000;

// Süre sınırları
const int MIN_DURATION_SEC = 10;
const int MAX_DURATION_SEC = 3600;

// Buzzer frekansları
const int BUZZ_TICK_HZ       = 2000;
const int BUZZ_URGENT_HZ     = 2500;
const int BUZZ_DONE_HZ       = 1000;
const int BUZZ_RESET_HZ      = 2000;
const int BUZZ_RESET_LONG_HZ = 1000;

// Pinler
const int PIN_BUZZER   = 25;
const int PIN_BTN_FOAM = 32;

// ================= GLOBAL NESNELER =================
TFT_eSPI tft = TFT_eSPI();

WiFiClientSecure mqttSecureClient;
PubSubClient mqttClient(mqttSecureClient);

// ================= WATCHDOG =================
bool wdtStarted = false;
bool loopTaskRegistered = false;

// ================= NTP / SAAT =================
bool clockValid = false;
bool offlineDueToClockError = false;
unsigned long lastNtpAttemptMs = 0;

// ================= MQTT =================
char mqttClientId[64]        = {0};
char mqttTopicCommands[128]  = {0};
char mqttTopicStatus[128]    = {0};
char mqttTopicHeartbeat[128] = {0};
char mqttTopicSelection[128] = {0};
char mqttTopicEvent[128]     = {0};

unsigned long lastMqttAttemptMs = 0;
bool firstMqttConnectionDone = false;

TaskHandle_t mqttTaskHandle = NULL;
bool mqttTaskStarted = false;

struct MqttPublishJob {
  char topic[96];
  char payload[192];
  bool retained;
};

QueueHandle_t mqttPublishQueue = NULL;

char lastPublishedStatus[32] = {0};
unsigned long lastStatusPublishMs = 0;
uint32_t mqttEventCounter = 0;

// ================= ISLEM / BAY DURUMU =================
unsigned long processStartMs = 0;
unsigned long processDurationMs = 0;

char bayId[32] = {0};
char macAddress[32] = {0};
char currentStatus[32] = "baslangic";
bool isBayActive = true;
char requestedPackage[64] = {0};
int durationSec = 60;
bool newBusyCommandArrived = false;

// ================= WIFI =================
unsigned long lastWifiAttemptMs = 0;
bool wifiReconnectInProgress = false;
bool wifiWasConnected = false;
unsigned long wifiReconnectStartMs = 0;

// ================= HEARTBEAT =================
unsigned long lastHeartbeatMs = 0;

// ================= WAITING / SAYAC =================
unsigned long waitingStartMs = 0;
int lastBarWidth = -1;

int counterLastSec = -1;
unsigned long counterLastHalfSecMs = 0;
bool counterDoneBeepPlayed = false;

// ================= UI STATE =================
UiMode uiMode = UI_NORMAL;
unsigned long uiModeStartMs = 0;
char pendingPackage[64] = {0};

// ================= GENEL BAYRAKLAR =================
bool stateChanged = true;
unsigned long lastCancelEventMs = 0;

// ================= BUTON DEBOUNCE =================
unsigned long lastFoamButtonMs = 0;
bool prevFoamButtonState = HIGH;

// ============================================================
// Forward declarations
// ============================================================
void goAvailable(const char* reason, bool sendCancel);
void initiateCancelFlow(const char* reason);
void sendCancelEvent();

void setCurrentStatus(const char* status);
bool currentStatusIs(const char* status);

void setUiMode(UiMode mode);
bool uiModeIs(UiMode mode);
bool inputAllowed();

const char* normalizePackage(const char* package);
bool isCancelValue(const char* value);

bool mqttEnqueue(const char* topic, const char* payload, bool retained = false);
bool mqttPublishStatus();
bool mqttPublishHeartbeat();
bool mqttPublishBoot();
bool mqttPublishSelection(const char* selectedPackage);
bool mqttPublishEvent(const char* eventMessage);
bool mqttPublishStatusForce();

// ================= STRING YARDIMCILARI =================

/* strEqI – büyük/küçük harf duyarsız karşılaştırma; tek tanım, her yerde kullanılır */
static inline bool strEqI(const char* a, const char* b) {
  for (; *a && *b; ++a, ++b) {
    char ca = *a; if (ca >= 'A' && ca <= 'Z') ca += 'a' - 'A';
    char cb = *b; if (cb >= 'A' && cb <= 'Z') cb += 'a' - 'A';
    if (ca != cb) return false;
  }
  return *a == '\0' && *b == '\0';
}

/* strtrim – baş ve sondaki whitespace'i yerinde siler */
static void strtrim(char* s) {
  if (!s) return;
  char* start = s;
  while (*start == ' ' || *start == '\t' || *start == '\r' || *start == '\n') start++;
  if (start != s) memmove(s, start, strlen(start) + 1);
  char* end = s + strlen(s);
  while (end > s && (*(end-1)==' '||*(end-1)=='\t'||*(end-1)=='\r'||*(end-1)=='\n')) end--;
  *end = '\0';
}

/* normalizePackage – paket adını standart forma çevirir */
const char* normalizePackage(const char* package) {
  if (!package) return "";
  if (strEqI(package,"foam")||strEqI(package,"kopuk")||strEqI(package,"köpük")||strEqI(package,"kopup"))
    return "foam";
  if (strEqI(package,"wash")||strEqI(package,"su")||strEqI(package,"water")||strEqI(package,"yikama")||strEqI(package,"yıkama"))
    return "wash";
  return "";
}

/* isCancelValue – iptal türü değerleri tanır; array + döngü ile tek nokta */
bool isCancelValue(const char* value) {
  if (!value) return false;
  static const char* const CANCEL_TOKENS[] = {
    "cancel","cancelled","canceled","iptal","abort","stop","back","geri"
  };
  for (const char* t : CANCEL_TOKENS) {
    if (strEqI(value, t)) return true;
  }
  return false;
}

// ================= UI HELPERS =================
void setUiMode(UiMode mode) {
  uiMode = mode;
  uiModeStartMs = millis();

  if (mode != UI_TEMP_FORWARDING) {
    pendingPackage[0] = '\0';
  }
}

bool uiModeIs(UiMode mode) {
  return uiMode == mode;
}

/* inputAllowed – kullanıcı girişine izin verilen durumu tek yerde tanımlar */
bool inputAllowed() {
  return currentStatusIs("waiting") && uiModeIs(UI_NORMAL);
}

bool isTouched(uint16_t x, uint16_t y, const TouchButton& btn) {
  return x >= btn.x1 && x <= btn.x2 && y >= btn.y1 && y <= btn.y2;
}

/* resetUiFlow – UI akışını temizler */
void resetUiFlow() {
  setUiMode(UI_NORMAL);
  pendingPackage[0] = '\0';
}

// ================= WATCHDOG =================
void watchdogFeed() {
  if (wdtStarted) esp_task_wdt_reset();
}

void watchdogStart() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t cfg;
  cfg.timeout_ms = WDT_TIMEOUT_SEC * 1000;
  cfg.idle_core_mask = (1 << portNUM_PROCESSORS) - 1;
  cfg.trigger_panic = true;
  esp_err_t result = esp_task_wdt_init(&cfg);
#else
  esp_err_t result = esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif

  if (result == ESP_OK || result == ESP_ERR_INVALID_STATE) {
    wdtStarted = true;
    LOG_PRINT(F("WDT aktif. Timeout sn: "));
    LOG_PRINTLN(WDT_TIMEOUT_SEC);
  } else {
    LOG_PRINT(F("WDT baslatilamadi. Hata: "));
    LOG_PRINTLN(result);
  }
}

void watchdogRegisterLoop() {
  if (!wdtStarted || loopTaskRegistered) return;
  esp_err_t result = esp_task_wdt_add(NULL);
  if (result == ESP_OK || result == ESP_ERR_INVALID_STATE) {
    loopTaskRegistered = true;
    LOG_PRINTLN(F("WDT loop task kaydedildi."));
    watchdogFeed();
  } else {
    LOG_PRINT(F("WDT loop task kayit hatasi: "));
    LOG_PRINTLN(result);
  }
}

void watchdogRegisterTask(const char* taskName) {
  if (!wdtStarted) return;
  esp_err_t result = esp_task_wdt_add(NULL);
  if (result == ESP_OK || result == ESP_ERR_INVALID_STATE) {
    LOG_PRINT(F("WDT task kaydedildi: "));
    LOG_PRINTLN(taskName);
    esp_task_wdt_reset();
  } else {
    LOG_PRINT(F("WDT task kayit hatasi: "));
    LOG_PRINT(taskName);
    LOG_PRINT(F(" | "));
    LOG_PRINTLN(result);
  }
}

// ================= YARDIMCI =================
bool isClockValid() {
  time_t now;
  time(&now);
  return now > 1672531200; // 2023-01-01 sonrası yeterli kabul edilir.
}

void resetCounterState() {
  counterLastSec = -1;
  counterLastHalfSecMs = 0;
  counterDoneBeepPlayed = false;
}

bool isDurationValid(int incomingDuration) {
  if (incomingDuration < MIN_DURATION_SEC || incomingDuration > MAX_DURATION_SEC) {
    LOG_PRINT(F("Gecersiz durationSec: "));
    LOG_PRINTLN(incomingDuration);
    return false;
  }
  return true;
}

void clearProcessState() {
  processStartMs = 0;
  processDurationMs = 0;
  resetCounterState();
  newBusyCommandArrived = false;
}

void logHeap(const char* stage) {
  LOG_PRINT(F("[HEAP] "));
  LOG_PRINT(stage);
  LOG_PRINT(F(" | Free: "));
  LOG_PRINT(ESP.getFreeHeap());
  LOG_PRINT(F(" | Min: "));
  LOG_PRINTLN(ESP.getMinFreeHeap());
}

// ================= EKRANLAR =================
void drawClosed() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED);
  tft.setTextSize(3);
  tft.setCursor(50, 80);  tft.println("BU PERON");
  tft.setCursor(40, 120); tft.println("KAPALIDIR");
}

void drawConnectionError() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED);
  tft.setTextSize(2);
  tft.setCursor(25, 90);  tft.println("Baglanti Hatasi");
  tft.setCursor(25, 120); tft.println("Tekrar deneniyor...");
}

void drawClockError() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED);
  tft.setTextSize(2);
  tft.setCursor(25, 80);  tft.println("Saat Hatasi");
  tft.setCursor(25, 115); tft.println("NTP bekleniyor...");
}

void drawWaiting() {
  setUiMode(UI_NORMAL);
  waitingStartMs = millis();
  lastBarWidth   = -1;

  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE);
  tft.setTextSize(2);
  tft.setCursor(30, 20);
  tft.println("Lutfen Paket Seciniz");

  tft.fillRoundRect(BTN_SU.x1, BTN_SU.y1,
    BTN_SU.x2-BTN_SU.x1, BTN_SU.y2-BTN_SU.y1, 10, TFT_BLUE);
  tft.setCursor(65, 115);
  tft.setTextColor(TFT_WHITE, TFT_BLUE);
  tft.setTextSize(3);
  tft.println("SU");

  tft.fillRoundRect(BTN_KOPUK.x1, BTN_KOPUK.y1,
    BTN_KOPUK.x2-BTN_KOPUK.x1, BTN_KOPUK.y2-BTN_KOPUK.y1, 10, TFT_CYAN);
  tft.setCursor(185, 115);
  tft.setTextColor(TFT_BLACK, TFT_CYAN);
  tft.println("KOPUK");

  tft.fillRoundRect(BTN_IPTAL.x1, BTN_IPTAL.y1,
    BTN_IPTAL.x2-BTN_IPTAL.x1, BTN_IPTAL.y2-BTN_IPTAL.y1, 8, TFT_RED);
  tft.setCursor(125, 210);
  tft.setTextColor(TFT_WHITE, TFT_RED);
  tft.setTextSize(2);
  tft.println("IPTAL");
}

void drawMessage(const char* message, uint16_t color) {
  tft.fillRect(0, 95, 320, 60, TFT_BLACK);
  tft.setTextSize(2);
  tft.setTextColor(color, TFT_BLACK);
  tft.setCursor(20, 110);
  tft.println(message);
}

void showError(const char* message) {
  drawMessage(message, TFT_RED);
  setUiMode(UI_ERROR);
}

void startTempScreen(UiMode mode, const char* package = "") {
  setUiMode(mode);

  pendingPackage[0] = '\0';
  if (package && package[0]) {
    strncpy(pendingPackage, package, sizeof(pendingPackage) - 1);
    pendingPackage[sizeof(pendingPackage) - 1] = '\0';
  }

  tft.fillScreen(TFT_BLACK);

  if (mode == UI_TEMP_CANCEL)     drawMessage("Iptal ediliyor...", TFT_RED);
  else if (mode == UI_TEMP_FORWARDING) drawMessage("Istek iletiliyor...", TFT_YELLOW);
}

/* checkUiMode – tüm UI mod timeout'larını tek yerden yönetir */
void checkUiMode() {
  if (uiModeIs(UI_NORMAL) || uiModeIs(UI_WIFI_RESET)) return;

  // Durum dışarıdan değiştiyse geçici UI'ı temizle
  if ((uiModeIs(UI_TEMP_CANCEL) || uiModeIs(UI_TEMP_FORWARDING)) && !currentStatusIs("waiting")) {
    setUiMode(UI_NORMAL);
    return;
  }

  unsigned long elapsed = millis() - uiModeStartMs;

  if (uiModeIs(UI_TEMP_CANCEL) && elapsed >= CANCEL_SCREEN_MS) {
    // initiateCancelFlow çağrısı yerine doğrudan: bu mod geçiş zincirinin başlangıcı
    initiateCancelFlow("user_tap");
    return;
  }

  if (uiModeIs(UI_TEMP_FORWARDING) && elapsed >= FORWARDING_SCREEN_MS) {
    tft.fillScreen(TFT_BLACK);
    drawMessage("Odeme bekleniyor...", TFT_WHITE);
    setUiMode(UI_PAYMENT_PENDING);
    waitingStartMs = millis();
    return;
  }

  if (uiModeIs(UI_CANCEL_WAITING_BACKEND) && elapsed >= CANCEL_BACKEND_TIMEOUT_MS) {
    LOG_PRINTLN(F("CANCEL backend cevabi gelmedi, lokal AVAILABLE moduna geciliyor."));
    setUiMode(UI_NORMAL);
    setCurrentStatus("available");
    isBayActive = true;
    clearProcessState();
    // stateChanged zaten setCurrentStatus içinde true yapılır
    mqttPublishStatus();
    return;
  }

  if (uiModeIs(UI_ERROR) && elapsed >= ERROR_SCREEN_MS) {
    setUiMode(UI_NORMAL);
    stateChanged = true;
    return;
  }

  if (uiModeIs(UI_PAYMENT_PENDING) && elapsed >= PAYMENT_TIMEOUT_MS) {
    initiateCancelFlow("odeme_timeout");
    return;
  }
}

// ================= QR =================
static void qrDrawCallback(esp_qrcode_handle_t qrcode) {
  int qrSize   = esp_qrcode_get_size(qrcode);
  int maxQrPx  = min(tft.width(), tft.height()) - 20;
  int scale    = max(1, maxQrPx / qrSize);
  int qrSizePx = qrSize * scale;
  int offsetX  = (tft.width()  - qrSizePx) / 2;
  int offsetY  = (tft.height() - qrSizePx) / 2;

  tft.fillScreen(TFT_WHITE);

  for (int y = 0; y < qrSize; y++) {
    for (int x = 0; x < qrSize; x++) {
      if (esp_qrcode_get_module(qrcode, x, y)) {
        tft.fillRect(offsetX + x*scale, offsetY + y*scale, scale, scale, TFT_BLACK);
      }
    }
  }
}

void drawQR(const char* text) {
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func       = qrDrawCallback;
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level   = ESP_QRCODE_ECC_LOW;
  esp_qrcode_generate(&cfg, text);
}

// ================= WIFI =================
bool connectWifi(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFiManager wm;

  if (!wm.getWiFiIsSaved()) {
    char apName[32] = {0};
    const char* macTail = (strlen(macAddress) > 8) ? &macAddress[8] : macAddress;
    snprintf(apName, sizeof(apName), "Qwash-Kurulum-%s", macTail);

    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_YELLOW); tft.setTextSize(2);
    tft.setCursor(10, 40);  tft.println("KURULUM MODU");
    tft.setTextColor(TFT_WHITE);
    tft.setCursor(10, 80);  tft.println("Telefondan baglanin:");
    tft.setTextColor(TFT_GREEN);
    tft.setCursor(10, 110); tft.println(apName);
    tft.setTextColor(TFT_ORANGE); tft.setTextSize(1);
    tft.setCursor(10, 150); tft.println("Sifre Yok");
    tft.setCursor(10, 180); tft.println("Tarayici: 192.168.4.1");

    wm.setConfigPortalTimeout(180);
    if (!wm.autoConnect(apName)) {
      delay(3000);
      ESP.restart();
      return false;
    }
  } else {
    LOG_PRINTLN(F("WiFi baslatiliyor..."));
    WiFi.mode(WIFI_STA);
    WiFi.begin();

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
      delay(500);
      watchdogFeed();
      LOG_PRINT(F("."));
    }
    LOG_PRINTLN("");
  }

  if (WiFi.status() == WL_CONNECTED) {
    LOG_PRINT(F("WiFi IP: "));
    LOG_PRINTLN(WiFi.localIP());
    return true;
  }

  LOG_PRINTLN(F("WiFi yok."));
  return false;
}

void checkWifiReconnect() {
  wl_status_t wifiStatus = WiFi.status();

  if (wifiStatus == WL_CONNECTED) {
    if (!wifiWasConnected) {
      LOG_PRINTLN(F("WiFi yeniden baglandi."));
      LOG_PRINT(F("WiFi IP: ")); LOG_PRINTLN(WiFi.localIP());

      wifiWasConnected        = true;
      wifiReconnectInProgress = false;
      lastWifiAttemptMs       = millis();

      clockValid = isClockValid();
      if (!clockValid) lastNtpAttemptMs = 0;

      lastMqttAttemptMs = 0;
      stateChanged      = true;
    }
    return;
  }

  if (wifiWasConnected) {
    LOG_PRINTLN(F("WiFi baglantisi koptu."));
    wifiWasConnected = false;
    if (!currentStatusIs("busy")) stateChanged = true;
  }

  if (!wifiReconnectInProgress) {
    if (millis() - lastWifiAttemptMs >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiAttemptMs       = millis();
      wifiReconnectStartMs    = millis();
      wifiReconnectInProgress = true;
      LOG_PRINTLN(F("WiFi non-blocking reconnect baslatiliyor..."));
      WiFi.disconnect(false);
      WiFi.reconnect();
    }
    return;
  }

  if (millis() - wifiReconnectStartMs >= WIFI_RECONNECT_TIMEOUT_MS) {
    LOG_PRINTLN(F("WiFi reconnect timeout, tekrar denenecek."));
    wifiReconnectInProgress = false;
    lastWifiAttemptMs       = millis();
    WiFi.disconnect(false);
  }
}

// ================= NTP =================
bool attemptNtp(unsigned long timeoutMs, bool showOnScreen) {
  configTime(3 * 3600, 0, "pool.ntp.org", "time.nist.gov");

  if (showOnScreen) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_WHITE); tft.setTextSize(2);
    tft.setCursor(20, 100);
    tft.println("Saat Guncelleniyor...");
  }

  LOG_PRINT(F("NTP bekleniyor"));

  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    watchdogFeed();
    if (isClockValid()) {
      LOG_PRINTLN(F("\nSaat guncellendi."));
      clockValid             = true;
      offlineDueToClockError = false;
      return true;
    }
    delay(500);
    LOG_PRINT(F("."));
  }

  LOG_PRINTLN(F("\nNTP basarisiz. TLS/MQTT baslatilmayacak."));
  clockValid       = false;
  lastNtpAttemptMs = millis();
  return false;
}

bool ntpWait(unsigned long timeoutMs = 20000)  { return attemptNtp(timeoutMs, true);  }
bool ntpSilent(unsigned long timeoutMs = 10000){ return attemptNtp(timeoutMs, false); }

// ================= MQTT HELPERS =================
void mqttPrepareTopics() {
  snprintf(mqttClientId,       sizeof(mqttClientId),       "qwash_esp32_%s", macAddress);
  snprintf(mqttTopicCommands,  sizeof(mqttTopicCommands),  "qwash/bays/%s/commands",  bayId);
  snprintf(mqttTopicStatus,    sizeof(mqttTopicStatus),    "qwash/bays/%s/status",    bayId);
  snprintf(mqttTopicHeartbeat, sizeof(mqttTopicHeartbeat), "qwash/bays/%s/heartbeat", bayId);
  snprintf(mqttTopicSelection, sizeof(mqttTopicSelection), "qwash/bays/%s/selection", bayId);
  snprintf(mqttTopicEvent,     sizeof(mqttTopicEvent),     "qwash/bays/%s/event",     bayId);
}

bool mqttEnqueue(const char* topic, const char* payload, bool retained) {
  if (!mqttPublishQueue) return false;

  MqttPublishJob job;
  memset(&job, 0, sizeof(job));
  strncpy(job.topic,   topic   ? topic   : "", sizeof(job.topic)   - 1);
  strncpy(job.payload, payload ? payload : "", sizeof(job.payload) - 1);
  job.retained = retained;

  bool ok = xQueueSend(mqttPublishQueue, &job, pdMS_TO_TICKS(50)) == pdTRUE;
  if (!ok) {
    LOG_PRINT(F("MQTT kuyruk dolu: "));
    LOG_PRINT(topic ? topic : "");
    LOG_PRINT(F(" -> "));
    LOG_PRINTLN(payload ? payload : "");
  }
  return ok;
}

bool mqttPublishStatus() {
  unsigned long now = millis();
  if (strcmp(currentStatus, lastPublishedStatus) == 0 &&
      now - lastStatusPublishMs < STATUS_PUBLISH_DEBOUNCE_MS) {
    LOG_PRINT(F("Durum tekrar yayinlanmadi: "));
    LOG_PRINTLN(currentStatus);
    return true;
  }

  bool ok = mqttEnqueue(mqttTopicStatus, currentStatus, true);
  if (ok) {
    strncpy(lastPublishedStatus, currentStatus, sizeof(lastPublishedStatus) - 1);
    lastPublishedStatus[sizeof(lastPublishedStatus) - 1] = '\0';
    lastStatusPublishMs = now;
  }
  return ok;
}

bool mqttPublishStatusForce() {
  bool ok = mqttEnqueue(mqttTopicStatus, currentStatus, true);

  if (ok) {
    strncpy(lastPublishedStatus, currentStatus, sizeof(lastPublishedStatus) - 1);
    lastPublishedStatus[sizeof(lastPublishedStatus) - 1] = '\0';
    lastStatusPublishMs = millis();

    LOG_PRINT(F("Durum force yayinlandi: "));
    LOG_PRINTLN(currentStatus);
  } else {
    LOG_PRINT(F("Durum force yayinlanamadi: "));
    LOG_PRINTLN(currentStatus);
  }

  return ok;
}

bool mqttPublishHeartbeat() { return mqttEnqueue(mqttTopicHeartbeat, "ONLINE", false); }
bool mqttPublishBoot()      { return mqttEnqueue(mqttTopicHeartbeat, "BOOT",   false); }

bool mqttNewEventId(const char* eventType, char* outBuf, size_t outBufSize) {
  if (!outBuf || outBufSize == 0) return false;
  mqttEventCounter++;
  int n = snprintf(outBuf, outBufSize, "%s_%s_%lu_%u",
    bayId, eventType, (unsigned long)millis(), (unsigned int)mqttEventCounter);
  return n > 0 && (size_t)n < outBufSize;
}

bool jsonEscape(const char* src, char* dst, size_t dstSize) {
  if (!src || !dst || dstSize == 0) return false;
  size_t di = 0;
  for (size_t si = 0; src[si]; ++si) {
    char c = src[si];
    const char* rep = NULL;
    char repch = '\0';

    if      (c == '\\') rep = "\\\\";
    else if (c == '"')  rep = "\\\"";
    else if (c == '\n') rep = "\\n";
    else if (c == '\r') rep = "\\r";
    else if (c == '\t') rep = "\\t";
    else repch = c;

    if (rep) {
      size_t rlen = strlen(rep);
      if (di + rlen >= dstSize) return false;
      memcpy(&dst[di], rep, rlen);
      di += rlen;
    } else {
      if (di + 1 >= dstSize) return false;
      dst[di++] = repch;
    }
  }
  if (di >= dstSize) return false;
  dst[di] = '\0';
  return true;
}

bool buildSelectionPayload(const char* selectedPackage, char* outBuf, size_t outBufSize) {
  if (!outBuf || outBufSize == 0) return false;

  char eventId[64];

  if (isCancelValue(selectedPackage)) {
    char escapedEvent[192];
    if (!mqttNewEventId("selection_cancel", eventId, sizeof(eventId))) return false;
    if (!jsonEscape(eventId, escapedEvent, sizeof(escapedEvent))) return false;
    int n = snprintf(outBuf, outBufSize, "{\"type\":\"cancel\",\"eventId\":\"%s\"}", escapedEvent);
    return n > 0 && (size_t)n < outBufSize;
  }

  const char* norm = normalizePackage(selectedPackage);
  const char* packageId = norm[0] ? norm : (selectedPackage ? selectedPackage : "");
  char escapedPackage[192], escapedEvent[192];

  if (!mqttNewEventId("selection", eventId, sizeof(eventId))) return false;
  if (!jsonEscape(packageId, escapedPackage, sizeof(escapedPackage))) return false;
  if (!jsonEscape(eventId, escapedEvent, sizeof(escapedEvent))) return false;

  int n = snprintf(outBuf, outBufSize,
    "{\"type\":\"selection\",\"packageId\":\"%s\",\"eventId\":\"%s\"}",
    escapedPackage, escapedEvent);
  return n > 0 && (size_t)n < outBufSize;
}

bool buildEventPayload(const char* eventMessage, char* outBuf, size_t outBufSize) {
  if (!outBuf || outBufSize == 0) return false;

  const char* eventType = isCancelValue(eventMessage) ? "cancel" : "event";
  char eventId[64], escapedType[64], escapedAction[192], escapedEvent[192];

  if (!mqttNewEventId(eventType, eventId, sizeof(eventId))) return false;
  if (!jsonEscape(eventType, escapedType, sizeof(escapedType))) return false;
  if (!jsonEscape(eventMessage ? eventMessage : "", escapedAction, sizeof(escapedAction))) return false;
  if (!jsonEscape(eventId, escapedEvent, sizeof(escapedEvent))) return false;

  int n = snprintf(outBuf, outBufSize,
    "{\"type\":\"%s\",\"action\":\"%s\",\"eventId\":\"%s\"}",
    escapedType, escapedAction, escapedEvent);
  return n > 0 && (size_t)n < outBufSize;
}

bool mqttPublishSelection(const char* selectedPackage) {
  char payload[192];
  if (!buildSelectionPayload(selectedPackage, payload, sizeof(payload))) return false;
  return mqttEnqueue(mqttTopicSelection, payload, false);
}

bool mqttPublishEvent(const char* eventMessage) {
  char payload[192];
  if (!buildEventPayload(eventMessage, payload, sizeof(payload))) return false;
  return mqttEnqueue(mqttTopicEvent, payload, false);
}

// ================= CANCEL / DURUM GEÇİŞLERİ =================

/* sendCancelEvent – CANCEL mesajını gönderir, debounce korumalı */
void sendCancelEvent() {
  unsigned long now = millis();
  if (now - lastCancelEventMs < CANCEL_EVENT_DEBOUNCE_MS) {
    LOG_PRINTLN(F("CANCEL event tekrar gonderilmedi debounce."));
    return;
  }
  lastCancelEventMs = now;

  if (!mqttPublishEvent("CANCEL")) {
    LOG_PRINTLN(F("CANCEL event gonderilemedi, selection fallback deneniyor."));
    mqttPublishSelection("cancel");
  } else {
    LOG_PRINTLN(F("CANCEL event gonderildi."));
  }
}

/* initiateCancelFlow – iptal akışını başlatan tek nokta.
   sendCancelRequest ve cancelPaymentWait'in ortak gövdesiydi. */
void initiateCancelFlow(const char* reason) {
  LOG_PRINT(F("Cancel akisi baslatildi. Sebep: "));
  LOG_PRINTLN(reason);

  requestedPackage[0] = '\0';
  durationSec = 60;
  clearProcessState();

  setUiMode(UI_CANCEL_WAITING_BACKEND);
  sendCancelEvent();

  tft.fillScreen(TFT_BLACK);
  drawMessage("Iptal ediliyor...", TFT_RED);
}

/* goAvailable – cihazı available moduna döndürür */
void goAvailable(const char* reason, bool sendCancel) {
  LOG_PRINT(F("AVAILABLE moduna donuluyor. Sebep: "));
  LOG_PRINTLN(reason);

  resetUiFlow();

  requestedPackage[0] = '\0';
  durationSec = 60;
  clearProcessState();

  setCurrentStatus("available");
  isBayActive = true;
  // stateChanged zaten setCurrentStatus içinde true yapılır

  if (sendCancel) sendCancelEvent();

  mqttPublishStatus();
}

// ================= MQTT KOMUT =================
void applyMqttCommand(const char* command) {
  LOG_PRINT(F("MQTT Komut: "));
  LOG_PRINTLN(command);

  if (strcmp(command, "AVAILABLE") == 0) {
    offlineDueToClockError = false;
    resetUiFlow();

    if (currentStatusIs("available")) {
      LOG_PRINTLN(F("AVAILABLE zaten aktif, tekrar islenmedi."));
      stateChanged = true;
    } else {
      setCurrentStatus("available");
      isBayActive = true;
      clearProcessState();
    }
  }
  else if (strcmp(command, "WAITING") == 0) {
    offlineDueToClockError = false;
    resetUiFlow();
    setCurrentStatus("waiting");
    isBayActive = true;
    clearProcessState();
  }
  else if (strcmp(command, "OFFLINE") == 0) {
    offlineDueToClockError = false;
    resetUiFlow();
    setCurrentStatus("offline");
    isBayActive = false;
    clearProcessState();
  }
  else if (strcmp(command, "MAINTENANCE") == 0) {
    offlineDueToClockError = false;
    resetUiFlow();
    setCurrentStatus("maintenance");
    isBayActive = true;
    clearProcessState();
  }
  else if (strcmp(command, "ACTIVE_ON") == 0) {
    offlineDueToClockError = false;
    isBayActive = true;
    if (currentStatusIs("offline")) setCurrentStatus("available");
    stateChanged = true;
  }
  else if (strcmp(command, "ACTIVE_OFF") == 0) {
    offlineDueToClockError = false;
    resetUiFlow();
    setCurrentStatus("offline");
    isBayActive = false;
    clearProcessState();
  }
  else if (strcmp(command, "RESET") == 0) {
    ESP.restart();
  }
  else if (strncmp(command, "BUSY|", 5) == 0) {
    const char* sep1 = strchr(command, '|');
    const char* sep2 = sep1 ? strchr(sep1 + 1, '|') : NULL;

    if (sep1 && sep2 && sep2 > sep1 + 1) {
      char packageBuf[32] = {0};
      size_t len = (size_t)(sep2 - (sep1 + 1));
      if (len >= sizeof(packageBuf)) len = sizeof(packageBuf) - 1;
      memcpy(packageBuf, sep1 + 1, len);
      packageBuf[len] = '\0';

      int incomingDuration = atoi(sep2 + 1);
      if (!isDurationValid(incomingDuration)) { mqttPublishSelection("invalid_duration"); return; }

      const char* norm = normalizePackage(packageBuf);
      if (!norm[0])                             { mqttPublishSelection("invalid_package");  return; }

      offlineDueToClockError = false;
      resetUiFlow();

      strncpy(requestedPackage, norm, sizeof(requestedPackage) - 1);
      requestedPackage[sizeof(requestedPackage) - 1] = '\0';
      durationSec = incomingDuration;

      processStartMs    = 0;
      processDurationMs = 0;
      resetCounterState();

      newBusyCommandArrived = true;
      isBayActive           = true;
      setCurrentStatus("busy");
      // setCurrentStatus stateChanged=true ve setUiMode çağrısına gerek yok
    }
  }

  mqttPublishStatusForce();
}

/* mqttCallback – PubSubClient callback; strtrim ile whitespace temizlenir */
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (length == 0 || length > 120) return;

  char message[121];
  memcpy(message, payload, length);
  message[length] = '\0';

  strtrim(message); // baş/son whitespace tek satırda temizlendi

  if (message[0] == '\0') return;

LOG_PRINT(F("MQTT Topic: "));
LOG_PRINTLN(topic);
LOG_PRINT(F("MQTT Payload: "));
LOG_PRINTLN(message);

applyMqttCommand(message);
}

bool mqttConnect() {
  if (WiFi.status() != WL_CONNECTED) return false;

  if (!isClockValid()) {
    clockValid = false;
    if (millis() - lastNtpAttemptMs >= NTP_RETRY_INTERVAL_MS) {
      lastNtpAttemptMs = millis();
      LOG_PRINTLN(F("MQTT oncesi saat gecersiz. NTP tekrar deneniyor."));
      ntpSilent(10000);
    }
    return false;
  }

  clockValid = true;

  if (offlineDueToClockError) {
    LOG_PRINTLN(F("Saat gecerli oldu. NTP kaynakli offline temizleniyor."));
    offlineDueToClockError = false;
    if (currentStatusIs("offline")) {
      setCurrentStatus("baslangic");
      isBayActive = true;
      // stateChanged setCurrentStatus içinde true yapılır
    }
  }

  if (mqttClient.connected()) return true;

  if (millis() - lastMqttAttemptMs < MQTT_RETRY_INTERVAL_MS) return false;
  lastMqttAttemptMs = millis();

  logHeap("MQTT baslangic");

  IPAddress mqttIp;
  if (!WiFi.hostByName(MQTT_HOST, mqttIp)) {
    LOG_PRINTLN(F("MQTT DNS cozulemedi."));
    return false;
  }

  LOG_PRINT(F("MQTT IP: ")); LOG_PRINTLN(mqttIp);

  mqttSecureClient.stop();
  delay(100);
  mqttSecureClient.setCACert(root_ca);
  mqttSecureClient.setTimeout(3000);
  mqttSecureClient.setHandshakeTimeout(5);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(30);
  mqttClient.setSocketTimeout(3);

  logHeap("MQTT connect oncesi");

  LOG_PRINTLN(F("MQTT baglaniliyor..."));

  bool connected = mqttClient.connect(
    mqttClientId, MQTT_USER, MQTT_PASS,
    mqttTopicStatus, 1, true, "offline"
  );

  logHeap("MQTT connect sonrasi");

  if (connected) {
    LOG_PRINTLN(F("MQTT baglandi."));
    mqttClient.subscribe(mqttTopicCommands, 1);

    if (!firstMqttConnectionDone) {
      if (currentStatusIs("baslangic") || currentStatus[0] == '\0') {
        setCurrentStatus("available");
        isBayActive = true;
        clearProcessState();
      }
      mqttPublishBoot();
      firstMqttConnectionDone = true;
    }

    mqttPublishStatus();
    mqttPublishHeartbeat();
    return true;
  }

  LOG_PRINT(F("MQTT hata kodu: "));
  LOG_PRINTLN(mqttClient.state());
  mqttSecureClient.stop();
  return false;
}

void mqttTask(void* parameter) {
  watchdogRegisterTask("mqttTask");
  MqttPublishJob job;

  for (;;) {
    watchdogFeed();

    if (WiFi.status() == WL_CONNECTED) {
      if (!mqttClient.connected()) mqttConnect();

      if (mqttClient.connected()) {
        mqttClient.loop();
        while (xQueueReceive(mqttPublishQueue, &job, 0) == pdTRUE) {
          bool ok = mqttClient.publish(job.topic, job.payload, job.retained);
          if (!ok) {
            LOG_PRINT(F("MQTT publish basarisiz: "));
            LOG_PRINT(job.topic);
            LOG_PRINT(F(" -> "));
            LOG_PRINTLN(job.payload);
          }
        }
      }
    }

    watchdogFeed();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// ================= LOOP ALT FONKSIYONLARI =================

void handleWifiResetButton() {
  static unsigned long holdStartMs   = 0;
  static bool          holdActive    = false;
  static int           shownSecond   = -1;

  if (digitalRead(PIN_BTN_FOAM) == LOW) {
    if (!holdActive) {
      holdActive   = true;
      holdStartMs  = millis();
      shownSecond  = -1;
      return;
    }

    unsigned long heldMs = millis() - holdStartMs;

    if (heldMs >= WIFI_RESET_HOLD_START_MS && heldMs < WIFI_RESET_HOLD_TOTAL_MS) {
      int secLeft = 10 - (int)(heldMs / 1000);
      if (secLeft != shownSecond) {
        shownSecond = secLeft;
        setUiMode(UI_WIFI_RESET);
        tft.fillScreen(TFT_BLACK);
        tft.setTextColor(TFT_ORANGE); tft.setTextSize(2);
        tft.setCursor(10, 80);  tft.println("WIFI SIFIRLANACAK:");
        tft.setTextColor(TFT_RED); tft.setTextSize(6);
        tft.setCursor(140, 120); tft.println(secLeft);
        tone(PIN_BUZZER, BUZZ_RESET_HZ, 100);
      }
    }
    else if (heldMs >= WIFI_RESET_HOLD_TOTAL_MS) {
      LOG_PRINTLN(F("WIFI SIFIRLANIYOR..."));
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_RED); tft.setTextSize(2);
      tft.setCursor(20, 100); tft.println("WIFI SIFIRLANDI!");
      tft.setCursor(20, 140); tft.println("Yeniden basliyor...");
      tone(PIN_BUZZER, BUZZ_RESET_LONG_HZ, 2000);
      delay(2000);
      WiFiManager wm;
      wm.resetSettings();
      ESP.restart();
    }
    return;
  }

  if (holdActive) {
    holdActive = false;
    if (shownSecond != -1) {
      shownSecond  = -1;
      setUiMode(UI_NORMAL);
      stateChanged = true;
    }
  }
}

void handleWaitingProgressBar() {
  if (!inputAllowed()) return;

  unsigned long elapsedMs = millis() - waitingStartMs;

  if (elapsedMs >= WAITING_TIMEOUT_MS) {
    goAvailable("waiting_timeout", false);
    return;
  }

  const int maxWidth     = 280;
  int       currentWidth = map(elapsedMs, 0, WAITING_TIMEOUT_MS, maxWidth, 0);

  if (currentWidth != lastBarWidth) {
    tft.fillRect(20, 185, currentWidth, 8, TFT_GREEN);
    if (maxWidth > currentWidth)
      tft.fillRect(20 + currentWidth, 185, maxWidth - currentWidth, 8, TFT_BLACK);
    lastBarWidth = currentWidth;
  }
}

void handleWaitingInput() {
  if (!inputAllowed()) return;

  char selectedPackage[16] = {0};

  bool foamButtonState = digitalRead(PIN_BTN_FOAM);
  if (foamButtonState == LOW && prevFoamButtonState == HIGH &&
      millis() - lastFoamButtonMs > BUTTON_DEBOUNCE_MS) {
    lastFoamButtonMs = millis();
    strncpy(selectedPackage, "foam", sizeof(selectedPackage) - 1);
  }
  prevFoamButtonState = foamButtonState;

  if (!selectedPackage[0]) {
    uint16_t x, y;
    if (tft.getTouch(&x, &y)) {
      if      (isTouched(x, y, BTN_IPTAL)) strncpy(selectedPackage, "cancel", sizeof(selectedPackage) - 1);
      // NOT: Kullanıcının isteğiyle mevcut mapping korunmuştur.
      else if (isTouched(x, y, BTN_KOPUK)) strncpy(selectedPackage, "wash",   sizeof(selectedPackage) - 1);
      else if (isTouched(x, y, BTN_SU))    strncpy(selectedPackage, "foam",   sizeof(selectedPackage) - 1);
    }
  }

  if (!selectedPackage[0]) return;

  if (strcmp(selectedPackage, "cancel") == 0) {
    startTempScreen(UI_TEMP_CANCEL);
    return;
  }

  if (!mqttPublishSelection(selectedPackage)) {
    showError("Baglanti yok");
    return;
  }

  startTempScreen(UI_TEMP_FORWARDING, selectedPackage);
}

void updateCountdown() {
  if (processDurationMs == 0) return;

  unsigned long nowMs    = millis();
  unsigned long elapsed  = nowMs - processStartMs;

  if (elapsed < processDurationMs) {
    unsigned long remainMs  = processDurationMs - elapsed;
    unsigned long remainSec = (remainMs + 999) / 1000;
    int sec = remainSec % 60;
    int min = remainSec / 60;

    if (remainSec >= 10) {
      if ((int)remainSec != counterLastSec) tone(PIN_BUZZER, BUZZ_TICK_HZ, 100);
    } else {
      if (nowMs - counterLastHalfSecMs >= 500) {
        tone(PIN_BUZZER, BUZZ_URGENT_HZ, 100);
        counterLastHalfSecMs = nowMs;
      }
    }

    if ((int)remainSec != counterLastSec) {
      tft.setTextColor(TFT_YELLOW, TFT_BLACK);
      tft.setTextSize(5);
      tft.setCursor(80, 120);
      tft.printf("%02d:%02d   ", min, sec);
      counterLastSec = remainSec;
    }

    counterDoneBeepPlayed = false;
  }
  else if (!counterDoneBeepPlayed) {
    tone(PIN_BUZZER, BUZZ_DONE_HZ, 3000);

    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED);
    tft.setTextSize(3);
    tft.setCursor(40, 110);
    tft.println("ISLEM BITTI");

    counterDoneBeepPlayed = true;
    processStartMs        = 0;
    processDurationMs     = 0;

    setCurrentStatus("waiting");
    setUiMode(UI_NORMAL);
    // stateChanged setCurrentStatus içinde true yapılır
    mqttPublishStatus();
  }
}

/* drawStatusScreenIfNeeded – stateChanged=true olduğunda ekranı günceller.
   previousStatus artık burada static; dışarıdan pointer almaya gerek yok. */
void drawStatusScreenIfNeeded() {
  static char previousStatus[32] = {0};

  if (!stateChanged) return;
  stateChanged = false;

  LOG_PRINT(F("DURUM: "));
  LOG_PRINTLN(currentStatus);

  mqttPublishStatus();

  if (currentStatusIs("available")) {
    resetUiFlow();
    clearProcessState();
    drawQR(bayId);
  }
  else if (currentStatusIs("maintenance")) {
    resetUiFlow();
    clearProcessState();
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_ORANGE, TFT_BLACK);
    tft.setTextSize(3);
    tft.setCursor(40, 100);
    tft.println("BAKIM MODU");
  }
  else if (currentStatusIs("waiting")) {
    resetUiFlow();
    clearProcessState();
    drawWaiting();
  }
  else if (currentStatusIs("busy")) {
    setUiMode(UI_NORMAL);
    tft.fillScreen(TFT_BLACK);
    tft.setTextSize(3);
    tft.setTextColor(TFT_GREEN, TFT_BLACK);
    tft.setCursor(30, 40);
    tft.println(strcmp(requestedPackage, "foam") == 0 ? "KOPUK MODU" : "SU MODU");

    if (strcmp(previousStatus, "busy") != 0 || newBusyCommandArrived) {
      processStartMs        = millis();
      processDurationMs     = durationSec * 1000UL;
      newBusyCommandArrived = false;
      LOG_PRINT(F("Sure baslatildi. Paket: "));
      LOG_PRINT(requestedPackage);
      LOG_PRINT(F(" Sure: "));
      LOG_PRINTLN(durationSec);
      resetCounterState();
    }
  }
  else if (currentStatusIs("baslangic")) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_WHITE); tft.setTextSize(2);
    tft.setCursor(20, 100);
    tft.println("Durum Aliniyor...");
  }
  else {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED); tft.setTextSize(2);
    tft.setCursor(20, 100);
    tft.println("Bilinmeyen Durum");
  }

  strncpy(previousStatus, currentStatus, sizeof(previousStatus) - 1);
  previousStatus[sizeof(previousStatus) - 1] = '\0';
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(500);

  watchdogStart();

  mqttClientId[0] = mqttTopicCommands[0] = mqttTopicStatus[0] = '\0';
  mqttTopicHeartbeat[0] = mqttTopicSelection[0] = mqttTopicEvent[0] = '\0';

  pinMode(PIN_BUZZER,   OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_BTN_FOAM, INPUT_PULLUP);

  tft.init();
  tft.setRotation(1);
  tft.fillScreen(TFT_BLACK);

  uint16_t calData[5] = { 275, 3620, 264, 3532, 1 };
  tft.setTouch(calData);

  tft.setCursor(20, 100);
  tft.setTextSize(2);
  tft.setTextColor(TFT_WHITE);
  tft.println("Baslatiliyor...");

  WiFi.mode(WIFI_STA);

  uint8_t macBytes[6] = {0};
  esp_read_mac(macBytes, ESP_MAC_WIFI_STA);
  snprintf(macAddress, sizeof(macAddress), "%02X%02X%02X%02X%02X%02X",
    macBytes[0], macBytes[1], macBytes[2],
    macBytes[3], macBytes[4], macBytes[5]);

  if (strcmp(macAddress, "000000000000") == 0 || strlen(macAddress) != 12) {
    LOG_PRINTLN(F("MAC okunamadi, cihaz yeniden baslatiliyor."));
    delay(1000);
    ESP.restart();
  }

  snprintf(bayId, sizeof(bayId), "bay_%s", macAddress);
  mqttPrepareTopics();

  if (!mqttPublishQueue)
    mqttPublishQueue = xQueueCreate(20, sizeof(MqttPublishJob));

  if (!mqttTaskStarted && mqttPublishQueue) {
    xTaskCreatePinnedToCore(mqttTask, "mqttTask", 8192, NULL, 1, &mqttTaskHandle, 0);
    mqttTaskStarted = true;
  }

  if (!connectWifi(WIFI_TIMEOUT_MS)) {
    setCurrentStatus("offline");
    isBayActive            = false;
    offlineDueToClockError = false;
    drawConnectionError();
    lastWifiAttemptMs = millis();
    watchdogRegisterLoop();
    return;
  }

  wifiWasConnected        = true;
  wifiReconnectInProgress = false;

  if (!ntpWait()) {
    setCurrentStatus("offline");
    isBayActive            = false;
    offlineDueToClockError = true;
    drawClockError();
    stateChanged     = true;
    wifiWasConnected = WiFi.status() == WL_CONNECTED;
    lastHeartbeatMs  = millis();
    watchdogRegisterLoop();
    return;
  }

  wifiWasConnected = WiFi.status() == WL_CONNECTED;
  lastHeartbeatMs  = millis();
  stateChanged     = true;
  watchdogRegisterLoop();
}

// ================= LOOP =================
void loop() {
  watchdogFeed();

  handleWifiResetButton();
  checkWifiReconnect();

  if (WiFi.status() != WL_CONNECTED) {
    if (!currentStatusIs("busy") && !uiModeIs(UI_ERROR) && stateChanged) {
      drawConnectionError();
      stateChanged = false;
    }
  }

  checkUiMode();

  if (millis() - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = millis();
    mqttPublishHeartbeat();
  }

  if (!isBayActive || currentStatusIs("offline")) {
    if (stateChanged) {
      stateChanged = false;
      if (mqttClient.connected()) mqttPublishStatus();
      offlineDueToClockError ? drawClockError() : drawClosed();
      LOG_PRINTLN(F("KAPALI"));
    }
    return;
  }

  drawStatusScreenIfNeeded();

  if (currentStatusIs("busy")) {
    updateCountdown();
  }
  else if (currentStatusIs("waiting")) {
    handleWaitingProgressBar();
    handleWaitingInput();
  }
}

// ================= STATUS HELPERS =================
void setCurrentStatus(const char* status) {
  if (!status) status = "";
  strncpy(currentStatus, status, sizeof(currentStatus) - 1);
  currentStatus[sizeof(currentStatus) - 1] = '\0';
  stateChanged = true;
}

bool currentStatusIs(const char* status) {
  if (!status) status = "";
  return strcmp(currentStatus, status) == 0;
}
