#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <TFT_eSPI.h>
#include <ArduinoJson.h>
#include <pgmspace.h>
#include "secrets.h"

// ================= OPTIMIZASYON AYARLARI =================
// Uretimde 0 kalsin. Debug gerekirse 1 yap.
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

// ================= PIN TANIMLARI =================
const int buzzerPin = 25;
const int btnKopukPin = 32;

// ================= PERON BILGILERI =================
const char bayId[] = "bay_42060_01_01";
String currentStatus = "baslangic";
bool isBayActive = true;
String requestedPackage = "";
int durationSec = 60;

// ================= SURE LIMITLERI =================
const int MIN_DURATION_SEC = 10;
const int MAX_DURATION_SEC = 3600;

// ================= BAGLANTI TIMEOUTLARI =================
const unsigned long WIFI_TIMEOUT_MS = 7000;
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

// ================= MODERN STATIK 320x240 UI =================
// Animasyon yok. Hafif, temiz, 320x240 yatay ekrana gore.
#define UI_BG       0x0841   // koyu lacivert
#define UI_PANEL    0x18E3
#define UI_PANEL2   0x2104
#define UI_TEXT     TFT_WHITE
#define UI_MUTED    0x8410
#define UI_BLUE     0x04BF
#define UI_CYAN     0x07FF
#define UI_GREEN    0x07E0
#define UI_RED      0xF800
#define UI_ORANGE   0xFD20
#define UI_YELLOW   TFT_YELLOW

void uiClear() {
  tft.fillScreen(UI_BG);
}

void uiHeader(const __FlashStringHelper *title, uint16_t accent) {
  uiClear();
  tft.fillRect(0, 0, 320, 32, UI_PANEL);
  tft.fillRect(0, 30, 320, 2, accent);

  tft.setTextSize(2);
  tft.setTextColor(UI_TEXT, UI_PANEL);
  tft.setCursor(12, 8);
  tft.print(title);
}

void uiCard(int x, int y, int w, int h, uint16_t fill, uint16_t border) {
  tft.fillRoundRect(x, y, w, h, 16, fill);
  tft.drawRoundRect(x, y, w, h, 16, border);
  tft.drawRoundRect(x + 2, y + 2, w - 4, h - 4, 14, border);
}

void uiProgress(int x, int y, int w, int value, uint16_t color) {
  tft.fillRoundRect(x, y, w, 9, 4, UI_PANEL2);
  if (value > 0) tft.fillRoundRect(x, y, value, 9, 4, color);
}

void uiStatusDots(int y, uint16_t color) {
  tft.fillCircle(138, y, 4, color);
  tft.fillCircle(160, y, 4, color);
  tft.fillCircle(182, y, 4, color);
}

void ekranaOdemeModern() {
  uiHeader(F("ODEME"), UI_GREEN);
  tft.setTextSize(2);
  tft.setTextColor(UI_TEXT, UI_BG);
  tft.setCursor(52, 96);
  tft.print(F("ODEME BEKLENIYOR"));
  uiStatusDots(150, UI_GREEN);
}

void ekranaIstekModern() {
  uiHeader(F("ISTEK"), UI_YELLOW);
  tft.setTextSize(2);
  tft.setTextColor(UI_YELLOW, UI_BG);
  tft.setCursor(58, 104);
  tft.print(F("GONDERILIYOR"));
  uiStatusDots(150, UI_YELLOW);
}

void ekranaBusyModern() {
  bool kopuk = (requestedPackage == "foam");
  uint16_t renk = kopuk ? UI_CYAN : UI_BLUE;

  uiHeader(kopuk ? F("KOPUK") : F("SU"), renk);

  tft.drawRoundRect(36, 78, 248, 88, 18, UI_PANEL2);
  tft.drawRoundRect(38, 80, 244, 84, 16, renk);

  tft.setTextSize(1);
  tft.setTextColor(UI_MUTED, UI_BG);
  tft.setCursor(126, 176);
  tft.print(F("KALAN SURE"));

  uiProgress(20, 200, 280, 280, renk);
}

// ================= YARDIMCI FONKSIYONLAR =================

void makeBayPath(char *out, size_t outSize, const char *child) {
  if (child == nullptr || child[0] == '\0') {
    snprintf(out, outSize, "/bays/%s", bayId);
  } else {
    snprintf(out, outSize, "/bays/%s/%s", bayId, child);
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
  uiHeader(F("KAPALI"), UI_RED);
  tft.setTextSize(4);
  tft.setTextColor(UI_RED, UI_BG);
  tft.setCursor(78, 100);
  tft.print(F("KAPALI"));
}

void ekranaBaglantiHatasiYaz() {
  uiHeader(F("BAGLANTI"), UI_ORANGE);
  tft.setTextSize(3);
  tft.setTextColor(UI_ORANGE, UI_BG);
  tft.setCursor(58, 96);
  tft.print(F("BAGLANTI"));
  uiStatusDots(150, UI_ORANGE);
}

void ekranaWaitingCiz() {
  dokunmatikKilit = false;
  odemeBekleniyor = false;

  beklemeBaslangicMs = millis();
  sonSeritGenisligi = -1;

  uiHeader(F("SECIM"), UI_BLUE);

  // SU solda. Yeri degismedi.
  uiCard(18, 58, 134, 118, 0x0277, UI_BLUE);
  tft.fillEllipse(67, 90, 5, 9, UI_CYAN);
  tft.fillEllipse(94, 104, 4, 7, UI_CYAN);
  tft.fillEllipse(113, 90, 5, 9, UI_CYAN);
  tft.setTextSize(4);
  tft.setTextColor(TFT_WHITE, 0x0277);
  tft.setCursor(58, 123);
  tft.print(F("SU"));

  // KOPUK sagda. Yeri degismedi.
  uiCard(168, 58, 134, 118, 0x05D6, UI_CYAN);
  tft.drawCircle(226, 90, 10, TFT_WHITE);
  tft.drawCircle(247, 100, 8, TFT_WHITE);
  tft.drawCircle(215, 108, 7, TFT_WHITE);
  tft.drawCircle(238, 116, 5, TFT_WHITE);
  tft.setTextSize(2);
  tft.setTextColor(TFT_BLACK, 0x05D6);
  tft.setCursor(185, 128);
  tft.print(F("KOPUK"));

  uiProgress(20, 198, 280, 280, UI_GREEN);
}


// ================= SABIT QR BITMAP =================
// QR metni: bay_42060_01_01
// qrcode.h ve esp_qrcode_generate kaldirildi.
// Sabit QR PROGMEM'den cizilir; sketch boyutu ve calisma yuku azalir.
#define FIXED_QR_SIZE 33
#define FIXED_QR_BYTES_PER_ROW 5

const uint8_t fixedQrBitmap[] PROGMEM = {
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0F, 0xE1, 0x4B, 0xF8,
  0x00, 0x08, 0x2E, 0xBA, 0x08, 0x00, 0x0B, 0xA6, 0xEA, 0xE8, 0x00, 0x0B,
  0xA7, 0xF2, 0xE8, 0x00, 0x0B, 0xA9, 0xA2, 0xE8, 0x00, 0x08, 0x27, 0xC2,
  0x08, 0x00, 0x0F, 0xEA, 0xAB, 0xF8, 0x00, 0x00, 0x04, 0xE8, 0x00, 0x00,
  0x0A, 0xA1, 0xB8, 0x90, 0x00, 0x03, 0x48, 0xB0, 0x68, 0x00, 0x06, 0xE6,
  0x44, 0xF8, 0x00, 0x05, 0xD6, 0x13, 0x00, 0x00, 0x08, 0x7A, 0x83, 0x68,
  0x00, 0x03, 0xC1, 0xC3, 0x38, 0x00, 0x0A, 0x65, 0xAA, 0x58, 0x00, 0x05,
  0x5A, 0xF4, 0x58, 0x00, 0x09, 0xF7, 0x2F, 0xC8, 0x00, 0x00, 0x0F, 0x28,
  0x98, 0x00, 0x0F, 0xE2, 0x5A, 0xB8, 0x00, 0x08, 0x21, 0x18, 0xC8, 0x00,
  0x0B, 0xAC, 0x8F, 0xD0, 0x00, 0x0B, 0xA1, 0xCC, 0xD0, 0x00, 0x0B, 0xAD,
  0xB4, 0x88, 0x00, 0x08, 0x20, 0xE5, 0x50, 0x00, 0x0F, 0xEB, 0x3E, 0xD8,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

void drawFixedQR(int ox, int oy, int scale) {
  int qrPx = FIXED_QR_SIZE * scale;
  tft.fillRect(ox - 8, oy - 8, qrPx + 16, qrPx + 16, TFT_WHITE);

  for (int y = 0; y < FIXED_QR_SIZE; y++) {
    for (int x = 0; x < FIXED_QR_SIZE; x++) {
      int index = y * FIXED_QR_BYTES_PER_ROW + (x / 8);
      uint8_t b = pgm_read_byte(&fixedQrBitmap[index]);

      if (b & (0x80 >> (x % 8))) {
        tft.fillRect(ox + x * scale, oy + y * scale, scale, scale, TFT_BLACK);
      }
    }
  }
}

void ekranaQRCiz(const char *metin) {
  (void)metin;
  tft.fillScreen(TFT_WHITE);
  drawFixedQR(54, 14, 7);
}

// ================= WIFI / FIREBASE =================

bool wifiBaglan(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  LOG_PRINTLN(F("WiFi baslatiliyor..."));
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long baslangic = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - baslangic < timeoutMs) {
    delay(500);
    LOG_PRINT(F("."));
  }

  LOG_PRINTLN(F(""));

  if (WiFi.status() == WL_CONNECTED) {
    LOG_PRINT(F("IP: "));
    LOG_PRINTLN(WiFi.localIP());
    return true;
  }

  LOG_PRINTLN(F("WiFi yok."));
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

  Firebase.RTDB.setStreamCallback(&streamFbdo, streamCallback, streamTimeoutCallback);

  LOG_PRINT(F("Stream: "));
  LOG_PRINTLN(path);

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
      bool kopuk = (requestedPackage == "foam");
      uint16_t renk = kopuk ? UI_CYAN : UI_BLUE;

      tft.fillRect(56, 96, 210, 56, UI_BG);
      tft.setTextColor((toplamSaniye <= 10) ? UI_RED : TFT_WHITE, UI_BG);
      tft.setTextSize(5);
      tft.setCursor(68, 108);
      tft.printf("%02d:%02d", dakika, saniye);

      int barW = map(gecenMs, 0, islemSuresiMs, 280, 0);
      uiProgress(20, 200, 280, barW, renk);

      sayacSonEkranSaniye = toplamSaniye;
    }

    sayacIslemBittiCalindi = false;
  } else if (!sayacIslemBittiCalindi) {
    tone(buzzerPin, 1000, 3000);

    uiHeader(F("BITTI"), UI_GREEN);
    tft.setTextColor(UI_GREEN, UI_BG);
    tft.setTextSize(4);
    tft.setCursor(62, 100);
    tft.print(F("BITTI"));

    sayacIslemBittiCalindi = true;
  }
}

// ================= STREAM CALLBACK =================

void streamCallback(FirebaseStream data) {
  String path = data.dataPath();

  // 1. Kendi gönderdiğimiz veya arayüzü doğrudan değiştirmeyen verileri filtrele
  // /hardwareSelection buraya EKLENMELİ, aksi halde kendi seçimimiz ekranı sıfırlar!
  if (path == "/lastSeen" || path == "/updatedAt" || path == "/hardwareSelection") {
    return;
  }

  bool durumFarkli = false;

  if (data.dataType() == "json") {
    // Heap kullanmamak icin StaticJsonDocument kullaniyoruz.
    StaticJsonDocument<768> doc;

    DeserializationError err = deserializeJson(doc, data.jsonString());
    if (err) {
      LOG_PRINT(F("JSON hata: "));
      LOG_PRINTLN(err.c_str());
      return;
    }

    if (doc.containsKey("status")) {
      String yeniDurum = doc["status"].as<String>();
      if (currentStatus != yeniDurum) {
        currentStatus = yeniDurum;
        durumFarkli = true; // Sadece status gerçekten değiştiyse ekranı güncelle
      }
    }

    if (doc.containsKey("isActive")) {
      bool yeniAktiflik = doc["isActive"].as<bool>();
      if (isBayActive != yeniAktiflik) {
        isBayActive = yeniAktiflik;
        durumFarkli = true;
      }
    }

    if (doc.containsKey("requestedPackage")) {
      requestedPackage = doc["requestedPackage"].as<String>();
    }

    if (doc.containsKey("durationSec")) {
      int gelenSure = doc["durationSec"].as<int>();
      durationSec = guvenliDurationOku(gelenSure);
    }
  } else {
    // Tekil alan güncellemeleri
    if (path == "/status") {
      String yeniDurum = data.stringData();
      if (currentStatus != yeniDurum) {
        currentStatus = yeniDurum;
        durumFarkli = true;
      }
    } else if (path == "/isActive") {
      bool yeniAktiflik = data.boolData();
      if (isBayActive != yeniAktiflik) {
        isBayActive = yeniAktiflik;
        durumFarkli = true;
      }
    } else if (path == "/requestedPackage") {
      requestedPackage = data.stringData();
    } else if (path == "/durationSec") {
      int gelenSure = data.intData();
      durationSec = guvenliDurationOku(gelenSure);
    }
  }

  // 3. Sadece kritik bir durum (status veya isActive) değiştiyse ana döngüye haber ver
  if (durumFarkli) {
    durumDegisti = true;
  }
}

void streamTimeoutCallback(bool timeout) {
  if (timeout) {
    LOG_PRINTLN(F("Stream timeout."));
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

  uiHeader(F("BAGLAN"), UI_BLUE);
  tft.setTextColor(UI_TEXT, UI_BG);
  tft.setTextSize(2);
  tft.setCursor(82, 104);
  tft.print(F("BAGLANIYOR"));

  bool wifiOk = wifiBaglan(WIFI_TIMEOUT_MS);

  if (!wifiOk) {
    currentStatus = "offline";
    isBayActive = false;
    ekranaBaglantiHatasiYaz();
    sonWifiDenemeMs = millis();
    return;
  }

  firebaseKurulumYap();

  LOG_PRINT(F("Firebase bekleniyor"));
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

  LOG_PRINTLN(F("Hazir."));

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
      LOG_PRINTLN(F("Odeme timeout."));

      odemeBekleniyor = false;
      dokunmatikKilit = false;
      durumDegisti = true;

      // Backend destekliyorsa eski secimi temizlemek iyi olur.
      if (Firebase.ready()) {
        char path[96];
        makeBayPath(path, sizeof(path), "hardwareSelection");
        Firebase.RTDB.setString(&fbdo, path, "");
      }
    }
  }

  // 1. Oncelik: aktiflik ve kapali durum.
  if (!isBayActive || currentStatus == "offline") {
    if (durumDegisti) {
      durumDegisti = false;
      eskiDurum = currentStatus;
      ekranaKapaliYaz();
      LOG_PRINTLN(F("KAPALI"));
    }

    return;
  }

  // 2. Durum degisiklikleri.
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

      uiHeader(F("BAKIM"), UI_ORANGE);
      tft.setTextColor(UI_ORANGE, UI_BG);
      tft.setTextSize(4);
      tft.setCursor(58, 100);
      tft.print(F("BAKIM"));
    } else if (currentStatus == "waiting") {
      ekranaWaitingCiz();
    } else if (currentStatus == "busy") {
      dokunmatikKilit = true;
      odemeBekleniyor = false;

      ekranaBusyModern();

      // Busy durumuna ilk kez girildiginde sureyi baslat.
      if (eskiDurum != "busy") {
        islemBaslangicMs = millis();
        resetSayacDurumu();
      }
    } else {
      LOG_PRINT(F("Bilinmeyen: "));
      Serial.println(currentStatus);

      uiHeader(F("HATA"), UI_RED);
      tft.setTextColor(UI_RED, UI_BG);
      tft.setTextSize(3);
      tft.setCursor(76, 100);
      tft.print(F("DURUM"));
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
        uiProgress(20, 198, maxGenislik, guncelGenislik, UI_GREEN);
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
            secilenPaket = "foam";
          } else if (x > 170 && x < 300) {
            secilenPaket = "wash";
          }
        }
      }
    }

    if (secilenPaket != "") {
      dokunmatikKilit = true;

      ekranaIstekModern();

      delay(120);

      if (!Firebase.ready()) {
        ekranaBaglantiHatasiYaz();

        hataEkraniGosteriliyor = true;
        hataEkraniBaslangicMs = millis();
        return;
      }

      char path[96];
      makeBayPath(path, sizeof(path), "hardwareSelection");

      if (Firebase.RTDB.setString(&fbdo, path, secilenPaket)) {
        ekranaOdemeModern();

        odemeBekleniyor = true;
        odemeBeklemeBaslangicMs = millis();
      } else {
        LOG_PRINT(F("Secim hata: "));
        Serial.println(fbdo.errorReason());

        ekranaBaglantiHatasiYaz();

        hataEkraniGosteriliyor = true;
        hataEkraniBaslangicMs = millis();
      }
    }
  }
}