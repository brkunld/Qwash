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
bool isBayActive = true;

// Zamanlayıcılar ve Kilitler
unsigned long bitisZamaniMs = 0;
bool durumDegisti = true;
bool dokunmatikKilit = false; 

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

void ekranaKapaliYaz() {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED); tft.setTextSize(3);
  tft.setCursor(50, 80); tft.println("BU PERON");
  tft.setCursor(40, 120); tft.println("KAPALIDIR");
}

// ================= EKRAN SAYAÇ GÖSTERİMİ =================
void ekrandaSayaciGuncelle() {
  static int sonSaniye = -1;
  if (millis() < bitisZamaniMs) {
    unsigned long kalanMs = bitisZamaniMs - millis();
    int toplamSaniye = kalanMs / 1000;
    int saniye = toplamSaniye % 60;
    int dakika = toplamSaniye / 60;
    if (saniye != sonSaniye) {
      tft.setTextColor(TFT_YELLOW, TFT_BLACK); 
      tft.setTextSize(5);
      tft.setCursor(80, 120);
      tft.printf("%02d:%02d   ", dakika, saniye);
      sonSaniye = saniye;
    }
  } else if (sonSaniye != 0) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED); tft.setTextSize(3);
    tft.setCursor(40, 110); tft.println("ISLEM BITTI");
    sonSaniye = 0;
  }
}

// ================= STREAM CALLBACK =================
void streamCallback(FirebaseStream data) {
  if (data.dataType() == "json") {
    StaticJsonDocument<512> doc;
    deserializeJson(doc, data.jsonString());
    if (doc.containsKey("status")) {
      String s = doc["status"].as<String>();
      if(currentStatus != s) { currentStatus = s; durumDegisti = true; }
    }
    if (doc.containsKey("isActive")) {
      bool a = doc["isActive"].as<bool>();
      if(isBayActive != a) { isBayActive = a; durumDegisti = true; }
    }
  } else {
    String path = data.dataPath();
    if (path == "/status") {
      String s = data.stringData();
      if(currentStatus != s) { currentStatus = s; durumDegisti = true; }
    } else if (path == "/isActive") {
      isBayActive = data.boolData();
      durumDegisti = true;
    }
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) Serial.println("Stream koptu, yeniden baglaniliyor...");
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  tft.init(); tft.setRotation(1); tft.fillScreen(TFT_BLACK);
  
  WiFi.begin("1", "12121214");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  
  config.api_key = "AIzaSyDXXgyY_NW6_D1Ecr0ZQljYUvQSTypgJaU";
  auth.user.email = "brkunld1@yandex.com";
  auth.user.password = "123456";
  config.database_url = "https://ut-project-1c283-default-rtdb.europe-west1.firebasedatabase.app/";
  
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  Firebase.RTDB.beginStream(&streamFbdo, "/bays/" + bayId);
  Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);
}

// ================= LOOP =================
void loop() {
  if (!isBayActive) {
    if (durumDegisti) { durumDegisti = false; ekranaKapaliYaz(); }
    return;
  }

  // Durum Değişikliği Yönetimi
  if (durumDegisti) {
    durumDegisti = false;

    if (currentStatus == "available") {
      ekranaQRCiz(bayId);
    } 
    else if (currentStatus == "waiting") {
      dokunmatikKilit = false; // Yeni paket seçimi için kilidi aç
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_WHITE); tft.setTextSize(2);
      tft.setCursor(30, 20); tft.println("Lutfen Paket Seciniz");
      tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE);
      tft.setCursor(65, 115); tft.setTextColor(TFT_WHITE, TFT_BLUE); tft.setTextSize(3); tft.println("SU");
      tft.fillRoundRect(170, 80, 130, 90, 10, TFT_CYAN);
      tft.setCursor(185, 115); tft.setTextColor(TFT_BLACK, TFT_CYAN); tft.println("KOPUK");
    } 
    else if (currentStatus == "busy") {
      // SUNUCU BUSY YAPINCA VERİLERİ ÇEK
      int sure = 60;
      String packageId = "";
      if (Firebase.RTDB.getString(&fbdo, "/bays/" + bayId + "/requestedPackage")) packageId = fbdo.stringData();
      if (Firebase.RTDB.getInt(&fbdo, "/bays/" + bayId + "/durationSec")) sure = fbdo.intData();

      tft.fillScreen(TFT_BLACK);
      tft.setTextSize(3); tft.setTextColor(TFT_GREEN);
      tft.setCursor(30, 40);
      if (packageId == "foam") tft.println("KOPUK MODU");
      else tft.println("SU MODU");

      bitisZamaniMs = millis() + ((unsigned long)sure * 1000);
    }
  }

  // Makine Çalışıyor Modu
  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  }

  // Dokunmatik Kontrolü (YENİLENMİŞ SENKRON YAPI)
  if (currentStatus == "waiting" && !dokunmatikKilit) {
    uint16_t x, y;
    if (tft.getTouch(&x, &y)) {
      if (y > 80 && y < 170) {
        
        String secilenPaket = "";
        if (x > 20 && x < 150) secilenPaket = "wash";
        else if (x > 170 && x < 300) secilenPaket = "foam";

        if (secilenPaket != "") {
          dokunmatikKilit = true; // Sisteme ikinci basmayı kapat
          
          tft.fillScreen(TFT_BLACK); 
          tft.setCursor(20, 110); 
          tft.setTextSize(2);
          tft.setTextColor(TFT_YELLOW); 
          tft.println("Istek iletiliyor...");

          // 🔥 Async yerine garantili Set komutu
          if (Firebase.RTDB.setString(&fbdo, "/bays/" + bayId + "/hardwareSelection", secilenPaket)) {
            // Başarılı olursa ödeme ekranına geç
            tft.fillScreen(TFT_BLACK); 
            tft.setCursor(20, 110); 
            tft.setTextColor(TFT_WHITE); 
            tft.println("Odeme bekleniyor...");
          } else {
            // İnternet kopması vs. nedeniyle veritabanına yazılamazsa
            tft.fillScreen(TFT_BLACK); 
            tft.setCursor(30, 110); 
            tft.setTextColor(TFT_RED); 
            tft.println("Baglanti Hatasi!");
            
            Serial.println("Firebase Yazma Hatasi: " + fbdo.errorReason());
            delay(2000);
            
            // Kullanıcının tekrar deneyebilmesi için kilidi aç ve ekranı yenile
            dokunmatikKilit = false; 
            durumDegisti = true; 
          }
        }
      }
    }
  }
}