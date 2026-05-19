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

// ================= MQTT =================
WiFiClientSecure mqttSecureClient;
PubSubClient mqttClient(mqttSecureClient);

String mqttClientId = "";
String mqttTopicCommands = "";
String mqttTopicStatus = "";
String mqttTopicHeartbeat = "";
String mqttTopicSelection = "";

unsigned long sonMqttDenemeMs = 0;
const unsigned long MQTT_RETRY_INTERVAL_MS = 5000;
bool ilkMqttBaglantiTamamlandi = false;

// ================= HAFIZA / ZAMAN =================
Preferences preferences;
time_t islemBitisZamani = 0;

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

// Yeni BUSY komutu geldiğinde eski endTime kullanılmasın.
bool yeniBusyKomutuGeldi = false;

// ================= SURE =================
const int MIN_DURATION_SEC = 10;
const int MAX_DURATION_SEC = 3600;

// ================= WIFI =================
const unsigned long WIFI_TIMEOUT_MS = 10000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;
unsigned long sonWifiDenemeMs = 0;

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

// ================= SAYAC =================
int sayacSonEkranSaniye = -1;
unsigned long sayacSonYarimSaniyeMs = 0;
bool sayacIslemBittiCalindi = false;

// ================= YARDIMCI =================
void resetSayacDurumu() {
  sayacSonEkranSaniye = -1;
  sayacSonYarimSaniyeMs = 0;
  sayacIslemBittiCalindi = false;
}

int guvenliDurationOku(int gelenSure) {
  if (gelenSure < MIN_DURATION_SEC || gelenSure > MAX_DURATION_SEC) {
    LOG_PRINT(F("Gecersiz durationSec: "));
    LOG_PRINTLN(gelenSure);
    return durationSec;
  }

  return gelenSure;
}

String paketNormalizeEt(String paket) {
  paket.trim();
  paket.toLowerCase();

  if (
    paket == "foam" ||
    paket == "kopuk" ||
    paket == "köpük" ||
    paket == "kopup"
  ) {
    return "foam";
  }

  if (
    paket == "wash" ||
    paket == "su" ||
    paket == "water" ||
    paket == "yikama" ||
    paket == "yıkama"
  ) {
    return "wash";
  }

  return paket;
}

void islemHafizasiniTemizle() {
  islemBitisZamani = 0;
  preferences.putULong("endTime", 0);
  resetSayacDurumu();
  yeniBusyKomutuGeldi = false;
}


void availableModunaDon(const char* sebep) {
  LOG_PRINT(F("AVAILABLE moduna donuluyor. Sebep: "));
  LOG_PRINTLN(sebep);

  odemeBekleniyor = false;
  dokunmatikKilit = false;
  hataEkraniGosteriliyor = false;

  requestedPackage = "";
  durationSec = 60;

  islemHafizasiniTemizle();

  currentStatus = "available";
  isBayActive = true;
  durumDegisti = true;

  mqttSecimYayinla("cancel");
  mqttDurumYayinla();
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

  // SOL BUTON: SU
  tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE);
  tft.setCursor(65, 115);
  tft.setTextColor(TFT_WHITE, TFT_BLUE);
  tft.setTextSize(3);
  tft.println("SU");

  // SAG BUTON: KOPUK
  tft.fillRoundRect(170, 80, 130, 90, 10, TFT_CYAN);
  tft.setCursor(185, 115);
  tft.setTextColor(TFT_BLACK, TFT_CYAN);
  tft.println("KOPUK");

  tft.fillRoundRect(100, 200, 120, 35, 8, TFT_RED);
  tft.setCursor(125, 210);
  tft.setTextColor(TFT_WHITE, TFT_RED);
  tft.setTextSize(2);
  tft.println("IPTAL");
}

// ================= QR =================
static void qrCizimGorevi(esp_qrcode_handle_t qrcode) {
  int qr_size = esp_qrcode_get_size(qrcode);
  int scale = 7;
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
}

void mqttDurumYayinla() {
  if (!mqttClient.connected()) return;

  mqttClient.publish(
    mqttTopicStatus.c_str(),
    currentStatus.c_str(),
    true
  );
}

void mqttHeartbeatYayinla() {
  if (!mqttClient.connected()) return;

  mqttClient.publish(
    mqttTopicHeartbeat.c_str(),
    "ONLINE",
    false
  );
}

void mqttBootYayinla() {
  if (!mqttClient.connected()) return;

  mqttClient.publish(
    mqttTopicHeartbeat.c_str(),
    "BOOT",
    false
  );
}

void mqttSecimYayinla(const String &secilenPaket) {
  if (!mqttClient.connected()) return;

  mqttClient.publish(
    mqttTopicSelection.c_str(),
    secilenPaket.c_str(),
    false
  );
}

void mqttKomutUygula(const String &komut) {
  LOG_PRINT(F("MQTT Komut: "));
  LOG_PRINTLN(komut);

  if (komut == "AVAILABLE") {
    currentStatus = "available";
    isBayActive = true;
    odemeBekleniyor = false;
    dokunmatikKilit = false;
    islemHafizasiniTemizle();
    durumDegisti = true;
  }
  else if (komut == "WAITING") {
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
    durumDegisti = true;
  }
  else if (komut == "ACTIVE_OFF") {
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

      requestedPackage = paketNormalizeEt(gelenPaket);
      durationSec = guvenliDurationOku(gelenSure);

      // Yeni BUSY komutu yeni işlem demektir.
      // Eski süre kullanılmayacak.
      preferences.putULong("endTime", 0);
      islemBitisZamani = 0;
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

  String mesaj = "";

  for (unsigned int i = 0; i < length; i++) {
    mesaj += (char)payload[i];
  }

  mesaj.trim();

  if (mesaj.length() == 0) return;

  mqttKomutUygula(mesaj);
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

  mqttSecureClient.setInsecure();
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

  // Sadece cihaz ilk açıldığında BOOT gönder.
  // Backend bunu görünce Firebase'deki eski session alanlarını temizleyecek.
  if (!ilkMqttBaglantiTamamlandi) {
    currentStatus = "available";
    isBayActive = true;
    islemHafizasiniTemizle();
    durumDegisti = true;

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

// ================= SAYAC =================
void ekrandaSayaciGuncelle() {
  time_t suAn;
  time(&suAn);

  if (islemBitisZamani > suAn) {
    unsigned long kalanSaniye = islemBitisZamani - suAn;

    int saniye = kalanSaniye % 60;
    int dakika = kalanSaniye / 60;

    if (kalanSaniye >= 10) {
      if (kalanSaniye != sayacSonEkranSaniye) {
        tone(buzzerPin, 2000, 100);
      }
    } else {
      if (millis() - sayacSonYarimSaniyeMs >= 500) {
        tone(buzzerPin, 2500, 100);
        sayacSonYarimSaniyeMs = millis();
      }
    }

    if (kalanSaniye != sayacSonEkranSaniye) {
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

    preferences.putULong("endTime", 0);
    islemBitisZamani = 0;

    // İşlem bitince busy'de kalmasın.
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

  if (!wifiBaglan(WIFI_TIMEOUT_MS)) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    sonWifiDenemeMs = millis();
    return;
  }

  ntpBekle();

  mqttBaglan();

  sonNabizZamani = millis();
  durumDegisti = true;
}

// ================= LOOP =================
void loop() {
  static String eskiDurum = "";

  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - sonWifiDenemeMs >= WIFI_RETRY_INTERVAL_MS) {
      sonWifiDenemeMs = millis();

      ekranaBaglantiHatasiYaz();

      if (wifiBaglan(WIFI_TIMEOUT_MS)) {
        ntpBekle();
        mqttBaglan();
        durumDegisti = true;
      }
    }

    return;
  }

  mqttBaglan();

  if (mqttClient.connected()) {
    mqttClient.loop();
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
      tft.setTextColor(TFT_ORANGE);
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
      tft.setTextColor(TFT_GREEN);
      tft.setCursor(30, 40);

      if (requestedPackage == "foam") {
        tft.println("KOPUK MODU");
      } else {
        tft.println("SU MODU");
      }

      if (eskiDurum != "busy") {
        time_t suAn;
        time(&suAn);

        time_t kayitliBitis = preferences.getULong("endTime", 0);

        if (yeniBusyKomutuGeldi) {
          // Yeni MQTT BUSY komutu geldiyse her zaman yeni süre başlat.
          islemBitisZamani = suAn + durationSec;
          preferences.putULong("endTime", (unsigned long)islemBitisZamani);
          yeniBusyKomutuGeldi = false;

          LOG_PRINT(F("Yeni MQTT sure baslatildi. Paket: "));
          LOG_PRINT(requestedPackage);
          LOG_PRINT(F(" Sure: "));
          LOG_PRINTLN(durationSec);
        }
        else if (kayitliBitis > suAn && currentStatus == "busy") {
          // Sadece elektrik kesilip cihaz busy halde açılırsa devam et.
          islemBitisZamani = kayitliBitis;
          LOG_PRINTLN(F("Kalan sure hafizadan yuklendi."));
        }
        else {
          islemBitisZamani = suAn + durationSec;
          preferences.putULong("endTime", (unsigned long)islemBitisZamani);
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
 else if (currentStatus == "waiting" && !dokunmatikKilit) {
  unsigned long gecenZaman = millis() - beklemeBaslangicMs;

  if (gecenZaman >= BEKLEME_SURESI_MS) {
    availableModunaDon("waiting_timeout");
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

    if (digitalRead(btnKopukPin) == LOW) {
      // Fiziksel buton köpük butonu olarak kaldı.
      secilenPaket = "foam";
    }

    if (secilenPaket == "") {
      uint16_t x, y;

      if (tft.getTouch(&x, &y)) {
        if (y >= 190 && y <= 240 && x >= 90 && x <= 230) {
          secilenPaket = "cancel";
        }
else if (y > 80 && y < 170) {
  if (x > 20 && x < 150) {
    // Dokunmatik X ekseni ters geldiği için burası KOPUK olarak algılanıyor.
    secilenPaket = "foam";
  } else if (x > 170 && x < 300) {
    // Dokunmatik X ekseni ters geldiği için burası SU olarak algılanıyor.
    secilenPaket = "wash";
  }
}
      }
    }

    if (secilenPaket != "") {
      dokunmatikKilit = true;
      tft.fillScreen(TFT_BLACK);

      if (secilenPaket == "cancel") {
        tft.setCursor(30, 110);
        tft.setTextSize(2);
        tft.setTextColor(TFT_RED);
        tft.println("Iptal ediliyor...");

        mqttSecimYayinla("cancel");

        currentStatus = "available";
        odemeBekleniyor = false;
        dokunmatikKilit = false;
        islemHafizasiniTemizle();
        durumDegisti = true;
      } else {
        mqttSecimYayinla(secilenPaket);

        tft.setCursor(20, 110);
        tft.setTextSize(2);
        tft.setTextColor(TFT_YELLOW);
        tft.println("Istek iletiliyor...");

        delay(500);

        tft.fillScreen(TFT_BLACK);
        tft.setCursor(20, 110);
        tft.setTextColor(TFT_WHITE);
        tft.println("Odeme bekleniyor...");

        odemeBekleniyor = true;
        odemeBeklemeBaslangicMs = millis();
      }
    }
  }

  if (odemeBekleniyor && currentStatus == "waiting") {
    if (millis() - odemeBeklemeBaslangicMs >= ODEME_BEKLEME_TIMEOUT_MS) {
      odemeBekleniyor = false;
      dokunmatikKilit = false;
      islemHafizasiniTemizle();
      durumDegisti = true;
    }
  }
}