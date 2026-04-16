#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <TFT_eSPI.h>
#include <qrcode.h>      
#include <ArduinoJson.h> 

TFT_eSPI tft = TFT_eSPI(); 

// ÖNEMLİ: Stream (sürekli dinleme) için ayrı, manuel okuma için ayrı obje şart
FirebaseData streamFbdo; 
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

String bayId = "bay_42060_01_01";
String currentStatus = "baslangic";
String sessionId = "";

unsigned long bitisZamaniMs = 0;
int cekilenSureSaniye = 0; 

// RTDB'de veri değiştiğinde Loop'a haber verecek bayrak
bool durumDegisti = false; 

// ================= QR =================
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

// ================= SAYAC =================
void ekrandaSayaciGuncelle() {
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
      currentStatus = "bekliyor"; 
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_RED);
      tft.setTextSize(4);
      tft.setCursor(60, 120);
      tft.println("SURE BITTI");
      sonSaniye = -1;
    }
  }
}

// ================= STREAM (ANLIK DİNLEME) CALLBACK =================
void streamCallback(FirebaseStream data) {
  String path = data.dataPath();
  
  // Eğer veritabanında toplu bir güncelleme olduysa (JSON olarak gelirse)
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
    if (doc.containsKey("currentSessionId")) {
      sessionId = doc["currentSessionId"].as<String>();
    }
  } 
  // Eğer sadece tek bir satır güncellendiyse (String olarak gelirse)
  else {
    if (path == "/status") {
      String yeniDurum = data.stringData();
      if (currentStatus != yeniDurum) {
        currentStatus = yeniDurum;
        durumDegisti = true;
      }
    } else if (path == "/currentSessionId") {
      sessionId = data.stringData();
    }
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) Serial.println("Stream koptu, yeniden baglaniliyor...");
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
  
  // EKLENDİ: RTDB Bağlantı URL'si
  config.database_url = "https://ut-project-1c283-default-rtdb.europe-west1.firebasedatabase.app/";

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // RTDB Dinlemeyi Başlatıyoruz
  String streamPath = "/bays/" + bayId;
  if (!Firebase.RTDB.beginStream(&streamFbdo, streamPath)) {
    Serial.println("Stream basarisiz: " + streamFbdo.errorReason());
  } else {
    Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);
  }

  delay(1000);
  tft.fillScreen(TFT_BLACK);
}

// ================= LOOP =================
void loop() {

  // Süre sayımı her döngüde kontrol edilir (Stream'den bağımsızdır)
  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  }

  // Sadece RTDB'den yeni bir durum geldiğinde bu bloğa girilir
  if (durumDegisti) {
    durumDegisti = false; // İşleme başladık, bayrağı indir

    // ===== AVAILABLE =====
    if (currentStatus == "available") {
      ekranaQRCiz(bayId);
    }

    // ===== BUSY =====
    else if (currentStatus == "busy") {
      
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_CYAN);
      tft.setCursor(10, 40);
      tft.println("Veri cekiliyor...");

      int sure = 60;
      String packageId = "";

      // ===== SESSION OKU (FIRESTORE) =====
      if (sessionId != "") {
        if (Firebase.Firestore.getDocument(&fbdo, "ut-project-1c283", "", "sessions/" + sessionId)) {
          StaticJsonDocument<2048> sessionDoc;
          deserializeJson(sessionDoc, fbdo.payload());
          packageId = sessionDoc["fields"]["packageId"]["stringValue"] | "";
        }
      }

      // ===== PACKAGE OKU (FIRESTORE) =====
      if (packageId != "") {
        if (Firebase.Firestore.getDocument(&fbdo, "ut-project-1c283", "", "packages/" + packageId)) {
          StaticJsonDocument<2048> packageDoc;
          deserializeJson(packageDoc, fbdo.payload());

          if (packageDoc["fields"]["durationSec"].containsKey("integerValue")) {
            sure = packageDoc["fields"]["durationSec"]["integerValue"].as<int>();
          } 
          else if (packageDoc["fields"]["durationSec"].containsKey("doubleValue")) {
            sure = packageDoc["fields"]["durationSec"]["doubleValue"].as<int>();
          }
        }
      }

      // ===== MOD GOSTER =====
      tft.fillScreen(TFT_BLACK);
      tft.setTextSize(3);

      if (packageId == "foam") {
        tft.setTextColor(TFT_CYAN);
        tft.setCursor(60, 40);
        tft.println("KOPUK MODU");
      } 
      else if (packageId == "wash") {
        tft.setTextColor(TFT_BLUE);
        tft.setCursor(60, 40);
        tft.println("SU MODU");
      }

      // ===== SURE BASLAT =====
      cekilenSureSaniye = sure;
      bitisZamaniMs = millis() + ((unsigned long)sure * 1000);
    }
  }
}