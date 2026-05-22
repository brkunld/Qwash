#include <WiFi.h>
#include <FS.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <WiFiManager.h>

#include <WiFiClientSecure.h>
#include <PubSubClient.h>

#include <TFT_eSPI.h>
#include <Preferences.h>
#include <time.h>

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

// ================= EKRAN =================
TFT_eSPI tft = TFT_eSPI();

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

bool dokunmaButonIcindeMi(uint16_t x, uint16_t y, const TouchButton& button) {
  return (
    x >= button.x1 &&
    x <= button.x2 &&
    y >= button.y1 &&
    y <= button.y2
  );
}

// ================= MQTT =================
WiFiClientSecure mqttSecureClient;
PubSubClient mqttClient(mqttSecureClient);

String mqttClientId = "";
String mqttTopicCommands = "";
String mqttTopicStatus = "";
String mqttTopicHeartbeat = "";
String mqttTopicSelection = "";
String mqttTopicEvent = "";

unsigned long sonMqttDenemeMs = 0;
const unsigned long MQTT_RETRY_INTERVAL_MS = 5000;
bool ilkMqttBaglantiTamamlandi = false;

// ================= HAFIZA / ZAMAN =================
Preferences preferences;
unsigned long islemBaslangicMs = 0;
unsigned long islemSuresiMs = 0;
unsigned long sonNvsKayitMs = 0;
unsigned long sonKaydedilenKalanSure = 999999;

const unsigned long NVS_KAYIT_INTERVAL_MS = 60000;

// ================= PINLER =================
const int buzzerPin = 25;
const int btnKopukPin = 32;

// ================= PERON =================
String bayId = "";
String macAdresi = "";
String currentStatus = "baslangic";
bool isBayActive = true;
String requestedPackage = "";
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
const unsigned long ODEME_BEKLEME_TIMEOUT_MS = 60000;
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
String bekleyenPaketSecimi = "";

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
// ================= YARDIMCI =================
void resetSayacDurumu() {
  sayacSonEkranSaniye = -1;
  sayacSonYarimSaniyeMs = 0;
  sayacIslemBittiCalindi = false;
}

void kalanSureKaydet(unsigned long kalanSure) {
  if (kalanSure == sonKaydedilenKalanSure) {
    return;
  }

  preferences.putULong("kalanSure", kalanSure);
  sonKaydedilenKalanSure = kalanSure;
  sonNvsKayitMs = millis();
}

bool durationGecerliMi(int gelenSure) {
  if (gelenSure < MIN_DURATION_SEC || gelenSure > MAX_DURATION_SEC) {
    LOG_PRINT(F("Gecersiz durationSec: "));
    LOG_PRINTLN(gelenSure);
    return false;
  }

  return true;
}

String paketNormalizeEt(const String& paket) {
  String temizPaket = paket;
  temizPaket.trim();
  temizPaket.toLowerCase();

  if (
    temizPaket == "foam" ||
    temizPaket == "kopuk" ||
    temizPaket == "köpük" ||
    temizPaket == "kopup"
  ) {
    return "foam";
  }

  if (
    temizPaket == "wash" ||
    temizPaket == "su" ||
    temizPaket == "water" ||
    temizPaket == "yikama" ||
    temizPaket == "yıkama"
  ) {
    return "wash";
  }

  return temizPaket;
}

void islemHafizasiniTemizle() {
  islemBaslangicMs = 0;
  islemSuresiMs = 0;
  kalanSureKaydet(0);
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

void geciciEkranBaslat(GeciciEkranModu mod, const String& paket = "") {
  geciciEkranModu = mod;
  geciciEkranBaslangicMs = millis();
  bekleyenPaketSecimi = paket;
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

  if (currentStatus != "waiting") {
    geciciEkranModu = GECICI_YOK;
    bekleyenPaketSecimi = "";
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

    bekleyenPaketSecimi = "";
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

void ekranaQRCiz(const String& metin) {
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = qrCizimGorevi;
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;

  esp_qrcode_generate(&cfg, metin.c_str());
}

// ================= WIFI =================
bool wifiBaglan(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFiManager wm;

  if (!wm.getWiFiIsSaved()) {
    String apName = "Qwash-Kurulum-" + macAdresi.substring(8);

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
    bool res = wm.autoConnect(apName.c_str());

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
void ntpBekle() {
  configTime(3 * 3600, 0, "pool.ntp.org", "time.nist.gov");

  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE);
  tft.setTextSize(2);
  tft.setCursor(20, 100);
  tft.println("Saat Guncelleniyor...");

  LOG_PRINT(F("NTP bekleniyor"));

  time_t suAn;
  time(&suAn);

  unsigned long baslangic = millis();

  while (suAn < 100000 && millis() - baslangic < 20000) {
    delay(500);
    LOG_PRINT(F("."));
    time(&suAn);
  }

  LOG_PRINTLN("");

  if (suAn < 100000) {
    LOG_PRINTLN(F("NTP basarisiz, devam ediliyor."));
  } else {
    LOG_PRINTLN(F("Saat guncellendi."));
  }
}

// ================= MQTT =================
void mqttTopicleriHazirla() {
  mqttClientId = "qwash_esp32_" + macAdresi;

  mqttTopicCommands = "qwash/bays/" + bayId + "/commands";
  mqttTopicStatus = "qwash/bays/" + bayId + "/status";
  mqttTopicHeartbeat = "qwash/bays/" + bayId + "/heartbeat";
  mqttTopicSelection = "qwash/bays/" + bayId + "/selection";
  mqttTopicEvent = "qwash/bays/" + bayId + "/event";
}

bool mqttDurumYayinla() {
  if (!mqttClient.connected()) return false;

  return mqttClient.publish(
    mqttTopicStatus.c_str(),
    currentStatus.c_str(),
    true
  );
}

bool mqttHeartbeatYayinla() {
  if (!mqttClient.connected()) return false;

  return mqttClient.publish(
    mqttTopicHeartbeat.c_str(),
    "ONLINE",
    false
  );
}

bool mqttBootYayinla() {
  if (!mqttClient.connected()) return false;

  return mqttClient.publish(
    mqttTopicHeartbeat.c_str(),
    "BOOT",
    false
  );
}

bool mqttSecimYayinla(const String& secilenPaket) {
  if (!mqttClient.connected()) {
    return false;
  }

  return mqttClient.publish(
    mqttTopicSelection.c_str(),
    secilenPaket.c_str(),
    false
  );
}
bool mqttEventYayinla(const String& eventMesaji) {
  if (!mqttClient.connected()) {
    return false;
  }

  return mqttClient.publish(
    mqttTopicEvent.c_str(),
    eventMesaji.c_str(),
    false
  );
}

void iptalIstegiGonder() {
  LOG_PRINTLN(F("Kullanici iptal istegi gonderiyor. Backend cevabi beklenecek."));

  geciciEkranModu = GECICI_YOK;
  bekleyenPaketSecimi = "";

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

void availableModunaDon(const char* sebep, bool cancelEventGonder) {
  LOG_PRINT(F("AVAILABLE moduna donuluyor. Sebep: "));
  LOG_PRINTLN(sebep);

  geciciEkranModu = GECICI_YOK;
  bekleyenPaketSecimi = "";

  odemeBekleniyor = false;
  dokunmatikKilit = false;
  hataEkraniGosteriliyor = false;

  requestedPackage = "";
  durationSec = 60;

  islemHafizasiniTemizle();

  currentStatus = "available";
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

void mqttKomutUygula(const String& komut) {
  LOG_PRINT(F("MQTT Komut: "));
  LOG_PRINTLN(komut);

if (komut == "AVAILABLE") {
  cancelBackendCevabiBekleniyor = false;

  if (currentStatus == "available" && !odemeBekleniyor) {
    LOG_PRINTLN(F("AVAILABLE zaten aktif, tekrar islenmedi."));
    dokunmatikKilit = false;
    return;
  }

  currentStatus = "available";
  isBayActive = true;
  odemeBekleniyor = false;
  dokunmatikKilit = false;
  hataEkraniGosteriliyor = false;
  geciciEkranModu = GECICI_YOK;
  bekleyenPaketSecimi = "";
  islemHafizasiniTemizle();
  durumDegisti = true;
}
  else if (komut == "WAITING") {
    cancelBackendCevabiBekleniyor = false;
    currentStatus = "waiting";
    isBayActive = true;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (komut == "OFFLINE") {
    currentStatus = "offline";
    isBayActive = false;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (komut == "MAINTENANCE") {
    currentStatus = "maintenance";
    isBayActive = true;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (komut == "ACTIVE_ON") {
    isBayActive = true;

    if (currentStatus == "offline") {
      currentStatus = "available";
    }

    durumDegisti = true;
  }
  else if (komut == "ACTIVE_OFF") {
    currentStatus = "offline";
    isBayActive = false;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (komut == "RESET") {
    ESP.restart();
  }
  else if (komut.startsWith("BUSY|")) {
    int firstSep = komut.indexOf('|');
    int secondSep = komut.indexOf('|', firstSep + 1);

    if (firstSep > 0 && secondSep > firstSep) {
      String gelenPaket = komut.substring(firstSep + 1, secondSep);
      int gelenSure = komut.substring(secondSep + 1).toInt();

      if (!durationGecerliMi(gelenSure)) {
        mqttSecimYayinla("invalid_duration");
        return;
      }

      requestedPackage = paketNormalizeEt(gelenPaket);
      durationSec = gelenSure;

      kalanSureKaydet(0);
      islemBaslangicMs = 0;
      islemSuresiMs = 0;
      resetSayacDurumu();
      yeniBusyKomutuGeldi = true;
      currentStatus = "busy";
      isBayActive = true;
      odemeBekleniyor = false;
      dokunmatikKilit = true;
      durumDegisti = true;
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

  mqttKomutUygula(String(baslangic));
}

bool mqttBaglan() {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
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
  mqttSecureClient.setTimeout(20000);
  mqttSecureClient.setHandshakeTimeout(30);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(256);
  mqttClient.setKeepAlive(30);
  mqttClient.setSocketTimeout(20);

  heapYaz("MQTT connect oncesi");

  LOG_PRINTLN(F("MQTT baglaniliyor..."));

  bool baglandi = mqttClient.connect(
    mqttClientId.c_str(),
    MQTT_USER,
    MQTT_PASS,
    mqttTopicStatus.c_str(),
    1,
    true,
    "offline"
  );

  heapYaz("MQTT connect sonrasi");

  if (baglandi) {
    LOG_PRINTLN(F("MQTT baglandi."));

    mqttClient.subscribe(mqttTopicCommands.c_str(), 1);

    if (!ilkMqttBaglantiTamamlandi) {
      if (currentStatus == "baslangic" || currentStatus == "") {
        currentStatus = "available";
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

      mqttBaglan();

      durumDegisti = true;
    }

    return;
  }

  if (wifiWasConnected) {
    LOG_PRINTLN(F("WiFi baglantisi koptu."));

    wifiWasConnected = false;

    if (currentStatus != "busy") {
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

    if (suAnMs - sonNvsKayitMs >= NVS_KAYIT_INTERVAL_MS) {
      kalanSureKaydet(kalanSaniye);
    }

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

    kalanSureKaydet(0);
    islemBaslangicMs = 0;
    islemSuresiMs = 0;

    currentStatus = "waiting";
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

  currentStatus.reserve(16);
  requestedPackage.reserve(16);
  bayId.reserve(32);
  macAdresi.reserve(16);
  mqttClientId.reserve(48);
  mqttTopicCommands.reserve(64);
  mqttTopicStatus.reserve(64);
  mqttTopicHeartbeat.reserve(64);
  mqttTopicSelection.reserve(64);
  mqttTopicEvent.reserve(64);
  bekleyenPaketSecimi.reserve(16);

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

  String rawMac = WiFi.macAddress();

  while (rawMac == "00:00:00:00:00:00" || rawMac == "") {
    delay(100);
    rawMac = WiFi.macAddress();
  }

  rawMac.replace(":", "");
  macAdresi = rawMac;
  bayId = "bay_" + macAdresi;

  mqttTopicleriHazirla();

  preferences.begin("qwash", false);
  sonKaydedilenKalanSure = preferences.getULong("kalanSure", 0);

  if (!wifiBaglan(WIFI_TIMEOUT_MS)) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    sonWifiDenemeMs = millis();
    return;
  }

  wifiWasConnected = true;
  wifiReconnectInProgress = false;

  ntpBekle();

  mqttBaglan();
  wifiWasConnected = WiFi.status() == WL_CONNECTED;

  sonNabizZamani = millis();
  durumDegisti = true;
}

// ================= LOOP =================
void loop() {
  static String eskiDurum = "";

  wifiNonBlockingKontrolEt();

  bool wifiBagli = WiFi.status() == WL_CONNECTED;

  if (wifiBagli) {
    mqttBaglan();

    if (mqttClient.connected()) {
      mqttClient.loop();
    }
  } else {
    if (currentStatus != "busy" && !hataEkraniGosteriliyor && durumDegisti) {
      if (durumDegisti) {
        ekranaBaglantiHatasiYaz();
        durumDegisti = false;
      }
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
  bekleyenPaketSecimi = "";

  currentStatus = "available";
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

  if (!isBayActive || currentStatus == "offline") {
    if (durumDegisti) {
      durumDegisti = false;
      eskiDurum = currentStatus;
      mqttDurumYayinla();
      ekranaKapaliYaz();
      LOG_PRINTLN(F("KAPALI"));
    }

    return;
  }

  if (durumDegisti) {
    durumDegisti = false;

    LOG_PRINT(F("DURUM: "));
    LOG_PRINTLN(currentStatus);

    mqttDurumYayinla();

    if (currentStatus == "available") {
      dokunmatikKilit = false;
      odemeBekleniyor = false;
      islemHafizasiniTemizle();
      ekranaQRCiz(bayId);
    }
    else if (currentStatus == "maintenance") {
      dokunmatikKilit = false;
      odemeBekleniyor = false;
      islemHafizasiniTemizle();

      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_ORANGE, TFT_BLACK);
      tft.setTextSize(3);
      tft.setCursor(40, 100);
      tft.println("BAKIM MODU");
    }
    else if (currentStatus == "waiting") {
      dokunmatikKilit = false;
      odemeBekleniyor = false;
      islemHafizasiniTemizle();
      ekranaWaitingCiz();
    }
    else if (currentStatus == "busy") {
      dokunmatikKilit = true;
      odemeBekleniyor = false;

      tft.fillScreen(TFT_BLACK);
      tft.setTextSize(3);
      tft.setTextColor(TFT_GREEN, TFT_BLACK);
      tft.setCursor(30, 40);

      if (requestedPackage == "foam") {
        tft.println("KOPUK MODU");
      } else {
        tft.println("SU MODU");
      }

      if (eskiDurum != "busy" || yeniBusyKomutuGeldi) {
        unsigned long kayitliKalanSure = preferences.getULong("kalanSure", 0);

        if (yeniBusyKomutuGeldi) {
          islemBaslangicMs = millis();
          islemSuresiMs = durationSec * 1000UL;
          kalanSureKaydet(durationSec);
          yeniBusyKomutuGeldi = false;

          LOG_PRINT(F("Yeni MQTT sure baslatildi. Paket: "));
          LOG_PRINT(requestedPackage);
          LOG_PRINT(F(" Sure: "));
          LOG_PRINTLN(durationSec);
        }
        else if (kayitliKalanSure > 0 && currentStatus == "busy") {
          islemBaslangicMs = millis();
          islemSuresiMs = kayitliKalanSure * 1000UL;
          sonNvsKayitMs = millis();
          sonKaydedilenKalanSure = kayitliKalanSure;
          LOG_PRINTLN(F("Kalan sure hafizadan yuklendi."));
        }
        else {
          islemBaslangicMs = millis();
          islemSuresiMs = durationSec * 1000UL;
          kalanSureKaydet(durationSec);
          LOG_PRINTLN(F("Yeni sure baslatildi."));
        }

        resetSayacDurumu();
      }
    }
    else if (currentStatus == "baslangic") {
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

    eskiDurum = currentStatus;
  }

  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  }
  else if (currentStatus == "waiting" && !dokunmatikKilit && !odemeBekleniyor) {
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

  if (currentStatus == "waiting" && !dokunmatikKilit && !hataEkraniGosteriliyor) {
    String secilenPaket = "";

    bool kopukButonDurumu = digitalRead(btnKopukPin);

    if (
      kopukButonDurumu == LOW &&
      oncekiKopukButonDurumu == HIGH &&
      millis() - sonKopukButonMs > BUTON_DEBOUNCE_MS
    ) {
      sonKopukButonMs = millis();
      secilenPaket = "foam";
    }

    oncekiKopukButonDurumu = kopukButonDurumu;

    if (secilenPaket == "") {
      uint16_t x, y;

      if (tft.getTouch(&x, &y)) {
        if (dokunmaButonIcindeMi(x, y, BTN_IPTAL)) {
          secilenPaket = "cancel";
        }
        else if (dokunmaButonIcindeMi(x, y, BTN_KOPUK)) {
          secilenPaket = "wash";
        }
        else if (dokunmaButonIcindeMi(x, y, BTN_SU)) {
          secilenPaket = "foam";
        }
      }
    }

    if (secilenPaket != "") {
      if (secilenPaket == "cancel") {
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

  if (odemeBekleniyor && currentStatus == "waiting") {
    if (millis() - odemeBeklemeBaslangicMs >= ODEME_BEKLEME_TIMEOUT_MS) {
      availableModunaDon("odeme_timeout", false);
      return;
    }
  }
}
