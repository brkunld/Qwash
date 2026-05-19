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
#define DEBUG_LOG 0

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

// ================= GLOBAL DEĞİŞKENLER =================
Preferences preferences;
time_t islemBitisZamani = 0;

const int buzzerPin = 25;
// FİZİKSEL AYAR BUTONU (32) TAMAMEN KALDIRILDI!

String bayId = "";        
String macAdresi = "";    
String currentStatus = "baslangic";
bool isBayActive = true;
String requestedPackage = "";
int durationSec = 60;

// ================= SURE LIMITLERI =================
const int MIN_DURATION_SEC = 10;
const int MAX_DURATION_SEC = 3600;

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

bool odemeBekleniyor = false;
unsigned long odemeBeklemeBaslangicMs = 0;
const unsigned long ODEME_BEKLEME_TIMEOUT_MS = 60000;

// ================= NABIZ =================
unsigned long sonNabizZamani = 0;
const unsigned long nabizAraligi = 30000;

bool firebaseBaslatildi = false;
bool streamBaslatildi = false;
unsigned long sonWifiDenemeMs = 0;

int sayacSonEkranSaniye = -1;
unsigned long sayacSonYarimSaniyeMs = 0;
bool sayacIslemBittiCalindi = false;

// ================= BLE (BLUETOOTH) AYARLARI =================
// Mobil uygulamanın bağlanacağı evrensel benzersiz kimlikler (UUID)
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

bool bleResetIstendi = false; // Telefondan komut gelirse true olacak

// Telefondan Bluetooth üzerinden gelen mesajları dinleyen sınıf
class MyCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      // ESP32 Sürüm 3.x ile uyumlu: Artık doğrudan Arduino String olarak okuyoruz
      String rxValue = pCharacteristic->getValue();

      if (rxValue.length() > 0) {
        LOG_PRINT("Bluetooth'tan gelen: ");
        LOG_PRINTLN(rxValue);
        
        // Eğer mobilden gelen şifreli mesaj doğruysa sıfırlama bayrağını kaldır
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
// =============================================================

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
    return durationSec;
  }
  return gelenSure;
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

  tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE);
  tft.setCursor(65, 115);
  tft.setTextColor(TFT_WHITE, TFT_BLUE);
  tft.setTextSize(3);
  tft.println("SU");

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

void ekranaQRCiz(String metin) {
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = qrCizimGorevi; 
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;
  
  esp_qrcode_generate(&cfg, metin.c_str());
}

bool wifiBaglan(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

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
  } 
  else {
    WiFi.mode(WIFI_STA);
    WiFi.begin(); 

    unsigned long baslangic = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - baslangic < timeoutMs) {
      delay(500);
    }
  }

  if (WiFi.status() == WL_CONNECTED) return true;
  return false;
}

bool firebaseHazirBekle(unsigned long timeoutMs) {
  unsigned long baslangic = millis();
  while (!Firebase.ready() && millis() - baslangic < timeoutMs) {
    delay(300);
  }
  return Firebase.ready();
}

bool streamBaslat() {
  if (!Firebase.ready()) return false;
  char path[80];
  makeBayPath(path, sizeof(path), nullptr);
  if (!Firebase.RTDB.beginStream(&streamFbdo, path)) return false;
  Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);
  return true;
}

void firebaseKurulumYap() {
  config.api_key = API_KEY;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  config.database_url = DATABASE_URL;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  firebaseBaslatildi = true;
}

void nabizGonder() {
  if (WiFi.status() != WL_CONNECTED || !Firebase.ready()) return;
  char path[96];
  makeBayPath(path, sizeof(path), "lastSeen");
  Firebase.RTDB.setTimestamp(&fbdo, path);
}

void ekrandaSayaciGuncelle() {
  time_t suAn;
  time(&suAn);

  if (islemBitisZamani > suAn) {
    unsigned long kalanSaniye = islemBitisZamani - suAn;
    int saniye = kalanSaniye % 60;
    int dakika = kalanSaniye / 60;

    if (kalanSaniye >= 10) {
      if (kalanSaniye != sayacSonEkranSaniye) tone(buzzerPin, 2000, 100);
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
  }
}

void streamCallback(FirebaseStream data) {
  String path = data.dataPath();

  if (path == "/lastSeen" || path == "/updatedAt" || path == "/hardwareSelection") return;

  bool durumFarkli = false;

  if (data.dataType() == "json") {
    StaticJsonDocument<768> doc;
    if (deserializeJson(doc, data.jsonString())) return;

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
    if (path == "/status") {
      String yeniDurum = data.stringData();
      if (currentStatus != yeniDurum) { currentStatus = yeniDurum; durumFarkli = true; }
    } else if (path == "/isActive") {
      bool yeniAktiflik = data.boolData();
      if (isBayActive != yeniAktiflik) { isBayActive = yeniAktiflik; durumFarkli = true; }
    } else if (path == "/requestedPackage") {
      requestedPackage = data.stringData();
    } else if (path == "/durationSec") {
      durationSec = guvenliDurationOku(data.intData());
    }
  }

  if (durumFarkli) durumDegisti = true;
}

void streamTimeoutCallback(bool timeout) { }

void setup() {
  Serial.begin(115200);

  currentStatus.reserve(16);
  requestedPackage.reserve(16);

  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);

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

  // ================= BLE YAYININI BAŞLAT =================
  bleBaslat(); 
  // =======================================================

  if (!wifiBaglan(WIFI_TIMEOUT_MS)) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    sonWifiDenemeMs = millis();
  } else {
    preferences.begin("qwash", false);
    configTime(3 * 3600, 0, "pool.ntp.org", "time.nist.gov"); 

    tft.fillScreen(TFT_BLACK);
    tft.setCursor(20, 100);
    tft.println("Saat Guncelleniyor...");

    time_t suAn;
    time(&suAn);
    while (suAn < 100000) {
      delay(500);
      time(&suAn);
    }

    firebaseKurulumYap();

    if (firebaseHazirBekle(FIREBASE_TIMEOUT_MS)) {
      char statusPath[96];
      makeBayPath(statusPath, sizeof(statusPath), "status");
      
      if (!Firebase.RTDB.getString(&fbdo, statusPath) || fbdo.stringData() == "null" || fbdo.stringData() == "") {
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

      streamBaslatildi = streamBaslat();

      if (streamBaslatildi) {
        nabizGonder();
        sonNabizZamani = millis();
      } else {
        currentStatus = "offline";
        isBayActive = false;
        ekranaBaglantiHatasiYaz();
      }
    } else {
      currentStatus = "offline";
      isBayActive = false;
      ekranaBaglantiHatasiYaz();
    }
  }
}

void loop() {
  static String eskiDurum = "";

  // ================= BLUETOOTH UZAKTAN SIFIRLAMA KONTROLÜ =================
  if (bleResetIstendi) {
    bleResetIstendi = false; // Bayrağı indir
    
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED);
    tft.setTextSize(3);
    tft.setCursor(30, 100);
    tft.println("SIFIRLANIYOR");
    
    tone(buzzerPin, 1000, 1500); // 1.5 Saniyelik uzun bip sesi
    delay(1500);
    
    WiFiManager wm;
    wm.resetSettings(); // Hafızadaki Wi-Fi silinir
    delay(500);
    ESP.restart(); // Cihaz yeniden başlar ve şifre olmadığı için Kurulum Moduna girer
  }
  // =========================================================================

  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - sonWifiDenemeMs >= WIFI_RETRY_INTERVAL_MS) {
      sonWifiDenemeMs = millis();
      ekranaBaglantiHatasiYaz();

      WiFi.disconnect();
      WiFi.reconnect(); 

      if (WiFi.status() == WL_CONNECTED) {
        isBayActive = true;
        currentStatus = "baslangic";
        durumDegisti = true;

        if (!firebaseBaslatildi) firebaseKurulumYap();

        if (firebaseHazirBekle(FIREBASE_TIMEOUT_MS)) {
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
    }
    return;
  }

  if (durumDegisti) {
    durumDegisti = false;

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

      if (requestedPackage == "foam") tft.println("KOPUK MODU");
      else tft.println("SU MODU");

      if (eskiDurum != "busy") {
        time_t suAn; time(&suAn);
        time_t kayitliBitis = preferences.getULong("endTime", 0);

        if (kayitliBitis > suAn) {
          islemBitisZamani = kayitliBitis;
        } else {
          islemBitisZamani = suAn + durationSec;
          preferences.putULong("endTime", (unsigned long)islemBitisZamani); 
        }
        resetSayacDurumu();
      }
    } else {
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
    
    if (secilenPaket == "") {
      uint16_t x, y;
      if (tft.getTouch(&x, &y)) {
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