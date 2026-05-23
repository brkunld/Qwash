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
  #define LOG_PRINT(x) Serial.print(x)
  #define LOG_PRINTLN(x) Serial.println(x)
#else
  #define LOG_PRINT(x)
  #define LOG_PRINTLN(x)
#endif

// ================= WATCHDOG =================
// Task Watchdog Timer, ana loop ve MQTT task kilitlenirse ESP32'yi resetler.
const int WDT_TIMEOUT_SEC = 15;
bool wdtBaslatildi = false;
bool loopTaskWdtKayitli = false;

void watchdogBesle() {
  if (wdtBaslatildi) {
    esp_task_wdt_reset();
  }
}

void watchdogBaslat() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdtConfig;
  wdtConfig.timeout_ms = WDT_TIMEOUT_SEC * 1000;
  wdtConfig.idle_core_mask = (1 << portNUM_PROCESSORS) - 1;
  wdtConfig.trigger_panic = true;

  esp_err_t result = esp_task_wdt_init(&wdtConfig);
#else
  esp_err_t result = esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif

  if (result == ESP_OK || result == ESP_ERR_INVALID_STATE) {
    wdtBaslatildi = true;
    LOG_PRINT(F("WDT aktif. Timeout sn: "));
    LOG_PRINTLN(WDT_TIMEOUT_SEC);
  } else {
    LOG_PRINT(F("WDT baslatilamadi. Hata: "));
    LOG_PRINTLN(result);
  }
}

void watchdogLoopTaskKaydet() {
  if (!wdtBaslatildi || loopTaskWdtKayitli) {
    return;
  }

  esp_err_t result = esp_task_wdt_add(NULL);

  if (result == ESP_OK || result == ESP_ERR_INVALID_STATE) {
    loopTaskWdtKayitli = true;
    LOG_PRINTLN(F("WDT loop task kaydedildi."));
    watchdogBesle();
  } else {
    LOG_PRINT(F("WDT loop task kayit hatasi: "));
    LOG_PRINTLN(result);
  }
}

void watchdogCurrentTaskKaydet(const char* taskName) {
  if (!wdtBaslatildi) {
    return;
  }

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

// ================= EKRAN =================
TFT_eSPI tft = TFT_eSPI();

// ================= ZAMAN / NTP =================
bool saatGecerli = false;
bool saatHatasiNedeniyleOffline = false;
unsigned long sonNtpDenemeMs = 0;
const unsigned long NTP_RETRY_INTERVAL_MS = 30000;

bool sistemSaatiGecerliMi() {
  time_t suAn;
  time(&suAn);

  // 2023-01-01 sonrası yeterli kabul edilir.
  return suAn > 1672531200;
}

// ================= DOKUNMATIK BUTON ALANLARI =================
struct TouchButton {
  uint16_t x1;
  uint16_t y1;
  uint16_t x2;
  uint16_t y2;
};

const TouchButton BTN_SU = {
  20, 80,
  150, 170,
};

const TouchButton BTN_KOPUK = {
  170, 80,
  300, 170,
};

const TouchButton BTN_IPTAL = {
  100, 200,
  220, 235,
};

bool dokunmaButonIcindeMi(
  uint16_t x,
  uint16_t y,
  uint16_t x1,
  uint16_t y1,
  uint16_t x2,
  uint16_t y2
) {
  return (
    x >= x1 &&
    x <= x2 &&
    y >= y1 &&
    y <= y2
  );
}

// ================= MQTT =================
WiFiClientSecure mqttSecureClient;
PubSubClient mqttClient(mqttSecureClient);

char mqttClientId[64] = {0};
char mqttTopicCommands[128] = {0};
char mqttTopicStatus[128] = {0};
char mqttTopicHeartbeat[128] = {0};
char mqttTopicSelection[128] = {0};
char mqttTopicEvent[128] = {0};

unsigned long sonMqttDenemeMs = 0;
const unsigned long MQTT_RETRY_INTERVAL_MS = 15000;
bool ilkMqttBaglantiTamamlandi = false;

TaskHandle_t mqttTaskHandle = NULL;
bool mqttTaskBaslatildi = false;

struct MqttPublishJob {
  char topic[96];
  char payload[192];
  bool retained;
};

QueueHandle_t mqttPublishQueue = NULL;

char sonYayinlananDurum[32] = {0};
unsigned long sonDurumYayinMs = 0;
const unsigned long DURUM_YAYIN_DEBOUNCE_MS = 1000;

// Backend MQTT idempotency icin her kritik event benzersiz eventId tasir.
// Not: PubSubClient publish tarafinda QoS1 desteklemez; bu yuzden burada
// sadece eventId/JSON uyumu eklenir. QoS1 publish icin ileride MQTT
// kutuphanesi degistirilmelidir.
uint32_t mqttEventCounter = 0;

// ================= ZAMAN =================
unsigned long islemBaslangicMs = 0;
unsigned long islemSuresiMs = 0;

// ================= PINLER =================
const int buzzerPin = 25;
const int btnKopukPin = 32;

// ================= PERON =================
char bayId[32] = {0};
char macAdresi[32] = {0};
char currentStatus[32] = "baslangic";
bool isBayActive = true;
char requestedPackage[64] = {0};
int durationSec = 60;

bool yeniBusyKomutuGeldi = false;

// ================= SURE =================
const int MIN_DURATION_SEC = 10;
const int MAX_DURATION_SEC = 3600;

// ================= WIFI =================
const unsigned long WIFI_TIMEOUT_MS = 10000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;
unsigned long sonWifiDenemeMs = 0;

bool wifiReconnectInProgress = false;
bool wifiWasConnected = false;
unsigned long wifiReconnectStartedMs = 0;
const unsigned long WIFI_RECONNECT_TIMEOUT_MS = 10000;

// ================= NABIZ =================
unsigned long sonNabizZamani = 0;
const unsigned long nabizAraligi = 30000;

// ================= BEKLEME =================
unsigned long beklemeBaslangicMs = 0;
const unsigned long BEKLEME_SURESI_MS = 60000;
int sonSeritGenisligi = -1;

// ================= HATA =================
unsigned long hataEkraniBaslangicMs = 0;
bool hataEkraniGosteriliyor = false;

// ================= KILITLER =================
bool durumDegisti = true;
bool dokunmatikKilit = false;
bool odemeBekleniyor = false;
unsigned long odemeBeklemeBaslangicMs = 0;
const unsigned long ODEME_BEKLEME_TIMEOUT_MS = 30000;
unsigned long sonCancelEventMs = 0;
const unsigned long CANCEL_EVENT_DEBOUNCE_MS = 2000;
bool cancelBackendCevabiBekleniyor = false;
unsigned long cancelBackendBeklemeBaslangicMs = 0;
const unsigned long CANCEL_BACKEND_TIMEOUT_MS = 1500;

// ================= NON-BLOCKING EKRAN AKISI =================
enum GeciciEkranModu {
  GECICI_YOK,
  GECICI_IPTAL,
  GECICI_ISTEK_ILETILIYOR
};

GeciciEkranModu geciciEkranModu = GECICI_YOK;
unsigned long geciciEkranBaslangicMs = 0;
const unsigned long IPTAL_EKRANI_MS = 300;
const unsigned long ISTEK_ILETILIYOR_EKRANI_MS = 500;
char bekleyenPaketSecimi[64] = {0};

// ================= SAYAC =================
int sayacSonEkranSaniye = -1;
unsigned long sayacSonYarimSaniyeMs = 0;
bool sayacIslemBittiCalindi = false;

// ================= BUTON DEBOUNCE =================
unsigned long sonKopukButonMs = 0;
const unsigned long BUTON_DEBOUNCE_MS = 200;
bool oncekiKopukButonDurumu = HIGH;

// ============================================================
void availableModunaDon(const char* sebep, bool cancelEventGonder);
void iptalIstegiGonder();
void odemeBeklemeIptalEt(const char* sebep);

const char* paketNormalizeEt_cstr(const char* paket);
bool mqttCancelDegeriMi_cstr(const char* value);
bool mqttKuyrugaEkle_cstr(const char* topic, const char* payload, bool retained = false);
bool mqttDurumYayinla();
bool mqttHeartbeatYayinla();
bool mqttBootYayinla();
bool mqttSecimYayinla(const char* secilenPaket);
bool mqttEventYayinla(const char* eventMesaji);
void setCurrentStatus(const char* s);
bool currentStatusEquals(const char* s);

// ================= YARDIMCI =================
void resetSayacDurumu() {
  sayacSonEkranSaniye = -1;
  sayacSonYarimSaniyeMs = 0;
  sayacIslemBittiCalindi = false;
}

bool durationGecerliMi(int gelenSure) {
  if (gelenSure < MIN_DURATION_SEC || gelenSure > MAX_DURATION_SEC) {
    LOG_PRINT(F("Gecersiz durationSec: "));
    LOG_PRINTLN(gelenSure);
    return false;
  }

  return true;
}

void islemHafizasiniTemizle() {
  islemBaslangicMs = 0;
  islemSuresiMs = 0;
  resetSayacDurumu();
  yeniBusyKomutuGeldi = false;
}

void heapYaz(const char* asama) {
  LOG_PRINT(F("[HEAP] "));
  LOG_PRINT(asama);
  LOG_PRINT(F(" | Free: "));
  LOG_PRINT(ESP.getFreeHeap());
  LOG_PRINT(F(" | Min: "));
  LOG_PRINTLN(ESP.getMinFreeHeap());
}

// ================= EKRANLAR =================
void ekranaKapaliYaz() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED);
  tft.setTextSize(3);
  tft.setCursor(50, 80);
  tft.println("BU PERON");
  tft.setCursor(40, 120);
  tft.println("KAPALIDIR");
}

void ekranaBaglantiHatasiYaz() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED);
  tft.setTextSize(2);
  tft.setCursor(25, 90);
  tft.println("Baglanti Hatasi");
  tft.setCursor(25, 120);
  tft.println("Tekrar deneniyor...");
}

void ekranaSaatHatasiYaz() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED);
  tft.setTextSize(2);
  tft.setCursor(25, 80);
  tft.println("Saat Hatasi");
  tft.setCursor(25, 115);
  tft.println("NTP bekleniyor...");
}

void ekranaWaitingCiz() {
  dokunmatikKilit = false;
  odemeBekleniyor = false;

  beklemeBaslangicMs = millis();
  sonSeritGenisligi = -1;

  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE);
  tft.setTextSize(2);
  tft.setCursor(30, 20);
  tft.println("Lutfen Paket Seciniz");

  tft.fillRoundRect(
    BTN_SU.x1,
    BTN_SU.y1,
    BTN_SU.x2 - BTN_SU.x1,
    BTN_SU.y2 - BTN_SU.y1,
    10,
    TFT_BLUE
  );
  tft.setCursor(65, 115);
  tft.setTextColor(TFT_WHITE, TFT_BLUE);
  tft.setTextSize(3);
  tft.println("SU");

  tft.fillRoundRect(
    BTN_KOPUK.x1,
    BTN_KOPUK.y1,
    BTN_KOPUK.x2 - BTN_KOPUK.x1,
    BTN_KOPUK.y2 - BTN_KOPUK.y1,
    10,
    TFT_CYAN
  );
  tft.setCursor(185, 115);
  tft.setTextColor(TFT_BLACK, TFT_CYAN);
  tft.println("KOPUK");

  tft.fillRoundRect(
    BTN_IPTAL.x1,
    BTN_IPTAL.y1,
    BTN_IPTAL.x2 - BTN_IPTAL.x1,
    BTN_IPTAL.y2 - BTN_IPTAL.y1,
    8,
    TFT_RED
  );
  tft.setCursor(125, 210);
  tft.setTextColor(TFT_WHITE, TFT_RED);
  tft.setTextSize(2);
  tft.println("IPTAL");
}

void ekranaMesajYaz(const char* mesaj, uint16_t renk) {
  tft.fillRect(0, 95, 320, 60, TFT_BLACK);
  tft.setTextSize(2);
  tft.setTextColor(renk, TFT_BLACK);
  tft.setCursor(20, 110);
  tft.println(mesaj);
}

void hataMesajiGoster(const char* mesaj) {
  ekranaMesajYaz(mesaj, TFT_RED);
  hataEkraniGosteriliyor = true;
  hataEkraniBaslangicMs = millis();
  dokunmatikKilit = true;
}

void geciciEkranBaslat(GeciciEkranModu mod, const char* paket = "") {
  geciciEkranModu = mod;
  geciciEkranBaslangicMs = millis();
  bekleyenPaketSecimi[0] = '\0';
  if (paket && paket[0]) {
    strncpy(bekleyenPaketSecimi, paket, sizeof(bekleyenPaketSecimi) - 1);
    bekleyenPaketSecimi[sizeof(bekleyenPaketSecimi) - 1] = '\0';
  }
  dokunmatikKilit = true;

  tft.fillScreen(TFT_BLACK);

  if (mod == GECICI_IPTAL) {
    ekranaMesajYaz("Iptal ediliyor...", TFT_RED);
  }
  else if (mod == GECICI_ISTEK_ILETILIYOR) {
    ekranaMesajYaz("Istek iletiliyor...", TFT_YELLOW);
  }
}

void geciciEkranKontrolEt() {
  if (geciciEkranModu == GECICI_YOK) return;

  if (!currentStatusEquals("waiting")) {
    geciciEkranModu = GECICI_YOK;
    bekleyenPaketSecimi[0] = '\0';
    return;
  }

  unsigned long suAn = millis();

  if (
    geciciEkranModu == GECICI_IPTAL &&
    suAn - geciciEkranBaslangicMs >= IPTAL_EKRANI_MS
  ) {
    iptalIstegiGonder();
    return;
  }

  if (
    geciciEkranModu == GECICI_ISTEK_ILETILIYOR &&
    suAn - geciciEkranBaslangicMs >= ISTEK_ILETILIYOR_EKRANI_MS
  ) {
    geciciEkranModu = GECICI_YOK;

    tft.fillScreen(TFT_BLACK);
    ekranaMesajYaz("Odeme bekleniyor...", TFT_WHITE);

    odemeBekleniyor = true;
    odemeBeklemeBaslangicMs = millis();
    beklemeBaslangicMs = millis();

    bekleyenPaketSecimi[0] = '\0';
    return;
  }
}

// ================= QR =================
static void qrCizimGorevi(esp_qrcode_handle_t qrcode) {
  int qr_size = esp_qrcode_get_size(qrcode);

  int maxQrPx = min(tft.width(), tft.height()) - 20;
  int scale = max(1, maxQrPx / qr_size);
  int qr_size_px = qr_size * scale;

  int offset_x = (tft.width() - qr_size_px) / 2;
  int offset_y = (tft.height() - qr_size_px) / 2;

  tft.fillScreen(TFT_WHITE);

  for (int y = 0; y < qr_size; y++) {
    for (int x = 0; x < qr_size; x++) {
      if (esp_qrcode_get_module(qrcode, x, y)) {
        tft.fillRect(
          offset_x + (x * scale),
          offset_y + (y * scale),
          scale,
          scale,
          TFT_BLACK
        );
      }
    }
  }
}

void ekranaQRCiz(const char* metin) {
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = qrCizimGorevi;
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;

  esp_qrcode_generate(&cfg, metin);
}

// ================= WIFI =================
bool wifiBaglan(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFiManager wm;

  if (!wm.getWiFiIsSaved()) {
    char apName[32] = {0};
    // use last 4 chars of macAdresi (macAdresi is a 12-char hex string)
    const char* macTail = (strlen(macAdresi) > 8) ? &macAdresi[8] : macAdresi;
    snprintf(apName, sizeof(apName), "Qwash-Kurulum-%s", macTail);

    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_YELLOW);
    tft.setTextSize(2);
    tft.setCursor(10, 40);
    tft.println("KURULUM MODU");

    tft.setTextColor(TFT_WHITE);
    tft.setCursor(10, 80);
    tft.println("Telefondan baglanin:");

    tft.setTextColor(TFT_GREEN);
    tft.setCursor(10, 110);
    tft.println(apName);

    tft.setTextColor(TFT_ORANGE);
    tft.setTextSize(1);
    tft.setCursor(10, 150);
    tft.println("Sifre Yok");
    tft.setCursor(10, 180);
    tft.println("Tarayici: 192.168.4.1");

    wm.setConfigPortalTimeout(180);
    bool res = wm.autoConnect(apName);

    if (!res) {
      delay(3000);
      ESP.restart();
      return false;
    }
  } else {
    LOG_PRINTLN(F("WiFi baslatiliyor..."));
    WiFi.mode(WIFI_STA);
    WiFi.begin();

    unsigned long baslangic = millis();

    while (WiFi.status() != WL_CONNECTED && millis() - baslangic < timeoutMs) {
      delay(500);
      watchdogBesle();
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

// ================= NTP =================
bool ntpDene(unsigned long timeoutMs, bool ekranaYaz) {
  configTime(3 * 3600, 0, "pool.ntp.org", "time.nist.gov");

  if (ekranaYaz) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_WHITE);
    tft.setTextSize(2);
    tft.setCursor(20, 100);
    tft.println("Saat Guncelleniyor...");
  }

  LOG_PRINT(F("NTP bekleniyor"));

  unsigned long baslangic = millis();

  while (millis() - baslangic < timeoutMs) {
    watchdogBesle();

    if (sistemSaatiGecerliMi()) {
      LOG_PRINTLN("");
      LOG_PRINTLN(F("Saat guncellendi."));
      saatGecerli = true;
      saatHatasiNedeniyleOffline = false;
      return true;
    }

    delay(500);
    LOG_PRINT(F("."));
  }

  LOG_PRINTLN("");
  LOG_PRINTLN(F("NTP basarisiz. TLS/MQTT baslatilmayacak."));

  saatGecerli = false;
  sonNtpDenemeMs = millis();

  return false;
}

bool ntpBekle(unsigned long timeoutMs = 20000) {
  return ntpDene(timeoutMs, true);
}

bool ntpSessizDene(unsigned long timeoutMs = 10000) {
  return ntpDene(timeoutMs, false);
}

// ================= MQTT =================
void mqttTopicleriHazirla() {
  // Fill fixed-size C-string buffers to avoid heap allocations
  snprintf(mqttClientId, sizeof(mqttClientId), "qwash_esp32_%s", macAdresi);
  snprintf(mqttTopicCommands, sizeof(mqttTopicCommands), "qwash/bays/%s/commands", bayId);
  snprintf(mqttTopicStatus, sizeof(mqttTopicStatus), "qwash/bays/%s/status", bayId);
  snprintf(mqttTopicHeartbeat, sizeof(mqttTopicHeartbeat), "qwash/bays/%s/heartbeat", bayId);
  snprintf(mqttTopicSelection, sizeof(mqttTopicSelection), "qwash/bays/%s/selection", bayId);
  snprintf(mqttTopicEvent, sizeof(mqttTopicEvent), "qwash/bays/%s/event", bayId);
}

// Removed String-based mqttKuyrugaEkle to prefer C-string enqueue helper

bool mqttDurumYayinla() {
  unsigned long suAn = millis();

  if (
    strcmp(currentStatus, sonYayinlananDurum) == 0 &&
    suAn - sonDurumYayinMs < DURUM_YAYIN_DEBOUNCE_MS
  ) {
    LOG_PRINT(F("Durum tekrar yayinlanmadi: "));
    LOG_PRINTLN(currentStatus);
    return true;
  }

  // Use C-string enqueue to avoid temporary String allocations
  bool ok = mqttKuyrugaEkle_cstr(mqttTopicStatus, currentStatus, true);

  if (ok) {
    strncpy(sonYayinlananDurum, currentStatus, sizeof(sonYayinlananDurum)-1);
    sonYayinlananDurum[sizeof(sonYayinlananDurum)-1] = '\0';
    sonDurumYayinMs = suAn;
  }

  return ok;

}

bool mqttHeartbeatYayinla() {
  return mqttKuyrugaEkle_cstr(mqttTopicHeartbeat, "ONLINE", false);
}

// mqttBootYayinla uses C-string enqueue helper
bool mqttBootYayinla() {
  return mqttKuyrugaEkle_cstr(mqttTopicHeartbeat, "BOOT", false);
}

// Removed String-returning mqttJsonEscape to avoid heap allocations.
// Use mqttJsonEscape_cstr() for JSON escaping into fixed buffers instead.

// C-string based helpers to avoid dynamic String allocations
bool mqttYeniEventId_cstr(const char* eventType, char* outBuf, size_t outBufSize) {
  if (!outBuf || outBufSize == 0) return false;
  mqttEventCounter++;
  unsigned long m = millis();
  unsigned int cnt = (unsigned int)mqttEventCounter;
  int written = snprintf(outBuf, outBufSize, "%s_%s_%lu_%u", bayId, eventType, (unsigned long)m, cnt);
  return written > 0 && (size_t)written < outBufSize;
}

// JSON-escape into destination buffer (returns true if fully written)
bool mqttJsonEscape_cstr(const char* src, char* dst, size_t dstSize) {
  if (!src || !dst || dstSize == 0) return false;

  size_t di = 0;
  for (size_t si = 0; src[si] != '\0'; ++si) {
    char c = src[si];
    const char* rep = NULL;
    char repch = '\0';

    if (c == '\\') rep = "\\\\";
    else if (c == '"') rep = "\\\"";
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

// C-string enqueue helper (avoids creating temporary Strings)
bool mqttKuyrugaEkle_cstr(const char* topic, const char* payload, bool retained) {
  if (mqttPublishQueue == NULL) return false;

  MqttPublishJob job;
  memset(&job, 0, sizeof(job));

  // copy safely
  strncpy(job.topic, topic ? topic : "", sizeof(job.topic) - 1);
  strncpy(job.payload, payload ? payload : "", sizeof(job.payload) - 1);
  job.retained = retained;

  bool ok = xQueueSend(mqttPublishQueue, &job, pdMS_TO_TICKS(50)) == pdTRUE;

  if (!ok) {
    LOG_PRINT(F("MQTT kuyruk dolu, mesaj eklenemedi: "));
    LOG_PRINT(topic ? topic : "");
    LOG_PRINT(F(" -> "));
    LOG_PRINTLN(payload ? payload : "");
  }

  return ok;
}

bool mqttSelectionPayloadHazirla_cstr(const char* secilenPaket, char* outBuf, size_t outBufSize) {
  if (!outBuf || outBufSize == 0) return false;

  char eventId[64];
  char escaped[192];

  if (mqttCancelDegeriMi_cstr(secilenPaket)) {
    if (!mqttYeniEventId_cstr("selection_cancel", eventId, sizeof(eventId))) return false;
    if (!mqttJsonEscape_cstr(eventId, escaped, sizeof(escaped))) return false;
    int n = snprintf(outBuf, outBufSize, "{\"type\":\"cancel\",\"eventId\":\"%s\"}", escaped);
    return n > 0 && (size_t)n < outBufSize;
  }

  const char* normalizedPackage = paketNormalizeEt_cstr(secilenPaket);
  const char* packageIdC = normalizedPackage[0] ? normalizedPackage : (secilenPaket ? secilenPaket : "");

  if (!mqttYeniEventId_cstr("selection", eventId, sizeof(eventId))) return false;
  if (!mqttJsonEscape_cstr(packageIdC, escaped, sizeof(escaped))) return false;
  char escapedEvent[192];
  if (!mqttJsonEscape_cstr(eventId, escapedEvent, sizeof(escapedEvent))) return false;

  int n = snprintf(outBuf, outBufSize, "{\"type\":\"selection\",\"packageId\":\"%s\",\"eventId\":\"%s\"}", escaped, escapedEvent);
  return n > 0 && (size_t)n < outBufSize;
}

bool mqttEventPayloadHazirla_cstr(const char* eventMesaji, char* outBuf, size_t outBufSize) {
  if (!outBuf || outBufSize == 0) return false;

  const char* eventType = mqttCancelDegeriMi_cstr(eventMesaji) ? "cancel" : "event";
  char eventId[64];
  char escapedType[64];
  char escapedAction[192];

  if (!mqttYeniEventId_cstr(eventType, eventId, sizeof(eventId))) return false;
  if (!mqttJsonEscape_cstr(eventType, escapedType, sizeof(escapedType))) return false;
  if (!mqttJsonEscape_cstr(eventMesaji ? eventMesaji : "", escapedAction, sizeof(escapedAction))) return false;

  char escapedEvent[192];
  if (!mqttJsonEscape_cstr(eventId, escapedEvent, sizeof(escapedEvent))) return false;

  int n = snprintf(outBuf, outBufSize, "{\"type\":\"%s\",\"action\":\"%s\",\"eventId\":\"%s\"}", escapedType, escapedAction, escapedEvent);
  return n > 0 && (size_t)n < outBufSize;
}


bool mqttSecimYayinla(const char* secilenPaket) {
  char payload[192];
  if (!mqttSelectionPayloadHazirla_cstr(secilenPaket, payload, sizeof(payload))) return false;
  return mqttKuyrugaEkle_cstr(mqttTopicSelection, payload, false);
}

bool mqttEventYayinla(const char* eventMesaji) {
  char payload[192];
  if (!mqttEventPayloadHazirla_cstr(eventMesaji, payload, sizeof(payload))) return false;
  return mqttKuyrugaEkle_cstr(mqttTopicEvent, payload, false);
}

void iptalIstegiGonder() {
  LOG_PRINTLN(F("Kullanici iptal istegi gonderiyor. Backend cevabi beklenecek."));

  geciciEkranModu = GECICI_YOK;
  bekleyenPaketSecimi[0] = '\0';

  odemeBekleniyor = false;
  dokunmatikKilit = true;
  hataEkraniGosteriliyor = false;
  cancelBackendCevabiBekleniyor = true;
  cancelBackendBeklemeBaslangicMs = millis();

  unsigned long suAn = millis();

  if (suAn - sonCancelEventMs >= CANCEL_EVENT_DEBOUNCE_MS) {
    sonCancelEventMs = suAn;

    if (!mqttEventYayinla("CANCEL")) {
      LOG_PRINTLN(F("CANCEL event gonderilemedi, selection fallback deneniyor."));
      mqttSecimYayinla("cancel");
    } else {
      LOG_PRINTLN(F("CANCEL event gonderildi."));
    }
  } else {
    LOG_PRINTLN(F("CANCEL event tekrar gonderilmedi debounce."));
  }

  tft.fillScreen(TFT_BLACK);
  ekranaMesajYaz("Iptal ediliyor...", TFT_RED);
}

void odemeBeklemeIptalEt(const char* sebep) {
  LOG_PRINT(F("Odeme bekleme iptal edildi. Sebep: "));
  LOG_PRINTLN(sebep);

  geciciEkranModu = GECICI_YOK;
  bekleyenPaketSecimi[0] = '\0';

  odemeBekleniyor = false;
  dokunmatikKilit = true;
  hataEkraniGosteriliyor = false;
  cancelBackendCevabiBekleniyor = true;
  cancelBackendBeklemeBaslangicMs = millis();

  requestedPackage[0] = '\0';
  durationSec = 60;

  islemHafizasiniTemizle();

  if (!mqttEventYayinla("CANCEL")) {
    mqttSecimYayinla("cancel");
  }

  tft.fillScreen(TFT_BLACK);
  ekranaMesajYaz("Iptal ediliyor...", TFT_RED);
}

void availableModunaDon(const char* sebep, bool cancelEventGonder) {
  LOG_PRINT(F("AVAILABLE moduna donuluyor. Sebep: "));
  LOG_PRINTLN(sebep);

  geciciEkranModu = GECICI_YOK;
  bekleyenPaketSecimi[0] = '\0';

  odemeBekleniyor = false;
  dokunmatikKilit = false;
  hataEkraniGosteriliyor = false;

  requestedPackage[0] = '\0';
  durationSec = 60;

  islemHafizasiniTemizle();

  setCurrentStatus("available");
  isBayActive = true;
  durumDegisti = true;

  if (cancelEventGonder) {
    unsigned long suAn = millis();

    if (suAn - sonCancelEventMs >= CANCEL_EVENT_DEBOUNCE_MS) {
      sonCancelEventMs = suAn;

      if (!mqttEventYayinla("CANCEL")) {
        LOG_PRINTLN(F("CANCEL event gonderilemedi, eski selection fallback deneniyor."));
        mqttSecimYayinla("cancel");
      } else {
        LOG_PRINTLN(F("CANCEL event gonderildi."));
      }
    } else {
      LOG_PRINTLN(F("CANCEL event tekrar gonderilmedi debounce."));
    }
  }

  mqttDurumYayinla();
}

void mqttKomutUygula(const char* komut) {
  LOG_PRINT(F("MQTT Komut: "));
  LOG_PRINTLN(komut);

  if (strcmp(komut, "AVAILABLE") == 0) {
    saatHatasiNedeniyleOffline = false;
    cancelBackendCevabiBekleniyor = false;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    hataEkraniGosteriliyor = false;
    geciciEkranModu = GECICI_YOK;
    bekleyenPaketSecimi[0] = '\0';

    if (currentStatusEquals("available")) {
      LOG_PRINTLN(F("AVAILABLE zaten aktif, tekrar islenmedi."));
      durumDegisti = true;
      return;
    }

    setCurrentStatus("available");
    isBayActive = true;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (strcmp(komut, "WAITING") == 0) {
    saatHatasiNedeniyleOffline = false;
    cancelBackendCevabiBekleniyor = false;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    hataEkraniGosteriliyor = false;
    geciciEkranModu = GECICI_YOK;
    bekleyenPaketSecimi[0] = '\0';

    setCurrentStatus("waiting");
    isBayActive = true;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (strcmp(komut, "OFFLINE") == 0) {
    saatHatasiNedeniyleOffline = false;
    setCurrentStatus("offline");
    isBayActive = false;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (strcmp(komut, "MAINTENANCE") == 0) {
    saatHatasiNedeniyleOffline = false;
    setCurrentStatus("maintenance");
    isBayActive = true;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (strcmp(komut, "ACTIVE_ON") == 0) {
    saatHatasiNedeniyleOffline = false;
    isBayActive = true;

    if (currentStatusEquals("offline")) {
      setCurrentStatus("available");
    }

    durumDegisti = true;
  }
  else if (strcmp(komut, "ACTIVE_OFF") == 0) {
    saatHatasiNedeniyleOffline = false;
    setCurrentStatus("offline");
    isBayActive = false;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (strcmp(komut, "RESET") == 0) {
    ESP.restart();
  } else {
    // Check BUSY|<package>|<duration>
    if (strncmp(komut, "BUSY|", 5) == 0) {
      const char* firstSep = strchr(komut, '|');
      const char* secondSep = firstSep ? strchr(firstSep + 1, '|') : NULL;

      if (firstSep && secondSep && secondSep > firstSep + 1) {
        char gelenPaketBuf[32] = {0};
        size_t len = (size_t)(secondSep - (firstSep + 1));
        if (len >= sizeof(gelenPaketBuf)) len = sizeof(gelenPaketBuf) - 1;
        memcpy(gelenPaketBuf, firstSep + 1, len);
        gelenPaketBuf[len] = '\0';

        int gelenSure = atoi(secondSep + 1);

        if (!durationGecerliMi(gelenSure)) {
          mqttSecimYayinla("invalid_duration");
          return;
        }

        const char* normalizedPackage = paketNormalizeEt_cstr(gelenPaketBuf);

        if (normalizedPackage[0] == '\0') {
          mqttSecimYayinla("invalid_package");
          return;
        }

        saatHatasiNedeniyleOffline = false;
        strncpy(requestedPackage, normalizedPackage, sizeof(requestedPackage)-1);
        requestedPackage[sizeof(requestedPackage)-1] = '\0';
        durationSec = gelenSure;

        cancelBackendCevabiBekleniyor = false;
        odemeBekleniyor = false;
        hataEkraniGosteriliyor = false;
        geciciEkranModu = GECICI_YOK;
        bekleyenPaketSecimi[0] = '\0';

        islemBaslangicMs = 0;
        islemSuresiMs = 0;
        resetSayacDurumu();
        yeniBusyKomutuGeldi = true;
        setCurrentStatus("busy");
        isBayActive = true;
        odemeBekleniyor = false;
        dokunmatikKilit = true;
        durumDegisti = true;
      }
    }

  }

  mqttDurumYayinla();
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (length == 0 || length > 120) return;

  char mesaj[121];

  for (unsigned int i = 0; i < length; i++) {
    mesaj[i] = (char)payload[i];
  }

  mesaj[length] = '\0';

  char* baslangic = mesaj;
  while (*baslangic == ' ' || *baslangic == '\t' || *baslangic == '\r' || *baslangic == '\n') {
    baslangic++;
  }

  char* bitis = baslangic + strlen(baslangic);

  while (
    bitis > baslangic &&
    (
      *(bitis - 1) == ' ' ||
      *(bitis - 1) == '\t' ||
      *(bitis - 1) == '\r' ||
      *(bitis - 1) == '\n'
    )
  ) {
    bitis--;
  }

  *bitis = '\0';

  if (baslangic[0] == '\0') return;

  mqttKomutUygula(baslangic);
}

bool mqttBaglan() {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  // KRITIK KORUMA:
  // TLS sertifika dogrulamasi icin sistem saati gecersizse MQTT denenmez.
  if (!sistemSaatiGecerliMi()) {
    saatGecerli = false;

    if (millis() - sonNtpDenemeMs >= NTP_RETRY_INTERVAL_MS) {
      sonNtpDenemeMs = millis();
      LOG_PRINTLN(F("MQTT oncesi saat gecersiz. NTP tekrar deneniyor."));
      ntpSessizDene(10000);
    }

    return false;
  }

  saatGecerli = true;

  if (saatHatasiNedeniyleOffline) {
    LOG_PRINTLN(F("Saat gecerli oldu. NTP kaynakli offline temizleniyor."));
    saatHatasiNedeniyleOffline = false;

    if (currentStatusEquals("offline")) {
      setCurrentStatus("baslangic");
      isBayActive = true;
      durumDegisti = true;
    }
  }

  if (mqttClient.connected()) {
    return true;
  }

  if (millis() - sonMqttDenemeMs < MQTT_RETRY_INTERVAL_MS) {
    return false;
  }

  sonMqttDenemeMs = millis();

  heapYaz("MQTT baslangic");

  IPAddress mqttIp;
  if (!WiFi.hostByName(MQTT_HOST, mqttIp)) {
    LOG_PRINTLN(F("MQTT DNS cozulemedi."));
    return false;
  }

  LOG_PRINT(F("MQTT IP: "));
  LOG_PRINTLN(mqttIp);

  mqttSecureClient.stop();
  delay(100);

  mqttSecureClient.setCACert(root_ca);
  mqttSecureClient.setTimeout(3000);
  mqttSecureClient.setHandshakeTimeout(5);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  // Increase buffer to safely fit topic + payload (avoid silent drops)
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(30);
  mqttClient.setSocketTimeout(3);

  heapYaz("MQTT connect oncesi");

  LOG_PRINTLN(F("MQTT baglaniliyor..."));

  bool baglandi = mqttClient.connect(
    mqttClientId,
    MQTT_USER,
    MQTT_PASS,
    mqttTopicStatus,
    1,
    true,
    "offline"
  );

  heapYaz("MQTT connect sonrasi");

  if (baglandi) {
    LOG_PRINTLN(F("MQTT baglandi."));

    mqttClient.subscribe(mqttTopicCommands, 1);

    if (!ilkMqttBaglantiTamamlandi) {
      if (currentStatusEquals("baslangic") || currentStatus[0] == '\0') {
        setCurrentStatus("available");
        isBayActive = true;
        islemHafizasiniTemizle();
        durumDegisti = true;
      }

      mqttBootYayinla();
      ilkMqttBaglantiTamamlandi = true;
    }

    mqttDurumYayinla();
    mqttHeartbeatYayinla();

    return true;
  }

  LOG_PRINT(F("MQTT hata kodu: "));
  LOG_PRINTLN(mqttClient.state());

  mqttSecureClient.stop();

  return false;
}

void mqttBaglantiTask(void* parameter) {
  watchdogCurrentTaskKaydet("mqttBaglantiTask");

  MqttPublishJob job;

  for (;;) {
    watchdogBesle();

    if (WiFi.status() == WL_CONNECTED) {
      if (!mqttClient.connected()) {
        mqttBaglan();
      }

      if (mqttClient.connected()) {
        mqttClient.loop();

        while (xQueueReceive(mqttPublishQueue, &job, 0) == pdTRUE) {
          bool ok = mqttClient.publish(
            job.topic,
            job.payload,
            job.retained
          );

          if (!ok) {
            LOG_PRINT(F("MQTT publish basarisiz: "));
            LOG_PRINT(job.topic);
            LOG_PRINT(F(" -> "));
            LOG_PRINTLN(job.payload);
          }
        }
      }
    }

    watchdogBesle();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void wifiNonBlockingKontrolEt() {
  wl_status_t wifiStatus = WiFi.status();

  if (wifiStatus == WL_CONNECTED) {
    if (!wifiWasConnected) {
      LOG_PRINTLN(F("WiFi yeniden baglandi."));
      LOG_PRINT(F("WiFi IP: "));
      LOG_PRINTLN(WiFi.localIP());

      wifiWasConnected = true;
      wifiReconnectInProgress = false;
      sonWifiDenemeMs = millis();

      // WiFi geri gelince once saat tekrar kontrol edilsin.
      saatGecerli = sistemSaatiGecerliMi();

      if (!saatGecerli) {
        sonNtpDenemeMs = 0;
      }

      // WiFi geri gelince MQTT task ilk firsatta yeniden denesin.
      sonMqttDenemeMs = 0;

      durumDegisti = true;
    }

    return;
  }

  if (wifiWasConnected) {
    LOG_PRINTLN(F("WiFi baglantisi koptu."));

    wifiWasConnected = false;

    if (!currentStatusEquals("busy")) {
      durumDegisti = true;
    }
  }

  if (!wifiReconnectInProgress) {
    if (millis() - sonWifiDenemeMs >= WIFI_RETRY_INTERVAL_MS) {
      sonWifiDenemeMs = millis();
      wifiReconnectStartedMs = millis();
      wifiReconnectInProgress = true;

      LOG_PRINTLN(F("WiFi non-blocking reconnect baslatiliyor..."));

      WiFi.disconnect(false);
      WiFi.reconnect();
    }

    return;
  }

  if (millis() - wifiReconnectStartedMs >= WIFI_RECONNECT_TIMEOUT_MS) {
    LOG_PRINTLN(F("WiFi reconnect timeout, tekrar denenecek."));

    wifiReconnectInProgress = false;
    sonWifiDenemeMs = millis();

    WiFi.disconnect(false);
  }
}

// ================= SAYAC =================
void ekrandaSayaciGuncelle() {
  unsigned long suAnMs = millis();

  if (islemSuresiMs == 0) {
    return;
  }

  unsigned long gecenMs = suAnMs - islemBaslangicMs;

  if (gecenMs < islemSuresiMs) {
    unsigned long kalanMs = islemSuresiMs - gecenMs;
    unsigned long kalanSaniye = (kalanMs + 999) / 1000;

    int saniye = kalanSaniye % 60;
    int dakika = kalanSaniye / 60;

    if (kalanSaniye >= 10) {
      if ((int)kalanSaniye != sayacSonEkranSaniye) {
        tone(buzzerPin, 2000, 100);
      }
    } else {
      if (suAnMs - sayacSonYarimSaniyeMs >= 500) {
        tone(buzzerPin, 2500, 100);
        sayacSonYarimSaniyeMs = suAnMs;
      }
    }

    if ((int)kalanSaniye != sayacSonEkranSaniye) {
      tft.setTextColor(TFT_YELLOW, TFT_BLACK);
      tft.setTextSize(5);
      tft.setCursor(80, 120);
      tft.printf("%02d:%02d   ", dakika, saniye);
      sayacSonEkranSaniye = kalanSaniye;
    }

    sayacIslemBittiCalindi = false;
  } else if (!sayacIslemBittiCalindi) {
    tone(buzzerPin, 1000, 3000);

    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED);
    tft.setTextSize(3);
    tft.setCursor(40, 110);
    tft.println("ISLEM BITTI");

    sayacIslemBittiCalindi = true;

    islemBaslangicMs = 0;
    islemSuresiMs = 0;

    setCurrentStatus("waiting");
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    durumDegisti = true;
    mqttDurumYayinla();
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(500);

  watchdogBaslat();

  // requestedPackage is now a fixed buffer
  // bayId and macAdresi are fixed buffers now; no reserve()
  mqttClientId[0] = '\0';
  mqttTopicCommands[0] = '\0';
  mqttTopicStatus[0] = '\0';
  mqttTopicHeartbeat[0] = '\0';
  mqttTopicSelection[0] = '\0';
  mqttTopicEvent[0] = '\0';
  // bekleyenPaketSecimi will be converted to C-string later

  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);

  pinMode(btnKopukPin, INPUT_PULLUP);

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

snprintf(
  macAdresi,
  sizeof(macAdresi),
  "%02X%02X%02X%02X%02X%02X",
  macBytes[0],
  macBytes[1],
  macBytes[2],
  macBytes[3],
  macBytes[4],
  macBytes[5]
);

if (strcmp(macAdresi, "000000000000") == 0 || strlen(macAdresi) != 12) {
  LOG_PRINTLN(F("MAC okunamadi, cihaz yeniden baslatiliyor."));
  delay(1000);
  ESP.restart();
}

snprintf(bayId, sizeof(bayId), "bay_%s", macAdresi);

  mqttTopicleriHazirla();

  if (mqttPublishQueue == NULL) {
    mqttPublishQueue = xQueueCreate(20, sizeof(MqttPublishJob));
  }

  if (!mqttTaskBaslatildi && mqttPublishQueue != NULL) {
    xTaskCreatePinnedToCore(
      mqttBaglantiTask,
      "mqttBaglantiTask",
      8192,
      NULL,
      1,
      &mqttTaskHandle,
      0
    );

    mqttTaskBaslatildi = true;
  }

  if (!wifiBaglan(WIFI_TIMEOUT_MS)) {
    setCurrentStatus("offline");
    isBayActive = false;
    saatHatasiNedeniyleOffline = false;
    ekranaBaglantiHatasiYaz();
    sonWifiDenemeMs = millis();
    watchdogLoopTaskKaydet();
    return;
  }

  wifiWasConnected = true;
  wifiReconnectInProgress = false;

  if (!ntpBekle()) {
    setCurrentStatus("offline");
    isBayActive = false;
    saatHatasiNedeniyleOffline = true;
    ekranaSaatHatasiYaz();
    durumDegisti = true;

    wifiWasConnected = WiFi.status() == WL_CONNECTED;
    sonNabizZamani = millis();

    watchdogLoopTaskKaydet();
    return;
  }

  wifiWasConnected = WiFi.status() == WL_CONNECTED;

  sonNabizZamani = millis();
  durumDegisti = true;

  watchdogLoopTaskKaydet();
}

// ================= LOOP =================
void loop() {
  watchdogBesle();

  static char eskiDurum[32] = {0};

  wifiNonBlockingKontrolEt();

  if (WiFi.status() != WL_CONNECTED) {
    if (!currentStatusEquals("busy") && !hataEkraniGosteriliyor && durumDegisti) {
      ekranaBaglantiHatasiYaz();
      durumDegisti = false;
    }
  }

  geciciEkranKontrolEt();
  if (geciciEkranModu != GECICI_YOK) {
    return;
  }

  if (
    cancelBackendCevabiBekleniyor &&
    millis() - cancelBackendBeklemeBaslangicMs >= CANCEL_BACKEND_TIMEOUT_MS
  ) {
    LOG_PRINTLN(F("CANCEL backend cevabi gelmedi, lokal AVAILABLE moduna geciliyor."));

    cancelBackendCevabiBekleniyor = false;
    dokunmatikKilit = false;
    odemeBekleniyor = false;
    hataEkraniGosteriliyor = false;
    geciciEkranModu = GECICI_YOK;
    bekleyenPaketSecimi[0] = '\0';

    setCurrentStatus("available");
    isBayActive = true;
    islemHafizasiniTemizle();
    durumDegisti = true;

    mqttDurumYayinla();
  }

  if (millis() - sonNabizZamani >= nabizAraligi) {
    sonNabizZamani = millis();
    mqttHeartbeatYayinla();
  }

  if (hataEkraniGosteriliyor) {
    if (millis() - hataEkraniBaslangicMs >= 2000) {
      hataEkraniGosteriliyor = false;
      dokunmatikKilit = false;
      durumDegisti = true;
    }

    return;
  }

  if (!isBayActive || currentStatusEquals("offline")) {
    if (durumDegisti) {
      durumDegisti = false;
      strncpy(eskiDurum, currentStatus, sizeof(eskiDurum)-1); eskiDurum[sizeof(eskiDurum)-1] = '\0';

      if (mqttClient.connected()) {
        mqttDurumYayinla();
      }

      if (saatHatasiNedeniyleOffline) {
        ekranaSaatHatasiYaz();
      } else {
        ekranaKapaliYaz();
      }

      LOG_PRINTLN(F("KAPALI"));
    }

    return;
  }

  if (durumDegisti) {
    durumDegisti = false;

    LOG_PRINT(F("DURUM: "));
    LOG_PRINTLN(currentStatus);

    mqttDurumYayinla();

    if (currentStatusEquals("available")) {
      dokunmatikKilit = false;
      odemeBekleniyor = false;
      islemHafizasiniTemizle();
      ekranaQRCiz(bayId);
    }
    else if (currentStatusEquals("maintenance")) {
      dokunmatikKilit = false;
      odemeBekleniyor = false;
      islemHafizasiniTemizle();

      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_ORANGE, TFT_BLACK);
      tft.setTextSize(3);
      tft.setCursor(40, 100);
      tft.println("BAKIM MODU");
    }
    else if (currentStatusEquals("waiting")) {
      dokunmatikKilit = false;
      odemeBekleniyor = false;
      islemHafizasiniTemizle();
      ekranaWaitingCiz();
    }
    else if (currentStatusEquals("busy")) {
      dokunmatikKilit = true;
      odemeBekleniyor = false;

      tft.fillScreen(TFT_BLACK);
      tft.setTextSize(3);
      tft.setTextColor(TFT_GREEN, TFT_BLACK);
      tft.setCursor(30, 40);

      if (strcmp(requestedPackage, "foam") == 0) {
        tft.println("KOPUK MODU");
      } else {
        tft.println("SU MODU");
      }

      if (strcmp(eskiDurum, "busy") != 0 || yeniBusyKomutuGeldi) {
        islemBaslangicMs = millis();
        islemSuresiMs = durationSec * 1000UL;
        yeniBusyKomutuGeldi = false;

        LOG_PRINT(F("MQTT sure baslatildi. Paket: "));
        LOG_PRINT(requestedPackage);
        LOG_PRINT(F(" Sure: "));
        LOG_PRINTLN(durationSec);

        resetSayacDurumu();
      }
    }
    else if (currentStatusEquals("baslangic")) {
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_WHITE);
      tft.setTextSize(2);
      tft.setCursor(20, 100);
      tft.println("Durum Aliniyor...");
    }
    else {
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_RED);
      tft.setTextSize(2);
      tft.setCursor(20, 100);
      tft.println("Bilinmeyen Durum");
    }

    strncpy(eskiDurum, currentStatus, sizeof(eskiDurum)-1); eskiDurum[sizeof(eskiDurum)-1] = '\0';
  }

  if (currentStatusEquals("busy")) {
    ekrandaSayaciGuncelle();
  }
  else if (currentStatusEquals("waiting") && !dokunmatikKilit && !odemeBekleniyor) {
    unsigned long gecenZaman = millis() - beklemeBaslangicMs;

    if (gecenZaman >= BEKLEME_SURESI_MS) {
      availableModunaDon("waiting_timeout", false);
      return;
    }

    int maxGenislik = 280;
    int guncelGenislik = map(
      gecenZaman,
      0,
      BEKLEME_SURESI_MS,
      maxGenislik,
      0
    );

    if (guncelGenislik != sonSeritGenisligi) {
      tft.fillRect(20, 185, guncelGenislik, 8, TFT_GREEN);

      if (maxGenislik > guncelGenislik) {
        tft.fillRect(
          20 + guncelGenislik,
          185,
          maxGenislik - guncelGenislik,
          8,
          TFT_BLACK
        );
      }

      sonSeritGenisligi = guncelGenislik;
    }
  }

  if (currentStatusEquals("waiting") && !dokunmatikKilit && !hataEkraniGosteriliyor) {
    char secilenPaket[16] = {0};

    bool kopukButonDurumu = digitalRead(btnKopukPin);

    if (
      kopukButonDurumu == LOW &&
      oncekiKopukButonDurumu == HIGH &&
      millis() - sonKopukButonMs > BUTON_DEBOUNCE_MS
    ) {
      sonKopukButonMs = millis();
      strncpy(secilenPaket, "foam", sizeof(secilenPaket)-1);
    }

    oncekiKopukButonDurumu = kopukButonDurumu;

    if (secilenPaket[0] == '\0') {
      uint16_t x, y;

      if (tft.getTouch(&x, &y)) {
if (
  dokunmaButonIcindeMi(
    x,
    y,
    BTN_IPTAL.x1,
    BTN_IPTAL.y1,
    BTN_IPTAL.x2,
    BTN_IPTAL.y2
  )
) {
  strncpy(secilenPaket, "cancel", sizeof(secilenPaket) - 1);
}
else if (
  dokunmaButonIcindeMi(
    x,
    y,
    BTN_KOPUK.x1,
    BTN_KOPUK.y1,
    BTN_KOPUK.x2,
    BTN_KOPUK.y2
  )
) {
  strncpy(secilenPaket, "foam", sizeof(secilenPaket) - 1);
}
else if (
  dokunmaButonIcindeMi(
    x,
    y,
    BTN_SU.x1,
    BTN_SU.y1,
    BTN_SU.x2,
    BTN_SU.y2
  )
) {
  strncpy(secilenPaket, "wash", sizeof(secilenPaket) - 1);
}
      }
    }

    if (secilenPaket[0] != '\0') {
      if (strcmp(secilenPaket, "cancel") == 0) {
        geciciEkranBaslat(GECICI_IPTAL);
        return;
      }

      if (!mqttSecimYayinla(secilenPaket)) {
        hataMesajiGoster("Baglanti yok");
        return;
      }

      geciciEkranBaslat(GECICI_ISTEK_ILETILIYOR, secilenPaket);
      return;
    }
  }

  if (odemeBekleniyor && currentStatusEquals("waiting")) {
    if (millis() - odemeBeklemeBaslangicMs >= ODEME_BEKLEME_TIMEOUT_MS) {
      odemeBeklemeIptalEt("odeme_timeout");
      return;
    }
  }
}

// C-string variant of paketNormalizeEt
const char* paketNormalizeEt_cstr(const char* paket) {
  if (!paket) return "";
  // simple case-insensitive checks
  auto eqi = [](const char* a, const char* b) {
    for (; *a && *b; ++a, ++b) {
      char ca = *a; if (ca >= 'A' && ca <= 'Z') ca += 'a' - 'A';
      char cb = *b; if (cb >= 'A' && cb <= 'Z') cb += 'a' - 'A';
      if (ca != cb) return false;
    }
    return *a == '\0' && *b == '\0';
  };

  if (eqi(paket, "foam") || eqi(paket, "kopuk") || eqi(paket, "köpük") || eqi(paket, "kopup")) return "foam";
  if (eqi(paket, "wash") || eqi(paket, "su") || eqi(paket, "water") || eqi(paket, "yikama") || eqi(paket, "yıkama")) return "wash";
  return "";
}

// C-string variant of cancel value check
bool mqttCancelDegeriMi_cstr(const char* value) {
  if (!value) return false;
  auto eqiToken = [](const char* a, const char* b) {
    for (; *a && *b; ++a, ++b) {
      char ca = *a; if (ca >= 'A' && ca <= 'Z') ca += 'a' - 'A';
      char cb = *b; if (cb >= 'A' && cb <= 'Z') cb += 'a' - 'A';
      if (ca != cb) return false;
    }
    return *a == '\0' && *b == '\0';
  };

  if (eqiToken(value, "cancel")) return true;
  if (eqiToken(value, "cancelled")) return true;
  if (eqiToken(value, "canceled")) return true;
  if (eqiToken(value, "iptal")) return true;
  if (eqiToken(value, "abort")) return true;
  if (eqiToken(value, "stop")) return true;
  if (eqiToken(value, "back")) return true;
  if (eqiToken(value, "geri")) return true;
  return false;
}

// Helpers for currentStatus handling (C-strings)
void setCurrentStatus(const char* s) {
  if (!s) s = "";
  strncpy(currentStatus, s, sizeof(currentStatus)-1);
  currentStatus[sizeof(currentStatus)-1] = '\0';
  durumDegisti = true;
}

bool currentStatusEquals(const char* s) {
  if (!s) s = "";
  return strcmp(currentStatus, s) == 0;
}