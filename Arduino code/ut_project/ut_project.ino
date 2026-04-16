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

String bayId = "bay_42060_01_01";
String currentStatus = "baslangic";
String sessionId = "";

unsigned long bitisZamaniMs = 0;
int cekilenSureSaniye = 0; 
bool durumDegisti = false; 

// YENİ EKLENENLER: Ödeme bekleme kontrolü için
bool odemeBekleniyor = false;
unsigned long odemeBeklemeBaslangic = 0;
const unsigned long ODEME_ZAMAN_ASIMI = 5000; // 5 Saniye (5000 ms)

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
      currentStatus = "available"; 
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

  // DOKUNMATİK EKRAN KALİBRASYONU (Gerekirse bu satırları aktif edin)
  // uint16_t calData[5] = { 275, 3620, 264, 3532, 1 };
  // tft.setTouch(calData);

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
  if (!Firebase.RTDB.beginStream(&streamFbdo, streamPath)) {
    Serial.println("Stream basarisiz: " + streamFbdo.errorReason());
  } else {
    Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);
  }

  delay(1000);
  tft.fillScreen(TFT_BLACK);
}

// ================= LOOP =================
// ================= LOOP =================
void loop() {

  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  }

  // ===== 1. DOKUNMATİK EKRAN DİNLEME (Sadece Waiting Modunda) =====
  if (currentStatus == "waiting") {
    
    // Eğer henüz bir butona basılmadıysa dokunmatiği dinle
    if (!odemeBekleniyor) {
      uint16_t x, y;
      
      if (tft.getTouch(&x, &y)) {
        
        // SU BUTONU 
        if (x > 20 && x < 150 && y > 80 && y < 170) {
          tft.fillRoundRect(20, 80, 130, 90, 10, TFT_DARKGREY);
          
          Firebase.RTDB.setString(&fbdo, "/bays/" + bayId + "/hardwareSelection", "wash");

          tft.fillScreen(TFT_BLACK);
          tft.setTextColor(TFT_WHITE);
          tft.setTextSize(2);
          tft.setCursor(20, 100);
          tft.println("Telefondan odeme");
          tft.setCursor(20, 130);
          tft.println("bekleniyor...");
          
          odemeBekleniyor = true;
          odemeBeklemeBaslangic = millis(); // Sayacı başlat
        }
        
        // KÖPÜK BUTONU
        else if (x > 170 && x < 300 && y > 80 && y < 170) {
          tft.fillRoundRect(170, 80, 130, 90, 10, TFT_DARKGREY);
          
          Firebase.RTDB.setString(&fbdo, "/bays/" + bayId + "/hardwareSelection", "foam");

          tft.fillScreen(TFT_BLACK);
          tft.setTextColor(TFT_WHITE);
          tft.setTextSize(2);
          tft.setCursor(20, 100);
          tft.println("Telefondan odeme");
          tft.setCursor(20, 130);
          tft.println("bekleniyor...");
          
          odemeBekleniyor = true;
          odemeBeklemeBaslangic = millis(); // Sayacı başlat
        }
      }
    } 
    // Eğer butona basıldıysa ve ödeme bekleniyorsa zaman aşımını kontrol et
    else {
      if (millis() - odemeBeklemeBaslangic > ODEME_ZAMAN_ASIMI) {
        // 5 saniye geçti ve hala waiting modundaysak (mobil uygulama onay vermediyse)
        odemeBekleniyor = false; // Beklemeyi iptal et
        
        // RTDB'deki isteği temizle ki mobilde sonradan tetiklenmesin
        Firebase.RTDB.setString(&fbdo, "/bays/" + bayId + "/hardwareSelection", "");
        
        // Ekrana hata yazdır
        tft.fillScreen(TFT_BLACK);
        tft.setTextColor(TFT_RED);
        tft.setTextSize(2);
        tft.setCursor(20, 110);
        tft.println("Odeme Alinamadi!");
        delay(2000); // 2 saniye hatayı göster
        
        durumDegisti = true; // Ekranı (butonları) tekrar çizmesi için sistemi tetikle
      }
    }
  }

  // ===== 2. RTDB'DEN DURUM DEĞİŞİMİ GELDİĞİNDE =====
  if (durumDegisti) {
    durumDegisti = false; 
    odemeBekleniyor = false; // Durum değiştiyse bekleme modunu her halükarda sıfırla

    if (currentStatus == "available") {
      ekranaQRCiz(bayId);
    }

    else if (currentStatus == "waiting") {
      tft.fillScreen(TFT_BLACK);

      tft.setTextColor(TFT_WHITE);
      tft.setTextSize(2);
      tft.setCursor(30, 20);
      tft.println("Lutfen Paket Seciniz");

      // Sol Buton (SU)
      tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE); 
      tft.setTextColor(TFT_WHITE);
      tft.setTextSize(3);
      tft.setCursor(65, 115);
      tft.println("SU");

      // Sağ Buton (KÖPÜK)
      tft.fillRoundRect(170, 80, 130, 90, 10, TFT_CYAN); 
      tft.setTextColor(TFT_BLACK);
      tft.setTextSize(3);
      tft.setCursor(185, 115);
      tft.println("KOPUK");
    }

    else if (currentStatus == "busy") {
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_CYAN);
      tft.setTextSize(2);
      tft.setCursor(10, 20);
      tft.println("Veriler Aliniyor...");

      int sure = 60;
      String packageId = "";

      if (sessionId != "") {
        if (Firebase.Firestore.getDocument(&fbdo, "ut-project-1c283", "", "sessions/" + sessionId)) {
          StaticJsonDocument<2048> sessionDoc;
          deserializeJson(sessionDoc, fbdo.payload());
          packageId = sessionDoc["fields"]["packageId"]["stringValue"] | "";
        }
      }

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

      tft.fillScreen(TFT_BLACK);
      tft.setTextSize(4);

      if (packageId == "foam") {
        tft.setTextColor(TFT_CYAN);
        tft.setCursor(40, 40);
        tft.println("KOPUK MODU");
      } 
      else if (packageId == "wash") {
        tft.setTextColor(TFT_BLUE);
        tft.setCursor(70, 40);
        tft.println("SU MODU");
      }

      cekilenSureSaniye = sure;
      bitisZamaniMs = millis() + ((unsigned long)sure * 1000);
    }
  }
}