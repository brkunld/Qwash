#pragma once
// QWASH peron firmware'i (Faz 3 SPIKE). Kontrat: docs/IOT.md
// Donanim: ESP32-32E 3.2" ST7789 240x320 (SKU E32R32P).

#define FW_VERSION "0.1.0-spike"

// ---- Ekran pinleri (E32R32P uretici semasi; kartinla dogrula) ----
constexpr int PIN_TFT_SCLK = 14;
constexpr int PIN_TFT_MOSI = 13;
constexpr int PIN_TFT_MISO = 12;
constexpr int PIN_TFT_CS = 15;
constexpr int PIN_TFT_DC = 2;
constexpr int PIN_TFT_BL = 27;
constexpr bool TFT_INVERT = true;  // E32R32P'de dogrulandi (false iken renkler tersti).
constexpr int TFT_ROTATION = 1;     // 1 = yatay (320x240). 0/2 dikey.

// ---- Role pinleri ----
// GUVENLI VARSAYILAN: -1 = role baglanmamis (kuru calisma, yalniz log/ekran/MQTT).
// Kartin genisleme pinlerinden bos olanlari sen dogrulayip doldur. Role 1..4 sirasiyla
// Su, Kopuk, Cila, Hava (docs/IOT.md). Ilk denemede role yerine LED/multimetre kullan.
constexpr int RELAY_PINS[4] = {-1, -1, -1, -1};
constexpr bool RELAY_ACTIVE_HIGH = true;

// ---- Guvenlik sinirlari ----
constexpr uint32_t MAX_SESSION_SEC = 3600;   // Bundan uzun START reddedilir.
constexpr uint32_t WDT_TIMEOUT_SEC = 15;     // docs/IOT.md
constexpr uint32_t NVS_SAVE_EVERY_MS = 3000;  // Seans kalan suresi kayit araligi (yeniden baslamada kaybedilen sure <= 3 sn).

// ---- Zamanlamalar ----
constexpr uint32_t HEARTBEAT_EVERY_MS = 30000;
constexpr uint32_t MQTT_RETRY_MS = 5000;
constexpr uint32_t WIFI_RETRY_MS = 15000;  // Wi-Fi kopunca kendi yeniden deneme araligi.

// ---- Portal ile ayarlanabilen varsayilanlar (NVS'te saklanir) ----
#define DEFAULT_MQTT_HOST "192.168.1.100"  // Bilgisayarinin LAN IP'si
#define DEFAULT_MQTT_PORT "11883"          // docker/docker-compose.dev.yml
#define DEFAULT_STATION_ID "STATION-01"
#define DEFAULT_BAY_ID "BAY-001"
// QR icerigi = QR_BASE + bayId. Gercek alan adi belli olunca portaldan guncellenir.
#define DEFAULT_QR_BASE "https://qwash.example/b/"
