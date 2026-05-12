#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <TFT_eSPI.h>
#include <qrcode.h>      
#include <ArduinoJson.h> 
#include "secrets.h"

TFT_eSPI tft = TFT_eSPI(); 

FirebaseData streamFbdo; 
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// --- Pin Tanımlamaları ---
const int buzzerPin = 25; // IO25 pinine bağlı buzzer
const int btnKopukPin = 32; // IO32 pinine bağlı KÖPÜK butonu

// --- Şerit Sayaç Değişkenleri ---
unsigned long beklemeBaslangicMs = 0;
const unsigned long BEKLEME_SURESI_MS = 60000; // Backend ile birebir uyumlu (60 sn)
int sonSeritGenisligi = -1;

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

// 🔥 Nabız (Heartbeat) Değişkenleri 🔥
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

// ================= EKRAN SAYAÇ GÖSTERİMİ & SES =================
void ekrandaSayaciGuncelle() {
  static int sonEkranSaniye = -1; 
  static unsigned long sonYarimSaniyeMs = 0;
  static bool islemBittiCalindi = false;

  if (millis() < bitisZamaniMs) {
    unsigned long kalanMs = bitisZamaniMs - millis();
    int toplamSaniye = kalanMs / 1000;
    int saniye = toplamSaniye % 60;
    int dakika = toplamSaniye / 60;

    // --- SES MANTIĞI ---
    if (toplamSaniye >= 10) {
      // 10 saniyeden fazla varken: Saniyede 1 kez bip
      if (toplamSaniye != sonEkranSaniye) {
        tone(buzzerPin, 2000, 100); 
      }
    } 
    else {
      // Son 10 saniye kala: Saniyede 2 kez bip (500ms aralıkla)
      if (millis() - sonYarimSaniyeMs >= 500) {
        tone(buzzerPin, 2500, 100); 
        sonYarimSaniyeMs = millis();
      }
    }

    // --- EKRAN GÜNCELLEME ---
    if (toplamSaniye != sonEkranSaniye) {
      tft.setTextColor(TFT_YELLOW, TFT_BLACK); 
      tft.setTextSize(5);
      tft.setCursor(80, 120);
      tft.printf("%02d:%02d   ", dakika, saniye);
      sonEkranSaniye = toplamSaniye;
    }
    
    islemBittiCalindi = false; // İşlem bitmediği için bayrağı hazırda tut

  } else if (!islemBittiCalindi) {
    // İşlem bittiğinde: 3 saniye kesintisiz bip
    tone(buzzerPin, 1000, 3000); 

    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED); tft.setTextSize(3);
    tft.setCursor(40, 110); tft.println("ISLEM BITTI");
    islemBittiCalindi = true; // Sürekli çalmayı engelle
  }
}

// ================= STREAM CALLBACK =================
void streamCallback(FirebaseStream data) {
  String path = data.dataPath();

  // 🔥 ÇÖZÜM: Kendi gönderdiğimiz nabız (lastSeen) veya arka planda değişen 
  // updatedAt gibi veriler stream'e düştüğünde, ekranı ve sayacı SIFIRLAMA!
  if (path == "/lastSeen" || path == "/updatedAt") {
    return; 
  }

  durumDegisti = true; 
  
  if (data.dataType() == "json") {
    StaticJsonDocument<512> doc;
    deserializeJson(doc, data.jsonString());
    if (doc.containsKey("status")) currentStatus = doc["status"].as<String>();
    if (doc.containsKey("isActive")) isBayActive = doc["isActive"].as<bool>();
    if (doc.containsKey("requestedPackage")) requestedPackage = doc["requestedPackage"].as<String>();
    if (doc.containsKey("durationSec")) durationSec = doc["durationSec"].as<int>();
  } else {
    if (path == "/status") currentStatus = data.stringData();
    else if (path == "/isActive") isBayActive = data.boolData();
    else if (path == "/requestedPackage") requestedPackage = data.stringData();
    else if (path == "/durationSec") durationSec = data.intData();
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) Serial.println("Stream koptu, yeniden baglaniliyor...");
}

// 🔥 YENİ: Hata Dedektifli Nabız Gönderme Fonksiyonu 🔥
void nabizGonder() {
  if (Firebase.ready()) {
    String path = "/bays/" + bayId + "/lastSeen";
    
    // İşlem başarılı olursa true döner, olmazsa false döner
    if (Firebase.RTDB.setTimestamp(&fbdo, path.c_str())) {
      Serial.println("💓 Nabiz gonderildi: " + bayId);
    } else {
      Serial.println("❌ NABIZ GONDERILEMEDI!");
      Serial.print("Hata Sebebi: ");
      Serial.println(fbdo.errorReason()); // BURASI ÇOK ÖNEMLİ! Hatayı ekrana basar.
    }
  } else {
    Serial.println("❌ Firebase henüz hazir degil, nabiz atlandi.");
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);

  // Buzzer Kurulumu
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);

  // Buton Kurulumu (Dahili direnç ile)
  pinMode(btnKopukPin, INPUT_PULLUP);

  tft.init(); 
  tft.setRotation(1); 
  tft.fillScreen(TFT_BLACK);
  
  uint16_t calData[5] = { 275, 3620, 264, 3532, 1 };
  tft.setTouch(calData);

  tft.setCursor(20, 100); tft.setTextSize(2); tft.setTextColor(TFT_WHITE);
  tft.println("WiFi Baglaniyor...");

WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi Baglandi!");
  
  config.api_key = API_KEY;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  config.database_url = DATABASE_URL;

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // Token'ın (Kimlik doğrulamanın) hazır olmasını bekle
  Serial.print("Firebase Baglantisi Bekleniyor");
  while (!Firebase.ready()) {
      Serial.print(".");
      delay(300);
  }
  Serial.println("\nFirebase Hazir!");
  
  Firebase.RTDB.beginStream(&streamFbdo, "/bays/" + bayId);
  Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);
  
  Serial.println("Sistem Hazır.");

  // 🔥 YENİ: Cihaz açılır açılmaz ilk nabzı anında at! 🔥
  nabizGonder();
  sonNabizZamani = millis();
}

// ================= LOOP =================
void loop() {
  // 🔥 30 Saniyede Bir Nabız Gönderme (Bloklamadan) 🔥
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

      // Şerit sayacını burada başlatıyoruz
      beklemeBaslangicMs = millis(); 
      sonSeritGenisligi = -1;

      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_WHITE); tft.setTextSize(2);
      tft.setCursor(30, 20); tft.println("Lutfen Paket Seciniz");
      
      // SU Butonu
      tft.fillRoundRect(20, 80, 130, 90, 10, TFT_BLUE);
      tft.setCursor(65, 115); tft.setTextColor(TFT_WHITE, TFT_BLUE); tft.setTextSize(3); tft.println("SU");
      
      // KÖPÜK Butonu
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

  // --- 3. SÜREKLİ GÖREVLER (SAYAÇ VE ŞERİT) ---
  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  }
  else if (currentStatus == "waiting" && !dokunmatikKilit) {
    // Backend ile uyumlu 60 saniyelik şerit eritme işlemi
    unsigned long gecenZaman = millis() - beklemeBaslangicMs;

    if (gecenZaman <= BEKLEME_SURESI_MS) {
      int maxGenislik = 280; // Butonların kapladığı tam genişlik (x=20'den x=300'e)
      
      // Kalan süreye göre şerit genişliğini hesapla
      int guncelGenislik = map(gecenZaman, 0, BEKLEME_SURESI_MS, maxGenislik, 0);

      // Ekranda titreme olmaması için sadece genişlik değiştiğinde çiz
      if (guncelGenislik != sonSeritGenisligi) {
        
        // 1. Kalan süreyi gösteren dolu kısım (Yeşil)
        tft.fillRect(20, 185, guncelGenislik, 8, TFT_GREEN); 
        
        // 2. Kısalan (eksilen) kısmı siyah ile kapat
        if (maxGenislik > guncelGenislik) {
          tft.fillRect(20 + guncelGenislik, 185, maxGenislik - guncelGenislik, 8, TFT_BLACK); 
        }
        
        sonSeritGenisligi = guncelGenislik;
      }
    }
  }

  // --- 4. DOKUNMATİK VE FİZİKSEL BUTON (BEKLEME MODUNDA) ---
  if (currentStatus == "waiting" && !dokunmatikKilit) {
    String secilenPaket = "";

    // 1. Önce fiziksel KÖPÜK butonunu kontrol et (IO32)
    if (digitalRead(btnKopukPin) == LOW) {
      secilenPaket = "foam";
    }

    // 2. Fiziksel butona basılmadıysa, dokunmatik ekrana bak
    if (secilenPaket == "") {
      uint16_t x, y;
      if (tft.getTouch(&x, &y)) {
        if (y > 80 && y < 170) {
          if (x > 20 && x < 150) { 
              secilenPaket = "foam"; 
          } 
          else if (x > 170 && x < 300) { 
              secilenPaket = "wash"; 
          }
        }
      }
    }

    // Seçim yapıldıysa (fiziksel veya dokunmatik fark etmez) veritabanına gönder
    if (secilenPaket != "") {
      dokunmatikKilit = true;
      tft.fillScreen(TFT_BLACK); 
      tft.setCursor(20, 110); tft.setTextSize(2);
      tft.setTextColor(TFT_YELLOW); tft.println("Istek iletiliyor...");

      // Buton sıçramalarını (debounce) önlemek için ufak bir gecikme
      delay(200);

      if (Firebase.RTDB.setString(&fbdo, "/bays/" + bayId + "/hardwareSelection", secilenPaket)) {
        tft.fillScreen(TFT_BLACK); 
        tft.setCursor(20, 110); tft.setTextColor(TFT_WHITE); 
        tft.println("Odeme bekleniyor...");
      } else {
        tft.fillScreen(TFT_BLACK); 
        tft.setCursor(30, 110); tft.setTextColor(TFT_RED); 
        tft.println("Baglanti Hatasi!");
        delay(2000);
        dokunmatikKilit = false; durumDegisti = true; 
      }
    }
  }
}