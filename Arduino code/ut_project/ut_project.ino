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

// --- Peron Bilgileri ---
String bayId = "bay_42060_01_01";
String currentStatus = "baslangic";
bool isBayActive = true;
String requestedPackage = "";
int durationSec = 60;

// --- Zamanlayıcılar ve Kilitler ---
unsigned long bitisZamaniMs = 0;
bool durumDegisti = true;
bool dokunmatikKilit = false; 

// 🔥 YENİ: Nabız (Heartbeat) Değişkenleri 🔥
unsigned long sonNabizZamani = 0;
const long nabizAraligi = 30000; // 30 saniyede bir

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
  durumDegisti = true; 
  
  if (data.dataType() == "json") {
    StaticJsonDocument<512> doc;
    deserializeJson(doc, data.jsonString());
    if (doc.containsKey("status")) currentStatus = doc["status"].as<String>();
    if (doc.containsKey("isActive")) isBayActive = doc["isActive"].as<bool>();
    if (doc.containsKey("requestedPackage")) requestedPackage = doc["requestedPackage"].as<String>();
    if (doc.containsKey("durationSec")) durationSec = doc["durationSec"].as<int>();
  } else {
    String path = data.dataPath();
    if (path == "/status") currentStatus = data.stringData();
    else if (path == "/isActive") isBayActive = data.boolData();
    else if (path == "/requestedPackage") requestedPackage = data.stringData();
    else if (path == "/durationSec") durationSec = data.intData();
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) Serial.println("Stream koptu, yeniden baglaniliyor...");
}

// 🔥 YENİ: Nabız Gönderme Fonksiyonu 🔥
void nabizGonder() {
  if (Firebase.ready()) {
    String path = "/bays/" + bayId + "/lastSeen";
    // Firebase Server Timestamp yazar (Cihazın saati yanlış olsa bile doğru kayıt düşer)
    Firebase.RTDB.setTimestamp(&fbdo, path.c_str()); 
    Serial.println("💓 Nabiz gonderildi: " + bayId);
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  tft.init(); 
  tft.setRotation(1); 
  tft.fillScreen(TFT_BLACK);
  
  uint16_t calData[5] = { 275, 3620, 264, 3532, 1 };
  tft.setTouch(calData);

  tft.setCursor(20, 100); tft.setTextSize(2); tft.setTextColor(TFT_WHITE);
  tft.println("WiFi Baglaniyor...");

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
  
  Serial.println("Sistem Hazır.");
}

// ================= LOOP =================
void loop() {
  // 🔥 YENİ: 30 Saniyede Bir Nabız Gönderme (Bloklamadan) 🔥
  if (millis() - sonNabizZamani >= nabizAraligi) {
    sonNabizZamani = millis();
    nabizGonder();
  }

  // --- 1. ÖNCELİK: AKTİFLİK VE KAPALI DURUMU ---
  if (!isBayActive || currentStatus == "offline") {
    if (durumDegisti) {
      durumDegisti = false;
      ekranaKapaliYaz();
      Serial.println("DURUM: PERON KAPALI");
    }
    return; 
  }

  // --- 2. ÖNCELİK: DURUM DEĞİŞİKLİKLERİ ---
  if (durumDegisti) {
    durumDegisti = false;
    Serial.print("YENİ DURUM: "); Serial.println(currentStatus);

    if (currentStatus == "available") {
      ekranaQRCiz(bayId);
    } 
    else if (currentStatus == "maintenance") {
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_ORANGE); tft.setTextSize(3);
      tft.setCursor(40, 100); tft.println("BAKIM MODU");
    }
    else if (currentStatus == "waiting") {
      dokunmatikKilit = false; 
      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_WHITE); tft.setTextSize(2);
      tft.setCursor(30, 20); tft.println("Lutfen Paket Seciniz");
      
      // SU Butonu (Sol Tarafta Çiziliyor)
      tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE);
      tft.setCursor(65, 115); tft.setTextColor(TFT_WHITE, TFT_BLUE); tft.setTextSize(3); tft.println("SU");
      
      // KÖPÜK Butonu (Sağ Tarafta Çiziliyor)
      tft.fillRoundRect(170, 80, 130, 90, 10, TFT_CYAN);
      tft.setCursor(185, 115); tft.setTextColor(TFT_BLACK, TFT_CYAN); tft.println("KOPUK");
    } 
    else if (currentStatus == "busy") {
      tft.fillScreen(TFT_BLACK);
      tft.setTextSize(3); tft.setTextColor(TFT_GREEN);
      tft.setCursor(30, 40);
      
      if (requestedPackage == "foam") tft.println("KOPUK MODU");
      else tft.println("SU MODU");

      bitisZamaniMs = millis() + ((unsigned long)durationSec * 1000);
    }
  }

  // --- 3. SÜREKLİ GÖREVLER (SAYAÇ) ---
  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  }

  // --- 4. DOKUNMATİK (BEKLEME MODUNDA) ---
  if (currentStatus == "waiting" && !dokunmatikKilit) {
    uint16_t x, y;
    if (tft.getTouch(&x, &y)) {
      if (y > 80 && y < 170) {
        String secilenPaket = "";
        
        // 🛠️ DÜZELTME: X Ekseni Ters Dönmesi (Inversion) Koruması 🛠️
        // Ekran dokunmatiği aynalanmış çalıştığı için sol ve sağ dokunmaları ters atıyoruz.
        // x < 150 normalde sol taraftır ama ters olduğu için KÖPÜK butonunu tetikliyor.
        
        if (x > 20 && x < 150) { 
            secilenPaket = "foam"; // Önceden wash idi, ters çevrildi.
        } 
        else if (x > 170 && x < 300) { 
            secilenPaket = "wash"; // Önceden foam idi, ters çevrildi.
        }

        if (secilenPaket != "") {
          dokunmatikKilit = true;
          tft.fillScreen(TFT_BLACK); 
          tft.setCursor(20, 110); tft.setTextSize(2);
          tft.setTextColor(TFT_YELLOW); tft.println("Istek iletiliyor...");

          if (Firebase.RTDB.setString(&fbdo, "/bays/" + bayId + "/hardwareSelection", secilenPaket)) {
            tft.fillScreen(TFT_BLACK); 
            tft.setCursor(20, 110); tft.setTextColor(TFT_WHITE); 
            tft.println("Odeme bekleniyor...");
          } else {
            tft.fillScreen(TFT_BLACK); 
            tft.setCursor(30, 110); tft.setTextColor(TFT_RED); 
            tft.println("Baglanti Hatasi!");
            delay(2000); // Uyarıyı okuması için kısa bekleme
            dokunmatikKilit = false; durumDegisti = true; 
          }
        }
      }
    }
  }
}