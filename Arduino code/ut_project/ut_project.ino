#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <TFT_eSPI.h>
#include <ArduinoJson.h>
#include <pgmspace.h>
#include "secrets.h"

// ================= YENİ EKLENEN KÜTÜPHANELER =================
#include <time.h>
#include <Preferences.h>
#include <WiFiManager.h>
#include "qrcode.h"

// BLE (BLUETOOTH LOW ENERGY) KÜTÜPHANELERİ
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ================= OPTIMIZASYON AYARLARI =================
// Uretimde 0 kalsin. Debug gerekirse 1 yap.
#define DEBUG_LOG 1

#if DEBUG_LOG
  #define LOG_PRINT(x) Serial.print(x)
  #define LOG_PRINTLN(x) Serial.println(x)
#else
  #define LOG_PRINT(x)
  #define LOG_PRINTLN(x)
#endif

TFT_eSPI tft = TFT_eSPI();

FirebaseData streamFbdo;
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ================= YENİ GLOBAL DEĞİŞKENLER =================
Preferences preferences;
time_t islemBitisZamani = 0;

// ================= PIN TANIMLARI =================
const int buzzerPin = 25;
const int btnKopukPin = 32;

// ================= PERON BILGILERI =================
String bayId = "";        // Artık cihaz MAC adresinden otomatik alınacak
String macAdresi = "";    // Cihazın benzersiz MAC adresi
String currentStatus = "baslangic";
bool isBayActive = true;
String requestedPackage = "";
int durationSec = 60;

// ================= SURE LIMITLERI =================
const int MIN_DURATION_SEC = 10;
const int MAX_DURATION_SEC = 3600;

// ================= BAGLANTI TIMEOUTLARI =================
const unsigned long WIFI_TIMEOUT_MS = 10000;
const unsigned long FIREBASE_TIMEOUT_MS = 10000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;

// ================= BEKLEME SERIDI =================
unsigned long beklemeBaslangicMs = 0;
const unsigned long BEKLEME_SURESI_MS = 60000;
int sonSeritGenisligi = -1;

// ================= HATA EKRANI =================
unsigned long hataEkraniBaslangicMs = 0;
bool hataEkraniGosteriliyor = false;

// ================= ISLEM VE KILITLER =================
bool durumDegisti = true;
bool dokunmatikKilit = false;

// ================= ODEME BEKLEME TIMEOUT =================
bool odemeBekleniyor = false;
unsigned long odemeBeklemeBaslangicMs = 0;
const unsigned long ODEME_BEKLEME_TIMEOUT_MS = 60000;

// ================= NABIZ =================
unsigned long sonNabizZamani = 0;
const unsigned long nabizAraligi = 30000;

// ================= BAGLANTI DURUMLARI =================
bool firebaseBaslatildi = false;
bool streamBaslatildi = false;
unsigned long sonWifiDenemeMs = 0;

// ================= SAYAC STATE =================
int sayacSonEkranSaniye = -1;
unsigned long sayacSonYarimSaniyeMs = 0;
bool sayacIslemBittiCalindi = false;

// ================= BLE (BLUETOOTH) AYARLARI =================
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

bool bleResetIstendi = false; 

class MyCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue();
      if (rxValue.length() > 0) {
        LOG_PRINT("Bluetooth'tan gelen: ");
        LOG_PRINTLN(rxValue);
        if (rxValue == "RESET_1453") {
          bleResetIstendi = true;
        }
      }
    }
};

void bleBaslat() {
  String bleName = "Qwash_BLE_" + macAdresi.substring(8);
  BLEDevice::init(bleName.c_str());
  
  BLEServer *pServer = BLEDevice::createServer();
  BLEService *pService = pServer->createService(SERVICE_UUID);
  BLECharacteristic *pCharacteristic = pService->createCharacteristic(
                                         CHARACTERISTIC_UUID,
                                         BLECharacteristic::PROPERTY_WRITE
                                       );
  pCharacteristic->setCallbacks(new MyCallbacks());
  pService->start();
  
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);  
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  
  LOG_PRINTLN("BLE Baslatildi! Baglanti bekleniyor...");
}

// ================= YARDIMCI FONKSIYONLAR =================

void makeBayPath(char *out, size_t outSize, const char *child) {
  if (child == nullptr || child[0] == '\0') {
    snprintf(out, outSize, "/bays/%s", bayId.c_str());
  } else {
    snprintf(out, outSize, "/bays/%s/%s", bayId.c_str(), child);
  }
}

void resetSayacDurumu() {
  sayacSonEkranSaniye = -1;
  sayacSonYarimSaniyeMs = 0;
  sayacIslemBittiCalindi = false;
}

int guvenliDurationOku(int gelenSure) {
  if (gelenSure < MIN_DURATION_SEC || gelenSure > MAX_DURATION_SEC) {
    LOG_PRINT(F("Gecersiz durationSec: "));
    LOG_PRINTLN(gelenSure);
    LOG_PRINT(F("Sure korunuyor: "));
    LOG_PRINTLN(durationSec);
    return durationSec;
  }
  return gelenSure;
}

void ekranaMesajYaz(uint16_t arkaPlan, uint16_t yaziRengi, int textSize, int x, int y, const String &mesaj) {
  tft.fillScreen(arkaPlan);
  tft.setTextColor(yaziRengi);
  tft.setTextSize(textSize);
  tft.setCursor(x, y);
  tft.println(mesaj);
}

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

  // SU Butonu
  tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE);
  tft.setCursor(65, 115);
  tft.setTextColor(TFT_WHITE, TFT_BLUE);
  tft.setTextSize(3);
  tft.println("SU");

  // KOPUK Butonu
  tft.fillRoundRect(170, 80, 130, 90, 10, TFT_CYAN);
  tft.setCursor(185, 115);
  tft.setTextColor(TFT_BLACK, TFT_CYAN);
  tft.println("KOPUK");

  // IPTAL Butonu (QR'a dönmek için)
  tft.fillRoundRect(100, 200, 120, 35, 8, TFT_RED);
  tft.setCursor(125, 210);
  tft.setTextColor(TFT_WHITE, TFT_RED);
  tft.setTextSize(2);
  tft.println("IPTAL");
}

// ================= DİNAMİK QR BITMAP ÜRETİMİ =================
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
        tft.fillRect(offset_x + (x * scale), offset_y + (y * scale), scale, scale, TFT_BLACK);
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

// ================= WIFI / FIREBASE =================

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
    tft.println("Sifre Yok (Acik Ag)");
    tft.setCursor(10, 180);
    tft.println("Ekran acilmazsa tarayiciya:");
    tft.setTextColor(TFT_WHITE);
    tft.setCursor(10, 210);
    tft.println("192.168.4.1 yazin");

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
  }

  if (WiFi.status() == WL_CONNECTED) {
    LOG_PRINT(F("\nIP: "));
    LOG_PRINTLN(WiFi.localIP());
    return true;
  }

  LOG_PRINTLN(F("\nWiFi yok."));
  return false;
}

bool firebaseHazirBekle(unsigned long timeoutMs) {
  unsigned long baslangic = millis();

  while (!Firebase.ready() && millis() - baslangic < timeoutMs) {
    delay(300);
    LOG_PRINT(F("."));
  }

  LOG_PRINTLN(F(""));

  if (Firebase.ready()) {
    LOG_PRINTLN(F("Firebase hazir."));
    return true;
  }

  LOG_PRINTLN(F("Firebase yok."));
  return false;
}

bool streamBaslat() {
  if (!Firebase.ready()) {
    LOG_PRINTLN(F("Stream yok: Firebase hazir degil."));
    return false;
  }

  char path[80];
  makeBayPath(path, sizeof(path), nullptr);

  if (!Firebase.RTDB.beginStream(&streamFbdo, path)) {
    LOG_PRINT(F("Stream hata: "));
    Serial.println(streamFbdo.errorReason());
    return false;
  }

  // DİKKAT: Callback fonksiyon ataması iptal edildi, Loop içinde dinlenecek.

  LOG_PRINT(F("Stream: "));
  LOG_PRINTLN(path);

  return true;
}

void firebaseKurulumYap() {
  config.api_key = API_KEY;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  config.database_url = DATABASE_URL;

  // ================= YENİ EKLENEN KISIM =================
  // ESP32'nin ağ paketlerini alabilmesi için hafızayı genişletiyoruz
  streamFbdo.setBSSLBufferSize(4096, 1024);
  fbdo.setBSSLBufferSize(4096, 1024);
  // =======================================================

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  firebaseBaslatildi = true;
}

// ================= NABIZ =================

void nabizGonder() {
  if (WiFi.status() != WL_CONNECTED) {
    LOG_PRINTLN(F("Nabiz yok: WiFi"));
    return;
  }

  if (!Firebase.ready()) {
    LOG_PRINTLN(F("Nabiz yok: Firebase"));
    return;
  }

  char path[96];
  makeBayPath(path, sizeof(path), "lastSeen");

  if (Firebase.RTDB.setTimestamp(&fbdo, path)) {
    LOG_PRINT(F("Nabiz: "));
    Serial.println(bayId);
  } else {
    LOG_PRINTLN(F("Nabiz hata."));
    LOG_PRINT(F("Hata: "));
    Serial.println(fbdo.errorReason());
  }
}

// ================= EKRAN SAYACI VE SES (GERÇEK ZAMANLI) =================

void ekrandaSayaciGuncelle() {
  time_t suAn;
  time(&suAn);

  // İşlem bitiş zamanı henüz gelmediyse
  if (islemBitisZamani > suAn) {
    unsigned long kalanSaniye = islemBitisZamani - suAn;

    int saniye = kalanSaniye % 60;
    int dakika = kalanSaniye / 60;

    // Ses mantigi
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

    // Ekran guncelleme
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
    
    // İşlem tamamen bittiğinde hafızadaki süreyi sıfırla
    preferences.putULong("endTime", 0);
  }
}

// ================= SETUP =================

void setup() {
  Serial.begin(115200);

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

  // ================= MAC ADRESİ VE BAY ID OLUŞTURMA =================
  WiFi.mode(WIFI_STA); 
  String rawMac = WiFi.macAddress();
  while (rawMac == "00:00:00:00:00:00" || rawMac == "") {
    delay(100);
    rawMac = WiFi.macAddress();
  }
  rawMac.replace(":", ""); 
  macAdresi = rawMac;
  bayId = "bay_" + macAdresi; 
  // ==================================================================

  bleBaslat();

  bool wifiOk = wifiBaglan(WIFI_TIMEOUT_MS);

  if (!wifiOk) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    sonWifiDenemeMs = millis();
    return;
  }

  // ================= HAFIZA VE NTP AYARLARI =================
  preferences.begin("qwash", false);
  configTime(3 * 3600, 0, "pool.ntp.org", "time.nist.gov"); // Türkiye saati (UTC+3)

  tft.fillScreen(TFT_BLACK);
  tft.setCursor(20, 100);
  tft.println("Saat Guncelleniyor...");

  LOG_PRINT(F("NTP Bekleniyor..."));
  time_t suAn;
  time(&suAn);
  while (suAn < 100000) {
    delay(500);
    LOG_PRINT(F("."));
    time(&suAn);
  }
  LOG_PRINTLN(F(" Saat Guncellendi."));
  // ================================================================

  firebaseKurulumYap();

  LOG_PRINT(F("Firebase bekleniyor"));
  bool firebaseOk = firebaseHazirBekle(FIREBASE_TIMEOUT_MS);

  if (!firebaseOk) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    return;
  }

  // ================= İLK BAĞLANTI & CİHAZ KAYDI KONTROLÜ =================
  char statusPath[96];
  makeBayPath(statusPath, sizeof(statusPath), "status");
  
  if (Firebase.RTDB.getString(&fbdo, statusPath) && fbdo.stringData() != "null" && fbdo.stringData() != "") {
     currentStatus = fbdo.stringData();
  } else {
     currentStatus = "available";
     
     FirebaseJson yeniCihazVerisi;
     yeniCihazVerisi.set("status", "available"); 
     yeniCihazVerisi.set("isActive", true); 
     yeniCihazVerisi.set("autoOffline", true);
     yeniCihazVerisi.set("currentSessionId", "");
     yeniCihazVerisi.set("lastUserId", "");
     yeniCihazVerisi.set("hardwareSelection", "");
     yeniCihazVerisi.set("requestedPackage", "");
     yeniCihazVerisi.set("durationSec", 0);
     
     FirebaseJson timestampObj;
     timestampObj.set(".sv", "timestamp");
     yeniCihazVerisi.set("createdAt", timestampObj);
     yeniCihazVerisi.set("updatedAt", timestampObj);
     yeniCihazVerisi.set("lastSeen", timestampObj);
     
     char rootPath[96];
     makeBayPath(rootPath, sizeof(rootPath), nullptr); 
     Firebase.RTDB.updateNode(&fbdo, rootPath, &yeniCihazVerisi);
  }
  durumDegisti = true;
  // =======================================================================

  streamBaslatildi = streamBaslat();

  if (!streamBaslatildi) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    return;
  }

  LOG_PRINTLN(F("Hazir."));

  nabizGonder();
  sonNabizZamani = millis();
}

// ================= LOOP =================

void loop() {
  static String eskiDurum = "";

  // ================= BLUETOOTH RESET KONTROLÜ =================
  if (bleResetIstendi) {
    bleResetIstendi = false; 
    
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED);
    tft.setTextSize(3);
    tft.setCursor(30, 100);
    tft.println("SIFIRLANIYOR");
    
    tone(buzzerPin, 1000, 1500); 
    delay(1500);
    
    WiFiManager wm;
    wm.resetSettings(); 
    delay(500);
    ESP.restart(); 
  }
  // ============================================================

  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - sonWifiDenemeMs >= WIFI_RETRY_INTERVAL_MS) {
      sonWifiDenemeMs = millis();

      ekranaBaglantiHatasiYaz();

      if (wifiBaglan(WIFI_TIMEOUT_MS)) {
        isBayActive = true;
        durumDegisti = true;

        if (!firebaseBaslatildi) {
          firebaseKurulumYap();
        }

        if (firebaseHazirBekle(FIREBASE_TIMEOUT_MS)) {
          // Wi-Fi koptuktan sonra Firebase'den asıl durumu çekiyoruz.
          char statusPath[96];
          makeBayPath(statusPath, sizeof(statusPath), "status");
          if (Firebase.RTDB.getString(&fbdo, statusPath) && fbdo.stringData() != "null" && fbdo.stringData() != "") {
             currentStatus = fbdo.stringData();
          } else {
             currentStatus = "available";
          }

          streamBaslatildi = streamBaslat();
          nabizGonder();
          sonNabizZamani = millis();
        }
      }
    }
    return;
  }

  if (firebaseBaslatildi && Firebase.ready() && !streamBaslatildi) {
    streamBaslatildi = streamBaslat();
  }

  // =============== YENİ KESİNTİSİZ STREAM DİNLEME MANTIĞI ===============
  if (streamBaslatildi && Firebase.ready()) {
    if (!Firebase.RTDB.readStream(&streamFbdo)) {
      // Bağlantı hatası olursa sessizce atlar
    }

    if (streamFbdo.streamTimeout()) {
      LOG_PRINTLN(F("Stream zaman asimi. Yenileniyor..."));
    }

    if (streamFbdo.streamAvailable()) {
      String path = streamFbdo.dataPath();
      LOG_PRINT(F("Stream Gelen Veri Path: "));
      LOG_PRINTLN(path);

      if (path != "/lastSeen" && path != "/updatedAt" && path != "/hardwareSelection") {
        bool durumFarkli = false;

        if (streamFbdo.dataType() == "json") {
          DynamicJsonDocument doc(2048);
          DeserializationError err = deserializeJson(doc, streamFbdo.jsonString());
          if (!err) {
            if (doc.containsKey("status")) {
              String yeniDurum = doc["status"].as<String>();
              if (currentStatus != yeniDurum) { currentStatus = yeniDurum; durumFarkli = true; }
            }
            if (doc.containsKey("isActive")) {
              bool yeniAktiflik = doc["isActive"].as<bool>();
              if (isBayActive != yeniAktiflik) { isBayActive = yeniAktiflik; durumFarkli = true; }
            }
            if (doc.containsKey("requestedPackage")) {
              requestedPackage = doc["requestedPackage"].as<String>();
            }
            if (doc.containsKey("durationSec")) {
              durationSec = guvenliDurationOku(doc["durationSec"].as<int>());
            }
          } else {
            Serial.print(F("JSON Hata: ")); Serial.println(err.c_str());
          }
        } else {
          if (path == "/status" || path == "status") {
            String yeniDurum = streamFbdo.stringData();
            if (currentStatus != yeniDurum) { currentStatus = yeniDurum; durumFarkli = true; }
          } else if (path == "/isActive" || path == "isActive") {
            bool yeniAktiflik = streamFbdo.boolData();
            if (isBayActive != yeniAktiflik) { isBayActive = yeniAktiflik; durumFarkli = true; }
          } else if (path == "/requestedPackage" || path == "requestedPackage") {
            requestedPackage = streamFbdo.stringData();
          } else if (path == "/durationSec" || path == "durationSec") {
            durationSec = guvenliDurationOku(streamFbdo.intData());
          }
        }

        if (durumFarkli) {
          durumDegisti = true;
        }
      }
    }
  }
  // ========================================================================

  if (millis() - sonNabizZamani >= nabizAraligi) {
    sonNabizZamani = millis();
    nabizGonder();
  }

  if (hataEkraniGosteriliyor) {
    if (millis() - hataEkraniBaslangicMs >= 2000) {
      hataEkraniGosteriliyor = false;
      dokunmatikKilit = false;
      durumDegisti = true;
    }
    return;
  }

  if (odemeBekleniyor && currentStatus == "waiting") {
    if (millis() - odemeBeklemeBaslangicMs >= ODEME_BEKLEME_TIMEOUT_MS) {
      LOG_PRINTLN(F("Odeme timeout."));

      odemeBekleniyor = false;
      dokunmatikKilit = false;
      durumDegisti = true;

      if (Firebase.ready()) {
        char path[96];
        makeBayPath(path, sizeof(path), "hardwareSelection");
        Firebase.RTDB.setString(&fbdo, path, "");
      }
    }
  }

  if (!isBayActive || currentStatus == "offline") {
    if (durumDegisti) {
      durumDegisti = false;
      eskiDurum = currentStatus;
      ekranaKapaliYaz();
      LOG_PRINTLN(F("KAPALI"));
    }
    return;
  }

  if (durumDegisti) {
    durumDegisti = false;

    LOG_PRINT(F("DURUM: "));
    Serial.println(currentStatus);

    if (currentStatus == "available") {
      dokunmatikKilit = false;
      odemeBekleniyor = false;
      ekranaQRCiz(bayId);
    } else if (currentStatus == "maintenance") {
      dokunmatikKilit = false;
      odemeBekleniyor = false;

      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_ORANGE);
      tft.setTextSize(3);
      tft.setCursor(40, 100);
      tft.println("BAKIM MODU");
    } else if (currentStatus == "waiting") {
      ekranaWaitingCiz();
    } else if (currentStatus == "busy") {
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

      // ================= SÜRE BAŞLATMA VE HAFIZA =================
      // Busy durumuna ilk kez girildiginde sureyi baslat.
      if (eskiDurum != "busy") {
        time_t suAn;
        time(&suAn);

        // Hafızadan önceki bitiş zamanını oku
        time_t kayitliBitis = preferences.getULong("endTime", 0);

        // Eğer kayıtlı bitiş zamanı gelecekteyse (elektrik kesilip geldiyse)
        if (kayitliBitis > suAn) {
          islemBitisZamani = kayitliBitis;
          LOG_PRINTLN(F("Kalan sure hafizadan yuklendi."));
        } else {
          // Normal yeni başlama
          islemBitisZamani = suAn + durationSec;
          preferences.putULong("endTime", (unsigned long)islemBitisZamani); // Hafızaya yaz
          LOG_PRINTLN(F("Yeni sure baslatildi."));
        }

        resetSayacDurumu();
      }
      // =================================================================
    } else if (currentStatus == "baslangic") {
      // Cihaz ilk açıldığında doğrudan bilinmeyen durum hatası vermemesi için
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_WHITE);
      tft.setTextSize(2);
      tft.setCursor(20, 100);
      tft.println("Durum Aliniyor...");
    } else {
      LOG_PRINT(F("Bilinmeyen: "));
      Serial.println(currentStatus);

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
  } else if (currentStatus == "waiting" && !dokunmatikKilit) {
    unsigned long gecenZaman = millis() - beklemeBaslangicMs;

    if (gecenZaman <= BEKLEME_SURESI_MS) {
      int maxGenislik = 280;
      int guncelGenislik = map(gecenZaman, 0, BEKLEME_SURESI_MS, maxGenislik, 0);

      if (guncelGenislik != sonSeritGenisligi) {
        tft.fillRect(20, 185, guncelGenislik, 8, TFT_GREEN);

        if (maxGenislik > guncelGenislik) {
          tft.fillRect(20 + guncelGenislik, 185, maxGenislik - guncelGenislik, 8, TFT_BLACK);
        }

        sonSeritGenisligi = guncelGenislik;
      }
    }
  }

  if (currentStatus == "waiting" && !dokunmatikKilit && !hataEkraniGosteriliyor) {
    String secilenPaket = "";

    // DİKKAT: Eski kodunuzdaki fiziksel buton mantığı aynen korundu
    if (digitalRead(btnKopukPin) == LOW) {
      secilenPaket = "foam";
    }

    if (secilenPaket == "") {
      uint16_t x, y;
      if (tft.getTouch(&x, &y)) {
        // DİKKAT: Eski kodunuzdaki dokunmatik koordinatlar aynen korundu
        if (y >= 190 && y <= 240 && x >= 90 && x <= 230) {
          secilenPaket = "cancel";
        }
        else if (y > 80 && y < 170) {
          if (x > 20 && x < 150) {
            secilenPaket = "foam"; 
          } else if (x > 170 && x < 300) {
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
      } else {
        tft.setCursor(20, 110);
        tft.setTextSize(2);
        tft.setTextColor(TFT_YELLOW);
        tft.println("Istek iletiliyor...");
      }

      delay(200);

      if (!Firebase.ready()) {
        tft.fillScreen(TFT_BLACK);
        tft.setCursor(30, 110);
        tft.setTextColor(TFT_RED);
        tft.println("Baglanti Hatasi!");

        hataEkraniGosteriliyor = true;
        hataEkraniBaslangicMs = millis();
        return;
      }

      if (secilenPaket == "cancel") {
        char statusPath[96];
        makeBayPath(statusPath, sizeof(statusPath), "status");
        
        if (Firebase.RTDB.setString(&fbdo, statusPath, "available")) {
          char hwPath[96];
          makeBayPath(hwPath, sizeof(hwPath), "hardwareSelection");
          Firebase.RTDB.setString(&fbdo, hwPath, "");

          currentStatus = "available";
          durumDegisti = true;
          dokunmatikKilit = false;
        } else {
          LOG_PRINT(F("Iptal hata: "));
          Serial.println(fbdo.errorReason());

          tft.fillScreen(TFT_BLACK);
          tft.setCursor(30, 110);
          tft.setTextColor(TFT_RED);
          tft.println("Baglanti Hatasi!");

          hataEkraniGosteriliyor = true;
          hataEkraniBaslangicMs = millis();
        }
      } 
      else {
        char path[96];
        makeBayPath(path, sizeof(path), "hardwareSelection");

        if (Firebase.RTDB.setString(&fbdo, path, secilenPaket)) {
          tft.fillScreen(TFT_BLACK);
          tft.setCursor(20, 110);
          tft.setTextColor(TFT_WHITE);
          tft.println("Odeme bekleniyor...");

          odemeBekleniyor = true;
          odemeBeklemeBaslangicMs = millis();
        } else {
          LOG_PRINT(F("Secim hata: "));
          Serial.println(fbdo.errorReason());

          tft.fillScreen(TFT_BLACK);
          tft.setCursor(30, 110);
          tft.setTextColor(TFT_RED);
          tft.println("Baglanti Hatasi!");

          hataEkraniGosteriliyor = true;
          hataEkraniBaslangicMs = millis();
        }
      }
    }
  }
}