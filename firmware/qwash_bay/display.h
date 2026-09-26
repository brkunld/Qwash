#pragma once
// Ekran + dokunmatik (docs/IOT.md). Bosta QR; musteri telefonda onaylayinca peron ekrani
// onun hesabina baglanir ve paket/sure dokunmatikten secilir; seans surerken sure + DURDUR.
// LovyanGFX kullanilir; TFT_eSPI'nin aksine ayar kutuphane klasorunde degil bu dosyadadir.
// Ekran fontlari yalniz ASCII basar: metinler backend'den sadelesmis (Turkce harfsiz) gelir.
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include "config.h"

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7789 _panel;
  lgfx::Bus_SPI _bus;
  lgfx::Light_PWM _light;
  lgfx::Touch_XPT2046 _touch;

 public:
  LGFX() {
    {
      auto c = _bus.config();
      c.spi_host = SPI2_HOST;
      c.spi_mode = 0;
      c.freq_write = 40000000;
      c.freq_read = 16000000;
      c.spi_3wire = false;
      c.use_lock = true;
      c.dma_channel = SPI_DMA_CH_AUTO;
      c.pin_sclk = PIN_TFT_SCLK;
      c.pin_mosi = PIN_TFT_MOSI;
      c.pin_miso = PIN_TFT_MISO;
      c.pin_dc = PIN_TFT_DC;
      _bus.config(c);
      _panel.setBus(&_bus);
    }
    {
      auto c = _panel.config();
      c.pin_cs = PIN_TFT_CS;
      c.pin_rst = -1;
      c.pin_busy = -1;
      c.panel_width = 240;
      c.panel_height = 320;
      c.offset_x = 0;
      c.offset_y = 0;
      c.readable = false;
      c.invert = TFT_INVERT;
      c.rgb_order = false;
      c.dlen_16bit = false;
      c.bus_shared = true;  // Dokunmatik ayni SPI hattinda
      _panel.config(c);
    }
    {
      auto c = _light.config();
      c.pin_bl = PIN_TFT_BL;
      c.invert = false;
      c.freq = 44100;
      c.pwm_channel = 7;
      _light.config(c);
      _panel.setLight(&_light);
    }
    {
      // XPT2046 ekranla ayni SPI hattinda, yalniz CS farkli (Burak'in TFT_eSPI ayarinda TOUCH_CS 33).
      // Ham sinirlar yaklasiktir; kesin eslesme kalibrasyonla (acilista ekrana basili tut) gelir.
      auto c = _touch.config();
      c.x_min = 300;
      c.x_max = 3900;
      c.y_min = 200;
      c.y_max = 3800;
      c.pin_int = PIN_TOUCH_IRQ;
      c.bus_shared = true;
      c.offset_rotation = 0;
      c.spi_host = SPI2_HOST;
      c.freq = 1000000;
      c.pin_sclk = PIN_TFT_SCLK;
      c.pin_mosi = PIN_TFT_MOSI;
      c.pin_miso = PIN_TFT_MISO;
      c.pin_cs = PIN_TOUCH_CS;
      _touch.config(c);
      _panel.setTouch(&_touch);
    }
    setPanel(&_panel);
  }
};

static LGFX gfx;

enum class UiMode { BOOT, IDLE, RUNNING, DONE, ERROR_, MENU_PROGRAMS, MENU_DURATIONS, MENU_WAITING };

// ---------- Dokunmatik bolgeleri (yatay 320x240) ----------
struct Btn {
  int16_t x, y, w, h;
  bool hit(int32_t px, int32_t py) const { return px >= x && px < x + w && py >= y && py < y + h; }
};

// Paket izgarasi: 2 sutun x 3 satir.
static Btn programBtn(uint8_t i) {
  return {(int16_t)(5 + (i % 2) * 158), (int16_t)(52 + (i / 2) * 50), 152, 46};
}
static Btn durationBtn(uint8_t i) { return {5, (int16_t)(52 + i * 50), 310, 46}; }
static const Btn BTN_EXIT = {5, 204, 110, 32};
static const Btn BTN_BACK = {5, 204, 110, 32};
static const Btn BTN_STOP = {60, 170, 200, 60};

static void uiBegin() {
  gfx.init();
  gfx.setRotation(TFT_ROTATION);
  gfx.setBrightness(200);
  gfx.fillScreen(TFT_BLACK);
}

static void uiCenterText(const char* text, int y, int size, uint16_t color) {
  gfx.setFont(&fonts::Font0);
  gfx.setTextDatum(textdatum_t::top_center);
  gfx.setTextColor(color, TFT_BLACK);
  gfx.setTextSize(size);
  gfx.drawString(text, gfx.width() / 2, y);
}

static void uiButton(const Btn& b, const char* line1, const char* line2, uint16_t bg, uint16_t fg) {
  gfx.fillRoundRect(b.x, b.y, b.w, b.h, 8, bg);
  gfx.setFont(&fonts::Font2);
  gfx.setTextSize(1);
  gfx.setTextColor(fg, bg);
  gfx.setTextDatum(textdatum_t::middle_center);
  if (line2 && line2[0]) {
    gfx.drawString(line1, b.x + b.w / 2, b.y + b.h / 2 - 9);
    gfx.drawString(line2, b.x + b.w / 2, b.y + b.h / 2 + 9);
  } else {
    gfx.drawString(line1, b.x + b.w / 2, b.y + b.h / 2);
  }
}

// "12,50 TL"
static void fmtTl(char* out, size_t n, int64_t kurus) {
  if (kurus < 0) kurus = 0;
  snprintf(out, n, "%lld,%02lld TL", (long long)(kurus / 100), (long long)(kurus % 100));
}

// Bosta: peron QR'i + kisa peron kodu. QR yalniz cihazin urettigi adrestir.
static void uiIdle(const char* qrUrl, const char* bayId, bool wifiOk, bool mqttOk) {
  gfx.fillScreen(TFT_BLACK);
  int qrSize = gfx.height() - 72;
  int qx = (gfx.width() - qrSize) / 2, qy = 10;
  // Okuyucular icin QR'in cevresinde beyaz sessiz bolge (quiet zone) gerekir.
  gfx.fillRect(qx - 8, qy - 8, qrSize + 16, qrSize + 16, TFT_WHITE);
  gfx.qrcode(qrUrl, qx, qy, qrSize, 4);
  uiCenterText(bayId, gfx.height() - 50, 3, TFT_WHITE);
  const char* st = !wifiOk ? "WIFI YOK" : (!mqttOk ? "SUNUCU YOK" : "HAZIR");
  uiCenterText(st, gfx.height() - 22, 2, (wifiOk && mqttOk) ? TFT_GREEN : TFT_YELLOW);
}

// Menu ust satiri: sol baslik + alt bilgi. Geri sayim uiCountdown ile yalniz kendi alanini boyar.
static void uiHeader(const char* title, const char* sub) {
  gfx.fillRect(0, 0, gfx.width(), 48, TFT_BLACK);
  gfx.setFont(&fonts::Font2);
  gfx.setTextSize(1);
  gfx.setTextDatum(textdatum_t::top_left);
  gfx.setTextColor(TFT_WHITE, TFT_BLACK);
  gfx.drawString(title, 6, 4);
  gfx.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  gfx.drawString(sub, 6, 26);
}

static void uiCountdown(uint32_t sec) {
  char buf[12];
  snprintf(buf, sizeof(buf), "%u sn", (unsigned)sec);
  gfx.fillRect(250, 0, 70, 24, TFT_BLACK);
  gfx.setFont(&fonts::Font2);
  gfx.setTextSize(1);
  gfx.setTextDatum(textdatum_t::top_right);
  gfx.setTextColor(sec <= 10 ? TFT_ORANGE : TFT_YELLOW, TFT_BLACK);
  gfx.drawString(buf, 314, 4);
}

// Alt satirdaki kisa bilgi/hata (Orn: "BAKIYE YETERSIZ").
static void uiFooterMessage(const char* msg, uint16_t color) {
  gfx.fillRect(120, 204, 200, 32, TFT_BLACK);
  if (!msg || !msg[0]) return;
  gfx.setFont(&fonts::Font2);
  gfx.setTextSize(1);
  gfx.setTextDatum(textdatum_t::middle_right);
  gfx.setTextColor(color, TFT_BLACK);
  gfx.drawString(msg, 314, 220);
}

static void uiMessage(const char* text, uint16_t color) {
  gfx.fillScreen(TFT_BLACK);
  // Font0 karakteri 6 px * boyut; 320 px'e sigmayan metin kucuk boyutla yazilir.
  int size = strlen(text) * 6 * 4 <= gfx.width() - 10 ? 4 : 3;
  uiCenterText(text, gfx.height() / 2 - 20, size, color);
}

// Seans: kalan sure (buyuk) + durum + DURDUR. Saniyelik guncelleme yalniz sureyi boyar (titreme olmasin).
static void uiRunningTime(uint32_t remainingSec) {
  char buf[12];
  snprintf(buf, sizeof(buf), "%02u:%02u", (unsigned)(remainingSec / 60), (unsigned)(remainingSec % 60));
  gfx.fillRect(0, 20, gfx.width(), 72, TFT_BLACK);
  uiCenterText(buf, 24, 8, TFT_WHITE);
}

static void uiRunning(uint32_t remainingSec, const char* status, uint16_t color, bool showStop, bool stopSent) {
  gfx.fillScreen(TFT_BLACK);
  uiRunningTime(remainingSec);
  uiCenterText(status, 110, 3, color);
  if (showStop) {
    uiButton(BTN_STOP, stopSent ? "DURDURULUYOR" : "DURDUR", nullptr, stopSent ? TFT_DARKGREY : TFT_RED,
             TFT_WHITE);
  }
}
