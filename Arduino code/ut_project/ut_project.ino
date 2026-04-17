#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <TFT_eSPI.h>
#include <qrcode.h>      
#include <ArduinoJson.h> 

TFT_eSPI tft = TFT_eSPI(); 

FirebaseData streamFbdo; 
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// Peron Bilgileri
String bayId = "bay_42060_01_01";
String currentStatus = "baslangic";
String sessionId = "";
bool isBayActive = true; // Admin kontrolü için yeni değişken

// Zamanlayıcılar
unsigned long waitingBaslangicMs = 0;
unsigned long bitisZamaniMs = 0;
int cekilenSureSaniye = 0; 
bool durumDegisti = false; 

// Ödeme bekleme kontrolü (Handshake)
bool odemeBekleniyor = false;
unsigned long odemeBeklemeBaslangic = 0;
const unsigned long ODEME_ZAMAN_ASIMI = 15000; 

// ================= QR ÇİZİMİ =================
void drawQR_to_TFT(esp_qrcode_handle_t qrcode) {
  int size = esp_qrcode_get_size(qrcode);
  int pixelSize = tft.height() / size; 
  int offsetX = (tft.width() - (size * pixelSize)) / 2;
  int offsetY = (tft.height() - (size * pixelSize)) / 2;
  for (int y = 0; y < size; y++) {
    for (int x = 0; x < size; x++) { 
      if (esp_qrcode_get_module(qrcode, x, y)) {
        tft.fillRect(offsetX + (x * pixelSize), offsetY + (y * pixelSize), pixelSize, pixelSize, TFT_BLACK);
      }
    }
  }
}

void ekranaQRCiz(String metin) {
  tft.fillScreen(TFT_WHITE);
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = drawQR_to_TFT; 
  esp_qrcode_generate(&cfg, metin.c_str());
}

// ================= KAPALI EKRANI =================
void ekranaKapaliYaz() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED);
  tft.setTextSize(3);
  tft.setCursor(50, 80);
  tft.println("BU PERON");
  tft.setCursor(40, 120);
  tft.println("KAPALIDIR");
  tft.setTextSize(2);
  tft.setCursor(20, 180);
  tft.setTextColor(TFT_WHITE);
  tft.println("Lutfen diger peronlari");
  tft.setCursor(70, 210);
  tft.println("deneyiniz.");
}

// ================= SAYAC GÜNCELLEMESİ =================
void ekrandaSayaciGuncelle() {
  if (!isBayActive) return; // Kapalıysa sayacı çizme
  static int sonSaniye = -1;
  if (millis() < bitisZamaniMs) {
    unsigned long kalanMs = bitisZamaniMs - millis();
    unsigned long toplamSaniye = kalanMs / 1000;
    int saniye = toplamSaniye % 60;
    int dakika = toplamSaniye / 60;
    if (saniye != sonSaniye) {
      tft.setTextColor(TFT_YELLOW, TFT_BLACK); 
      tft.setTextSize(5);
      tft.setCursor(80, 120); 
      tft.printf("%02d:%02d   ", dakika, saniye); 
      sonSaniye = saniye;
    }
  } 
  else {
    if (currentStatus == "busy") {
      Firebase.RTDB.setStringAsync(&fbdo, "/bays/" + bayId + "/status", "waiting");
      Firebase.RTDB.setStringAsync(&fbdo, "/bays/" + bayId + "/currentSessionId", "");
      currentStatus = "waiting"; 
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_RED);
      tft.setTextSize(4);
      tft.setCursor(60, 120);
      tft.println("SURE BITTI");
      sonSaniye = -1;
      delay(3000); 
      durumDegisti = true; 
    }
  }
}

// ================= STREAM CALLBACK =================
void streamCallback(FirebaseStream data) {
  String path = data.dataPath();
  
  if (data.dataType() == "json") {
    StaticJsonDocument<1024> doc;
    deserializeJson(doc, data.jsonString());
    
    if (doc.containsKey("status")) {
      String yeniDurum = doc["status"].as<String>();
      if (currentStatus != yeniDurum) {
        currentStatus = yeniDurum;
        durumDegisti = true;
      }
    }
    // isActive kontrolü ekleniyor
    if (doc.containsKey("isActive")) {
      bool active = doc["isActive"].as<bool>();
      if (isBayActive != active) {
        isBayActive = active;
        durumDegisti = true;
      }
    }
    if (doc.containsKey("currentSessionId")) {
      sessionId = doc["currentSessionId"].as<String>();
    }
  } 
  else {
    if (path == "/status") {
      String yeniDurum = data.stringData();
      if (currentStatus != yeniDurum) {
        currentStatus = yeniDurum;
        durumDegisti = true;
      }
    } else if (path == "/isActive") {
      bool active = data.boolData();
      if (isBayActive != active) {
        isBayActive = active;
        durumDegisti = true;
      }
    } else if (path == "/currentSessionId") {
      sessionId = data.stringData();
    }
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) Serial.println("Stream koptu...");
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  tft.init();
  tft.setRotation(1); 
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE); 
  tft.setTextSize(2);
  tft.setCursor(10, 10);
  tft.println("Baslatiliyor...");
  WiFi.begin("1", "12121214"); 
  while (WiFi.status() != WL_CONNECTED) { delay(500); }
  tft.println("WiFi OK");
  config.api_key = "AIzaSyDXXgyY_NW6_D1Ecr0ZQljYUvQSTypgJaU";
  auth.user.email = "brkunld1@yandex.com";
  auth.user.password = "123456";
  config.database_url = "https://ut-project-1c283-default-rtdb.europe-west1.firebasedatabase.app/";
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  String streamPath = "/bays/" + bayId;
  Firebase.RTDB.beginStream(&streamFbdo, streamPath);
  Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);
  delay(1000);
  tft.fillScreen(TFT_BLACK);
}

// ================= LOOP =================
void loop() {
  // --- KRİTİK ADMİN KONTROLÜ ---
  if (!isBayActive) {
    if (durumDegisti) {
      durumDegisti = false;
      ekranaKapaliYaz();
    }
    return; // Cihaz kapalıysa döngünün geri kalanını çalıştırma (butonları vs kapat)
  }

  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  }

  if (currentStatus == "waiting") {
    if (waitingBaslangicMs == 0) waitingBaslangicMs = millis();
    if (millis() - waitingBaslangicMs > 60000 && !odemeBekleniyor) {
      waitingBaslangicMs = 0;
      Firebase.RTDB.setStringAsync(&fbdo, "/bays/" + bayId + "/status", "available");
      currentStatus = "available";
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_RED); tft.setTextSize(2);
      tft.setCursor(20, 110); tft.println("Zaman Asimi!");
      delay(2000); 
      durumDegisti = true; 
    }

    if (!odemeBekleniyor) {
      uint16_t x, y;
      if (tft.getTouch(&x, &y)) {
        if (x > 20 && x < 150 && y > 80 && y < 170) {
          tft.fillRoundRect(20, 80, 130, 90, 10, TFT_DARKGREY);
          Firebase.RTDB.setStringAsync(&fbdo, "/bays/" + bayId + "/hardwareSelection", "wash");
          tft.fillScreen(TFT_BLACK);
          tft.setCursor(20, 100); tft.println("Telefondan odeme");
          tft.setCursor(20, 130); tft.println("bekleniyor...");
          odemeBekleniyor = true; odemeBeklemeBaslangic = millis(); 
        }
        else if (x > 170 && x < 300 && y > 80 && y < 170) {
          tft.fillRoundRect(170, 80, 130, 90, 10, TFT_DARKGREY);
          Firebase.RTDB.setStringAsync(&fbdo, "/bays/" + bayId + "/hardwareSelection", "foam");
          tft.fillScreen(TFT_BLACK);
          tft.setCursor(20, 100); tft.println("Telefondan odeme");
          tft.setCursor(20, 130); tft.println("bekleniyor...");
          odemeBekleniyor = true; odemeBeklemeBaslangic = millis(); 
        }
      }
    } 
    else {
      if (millis() - odemeBeklemeBaslangic > ODEME_ZAMAN_ASIMI) {
        odemeBekleniyor = false; 
        Firebase.RTDB.setStringAsync(&fbdo, "/bays/" + bayId + "/hardwareSelection", "");
        tft.fillScreen(TFT_BLACK);
        tft.setTextColor(TFT_RED); tft.setCursor(20, 110);
        tft.println("Odeme Alinamadi!");
        delay(2000); 
        durumDegisti = true; 
      }
    }
  } 
  else {
    waitingBaslangicMs = 0; 
  }

  if (durumDegisti) {
    durumDegisti = false; 
    odemeBekleniyor = false; 

    if (currentStatus == "available") {
      ekranaQRCiz(bayId);
    }
    else if (currentStatus == "waiting") {
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_WHITE); tft.setTextSize(2);
      tft.setCursor(30, 20); tft.println("Lutfen Paket Seciniz");
      tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE); 
      tft.setTextColor(TFT_WHITE); tft.setTextSize(3);
      tft.setCursor(65, 115); tft.println("SU");
      tft.fillRoundRect(170, 80, 130, 90, 10, TFT_CYAN); 
      tft.setTextColor(TFT_BLACK); tft.setCursor(185, 115); tft.println("KOPUK");
    }
    else if (currentStatus == "starting") {
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_CYAN); tft.setTextSize(2);
      tft.setCursor(10, 20); tft.println("Makine Hazirlaniyor...");
      int sure = 60; String packageId = "";
      if (Firebase.RTDB.getString(&fbdo, "/bays/" + bayId + "/requestedPackage")) { packageId = fbdo.stringData(); }
      if (Firebase.RTDB.getInt(&fbdo, "/bays/" + bayId + "/durationSec")) { sure = fbdo.intData(); }
      tft.fillScreen(TFT_BLACK); tft.setTextSize(4);
      if (packageId == "foam") { tft.setTextColor(TFT_CYAN); tft.setCursor(40, 40); tft.println("KOPUK MODU"); } 
      else if (packageId == "wash") { tft.setTextColor(TFT_BLUE); tft.setCursor(70, 40); tft.println("SU MODU"); }
      bitisZamaniMs = millis() + ((unsigned long)sure * 1000);
      Firebase.RTDB.setString(&fbdo, "/bays/" + bayId + "/status", "busy");
      currentStatus = "busy"; 
    }
  }
}