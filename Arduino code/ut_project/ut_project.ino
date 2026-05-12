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

// ================= PIN TANIMLARI =================
const int buzzerPin = 25;
const int btnKopukPin = 32;

// ================= PERON BILGILERI =================
String bayId = "bay_42060_01_01";
String currentStatus = "baslangic";
bool isBayActive = true;
String requestedPackage = "";
int durationSec = 60;

// ================= SURE LIMITLERI =================
const int MIN_DURATION_SEC = 10;
const int MAX_DURATION_SEC = 3600;

// ================= BAGLANTI TIMEOUTLARI =================
const unsigned long WIFI_TIMEOUT_MS = 15000;
const unsigned long FIREBASE_TIMEOUT_MS = 15000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;

// ================= BEKLEME SERIDI =================
unsigned long beklemeBaslangicMs = 0;
const unsigned long BEKLEME_SURESI_MS = 60000;
int sonSeritGenisligi = -1;

// ================= HATA EKRANI =================
unsigned long hataEkraniBaslangicMs = 0;
bool hataEkraniGosteriliyor = false;

// ================= ISLEM VE KILITLER =================
unsigned long islemBaslangicMs = 0;
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

// ================= YARDIMCI FONKSIYONLAR =================

String bayPath() {
  return "/bays/" + bayId;
}

void resetSayacDurumu() {
  sayacSonEkranSaniye = -1;
  sayacSonYarimSaniyeMs = 0;
  sayacIslemBittiCalindi = false;
}

int guvenliDurationOku(int gelenSure) {
  if (gelenSure < MIN_DURATION_SEC || gelenSure > MAX_DURATION_SEC) {
    Serial.print("Gecersiz durationSec geldi: ");
    Serial.println(gelenSure);
    Serial.print("Mevcut sure korunuyor: ");
    Serial.println(durationSec);
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
}

// ================= QR CIZIMI =================

void drawQR_to_TFT(esp_qrcode_handle_t qrcode) {
  int size = esp_qrcode_get_size(qrcode);

  if (size <= 0) {
    return;
  }

  int pixelSize = tft.height() / size;
  if (pixelSize < 1) {
    pixelSize = 1;
  }

  int offsetX = (tft.width() - (size * pixelSize)) / 2;
  int offsetY = (tft.height() - (size * pixelSize)) / 2;

  for (int y = 0; y < size; y++) {
    for (int x = 0; x < size; x++) {
      if (esp_qrcode_get_module(qrcode, x, y)) {
        tft.fillRect(
          offsetX + (x * pixelSize),
          offsetY + (y * pixelSize),
          pixelSize,
          pixelSize,
          TFT_BLACK
        );
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

// ================= WIFI / FIREBASE =================

bool wifiBaglan(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  Serial.println("WiFi baglantisi baslatiliyor...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long baslangic = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - baslangic < timeoutMs) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi baglandi. IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("WiFi baglanamadi.");
  return false;
}

bool firebaseHazirBekle(unsigned long timeoutMs) {
  unsigned long baslangic = millis();

  while (!Firebase.ready() && millis() - baslangic < timeoutMs) {
    delay(300);
    Serial.print(".");
  }

  Serial.println();

  if (Firebase.ready()) {
    Serial.println("Firebase hazir.");
    return true;
  }

  Serial.println("Firebase hazir olmadi.");
  return false;
}

bool streamBaslat() {
  if (!Firebase.ready()) {
    Serial.println("Stream baslatilamadi: Firebase hazir degil.");
    return false;
  }

  String path = bayPath();

  if (!Firebase.RTDB.beginStream(&streamFbdo, path.c_str())) {
    Serial.print("Stream baslatilamadi: ");
    Serial.println(streamFbdo.errorReason());
    return false;
  }

  Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);

  Serial.print("Stream baslatildi: ");
  Serial.println(path);

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

// ================= NABIZ =================

void nabizGonder() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Nabiz atlandi: WiFi bagli degil.");
    return;
  }

  if (!Firebase.ready()) {
    Serial.println("Nabiz atlandi: Firebase hazir degil.");
    return;
  }

  String path = bayPath() + "/lastSeen";

  if (Firebase.RTDB.setTimestamp(&fbdo, path.c_str())) {
    Serial.print("Nabiz gonderildi: ");
    Serial.println(bayId);
  } else {
    Serial.println("Nabiz gonderilemedi.");
    Serial.print("Hata sebebi: ");
    Serial.println(fbdo.errorReason());
  }
}

// ================= EKRAN SAYACI VE SES =================

void ekrandaSayaciGuncelle() {
  unsigned long islemSuresiMs = (unsigned long)durationSec * 1000UL;
  unsigned long gecenMs = millis() - islemBaslangicMs;

  if (gecenMs < islemSuresiMs) {
    unsigned long kalanMs = islemSuresiMs - gecenMs;
    int toplamSaniye = kalanMs / 1000;
    int saniye = toplamSaniye % 60;
    int dakika = toplamSaniye / 60;

    // Ses mantigi
    if (toplamSaniye >= 10) {
      if (toplamSaniye != sayacSonEkranSaniye) {
        tone(buzzerPin, 2000, 100);
      }
    } else {
      if (millis() - sayacSonYarimSaniyeMs >= 500) {
        tone(buzzerPin, 2500, 100);
        sayacSonYarimSaniyeMs = millis();
      }
    }

    // Ekran guncelleme
    if (toplamSaniye != sayacSonEkranSaniye) {
      tft.setTextColor(TFT_YELLOW, TFT_BLACK);
      tft.setTextSize(5);
      tft.setCursor(80, 120);
      tft.printf("%02d:%02d   ", dakika, saniye);

      sayacSonEkranSaniye = toplamSaniye;
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
  }
}

// ================= STREAM CALLBACK =================

void streamCallback(FirebaseStream data) {
  String path = data.dataPath();

  // Kendi gonderdigimiz veya ekrani ilgilendirmeyen alanlar sayaci sifirlamasin.
  if (path == "/lastSeen" || path == "/updatedAt") {
    return;
  }

  durumDegisti = true;

  if (data.dataType() == "json") {
    StaticJsonDocument<512> doc;

    DeserializationError err = deserializeJson(doc, data.jsonString());

    if (err) {
      Serial.print("JSON parse hatasi: ");
      Serial.println(err.c_str());
      return;
    }

    if (doc.containsKey("status")) {
      currentStatus = doc["status"].as<String>();
    }

    if (doc.containsKey("isActive")) {
      isBayActive = doc["isActive"].as<bool>();
    }

    if (doc.containsKey("requestedPackage")) {
      requestedPackage = doc["requestedPackage"].as<String>();
    }

    if (doc.containsKey("durationSec")) {
      int gelenSure = doc["durationSec"].as<int>();
      durationSec = guvenliDurationOku(gelenSure);
    }
  } else {
    if (path == "/status") {
      currentStatus = data.stringData();
    } else if (path == "/isActive") {
      isBayActive = data.boolData();
    } else if (path == "/requestedPackage") {
      requestedPackage = data.stringData();
    } else if (path == "/durationSec") {
      int gelenSure = data.intData();
      durationSec = guvenliDurationOku(gelenSure);
    }
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) {
    Serial.println("Stream timeout. Firebase otomatik yeniden baglanmayi deneyecek.");
  }
}

// ================= SETUP =================

void setup() {
  Serial.begin(115200);

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
  tft.println("WiFi Baglaniyor...");

  bool wifiOk = wifiBaglan(WIFI_TIMEOUT_MS);

  if (!wifiOk) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    sonWifiDenemeMs = millis();
    return;
  }

  firebaseKurulumYap();

  Serial.print("Firebase baglantisi bekleniyor");
  bool firebaseOk = firebaseHazirBekle(FIREBASE_TIMEOUT_MS);

  if (!firebaseOk) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    return;
  }

  streamBaslatildi = streamBaslat();

  if (!streamBaslatildi) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    return;
  }

  Serial.println("Sistem hazir.");

  nabizGonder();
  sonNabizZamani = millis();
}

// ================= LOOP =================

void loop() {
  static String eskiDurum = "";

  // WiFi koparsa periyodik yeniden baglanma denemesi yap.
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - sonWifiDenemeMs >= WIFI_RETRY_INTERVAL_MS) {
      sonWifiDenemeMs = millis();

      ekranaBaglantiHatasiYaz();

      if (wifiBaglan(WIFI_TIMEOUT_MS)) {
        isBayActive = true;
        currentStatus = "baslangic";
        durumDegisti = true;

        if (!firebaseBaslatildi) {
          firebaseKurulumYap();
        }

        if (firebaseHazirBekle(FIREBASE_TIMEOUT_MS)) {
          streamBaslatildi = streamBaslat();
          nabizGonder();
          sonNabizZamani = millis();
        }
      }
    }

    return;
  }

  // Firebase hazir degilse stream veya nabiz islerine girme.
  if (firebaseBaslatildi && Firebase.ready() && !streamBaslatildi) {
    streamBaslatildi = streamBaslat();
  }

  // 30 saniyede bir nabiz gonder.
  if (millis() - sonNabizZamani >= nabizAraligi) {
    sonNabizZamani = millis();
    nabizGonder();
  }

  // Hata ekrani asenkron bekleme.
  if (hataEkraniGosteriliyor) {
    if (millis() - hataEkraniBaslangicMs >= 2000) {
      hataEkraniGosteriliyor = false;
      dokunmatikKilit = false;
      durumDegisti = true;
    }

    return;
  }

  // Odeme bekleme timeout.
  if (odemeBekleniyor && currentStatus == "waiting") {
    if (millis() - odemeBeklemeBaslangicMs >= ODEME_BEKLEME_TIMEOUT_MS) {
      Serial.println("Odeme bekleme timeout. Secim ekrani tekrar aciliyor.");

      odemeBekleniyor = false;
      dokunmatikKilit = false;
      durumDegisti = true;

      // Backend destekliyorsa eski secimi temizlemek iyi olur.
      if (Firebase.ready()) {
        String path = bayPath() + "/hardwareSelection";
        Firebase.RTDB.setString(&fbdo, path.c_str(), "");
      }
    }
  }

  // 1. Oncelik: aktiflik ve kapali durum.
  if (!isBayActive || currentStatus == "offline") {
    if (durumDegisti) {
      durumDegisti = false;
      eskiDurum = currentStatus;
      ekranaKapaliYaz();
      Serial.println("DURUM: PERON KAPALI");
    }

    return;
  }

  // 2. Durum degisiklikleri.
  if (durumDegisti) {
    durumDegisti = false;

    Serial.print("YENI DURUM: ");
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

      // Busy durumuna ilk kez girildiginde sureyi baslat.
      if (eskiDurum != "busy") {
        islemBaslangicMs = millis();
        resetSayacDurumu();
      }
    } else {
      Serial.print("Bilinmeyen durum: ");
      Serial.println(currentStatus);

      tft.fillScreen(TFT_BLACK);
      tft.setTextColor(TFT_RED);
      tft.setTextSize(2);
      tft.setCursor(20, 100);
      tft.println("Bilinmeyen Durum");
    }

    eskiDurum = currentStatus;
  }

  // 3. Surekli gorevler.
  if (currentStatus == "busy") {
    ekrandaSayaciGuncelle();
  } else if (currentStatus == "waiting" && !dokunmatikKilit) {
    unsigned long gecenZaman = millis() - beklemeBaslangicMs;

    if (gecenZaman <= BEKLEME_SURESI_MS) {
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
  }

  // 4. Dokunmatik ve fiziksel buton kontrolu.
  if (currentStatus == "waiting" && !dokunmatikKilit && !hataEkraniGosteriliyor) {
    String secilenPaket = "";

    // Fiziksel buton sadece KOPUK icin.
    if (digitalRead(btnKopukPin) == LOW) {
      secilenPaket = "foam";
    }

    // Dokunmatik secim.
    if (secilenPaket == "") {
      uint16_t x, y;

      if (tft.getTouch(&x, &y)) {
        if (y > 80 && y < 170) {
          if (x > 20 && x < 150) {
            // SOL BUTON: SU
            secilenPaket = "wash";
          } else if (x > 170 && x < 300) {
            // SAG BUTON: KOPUK
            secilenPaket = "foam";
          }
        }
      }
    }

    if (secilenPaket != "") {
      dokunmatikKilit = true;

      tft.fillScreen(TFT_BLACK);
      tft.setCursor(20, 110);
      tft.setTextSize(2);
      tft.setTextColor(TFT_YELLOW);
      tft.println("Istek iletiliyor...");

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

      String path = bayPath() + "/hardwareSelection";

      if (Firebase.RTDB.setString(&fbdo, path.c_str(), secilenPaket)) {
        tft.fillScreen(TFT_BLACK);
        tft.setCursor(20, 110);
        tft.setTextColor(TFT_WHITE);
        tft.println("Odeme bekleniyor...");

        odemeBekleniyor = true;
        odemeBeklemeBaslangicMs = millis();
      } else {
        Serial.print("Secim gonderilemedi: ");
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