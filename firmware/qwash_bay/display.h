#pragma once
// Ekran: yalniz sure gosterir (docs/IOT.md). Dokunmatik MVP'de kullanilmaz.
// LovyanGFX kullanilir; TFT_eSPI'nin aksine ayar kutuphane klasorunde degil bu dosyadadir.
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include "config.h"

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7789 _panel;
  lgfx::Bus_SPI _bus;
  lgfx::Light_PWM _light;

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
      c.bus_shared = false;
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
    setPanel(&_panel);
  }
};

static LGFX gfx;

enum class UiMode { BOOT, IDLE, RUNNING, DONE, ERROR_ };

static void uiBegin() {
  gfx.init();
  gfx.setRotation(TFT_ROTATION);
  gfx.setBrightness(200);
  gfx.fillScreen(TFT_BLACK);
}

static void uiCenterText(const char* text, int y, int size, uint16_t color) {
  gfx.setTextDatum(textdatum_t::top_center);
  gfx.setTextColor(color, TFT_BLACK);
  gfx.setTextSize(size);
  gfx.drawString(text, gfx.width() / 2, y);
}

// Bosta: peron QR'i + kisa peron kodu. QR yalniz cihazin urettigi adrestir.
static void uiIdle(const char* qrUrl, const char* bayId, bool wifiOk, bool mqttOk) {
  gfx.fillScreen(TFT_BLACK);
  int qrSize = gfx.height() - 60;
  gfx.qrcode(qrUrl, (gfx.width() - qrSize) / 2, 4, qrSize, 4);
  // QR beyaz zemin uzerinde okunur; siyah zemin sorun cikarirsa fillRect ile beyaz cerceve ekle.
  uiCenterText(bayId, gfx.height() - 50, 3, TFT_WHITE);
  const char* st = !wifiOk ? "WIFI YOK" : (!mqttOk ? "SUNUCU YOK" : "HAZIR");
  uiCenterText(st, gfx.height() - 22, 2, (wifiOk && mqttOk) ? TFT_GREEN : TFT_YELLOW);
}

// Seans: yalniz kalan sure + kisa durum metni.
static void uiRunning(uint32_t remainingSec, const char* status, uint16_t color) {
  char buf[12];
  snprintf(buf, sizeof(buf), "%02u:%02u", (unsigned)(remainingSec / 60), (unsigned)(remainingSec % 60));
  gfx.fillScreen(TFT_BLACK);
  uiCenterText(buf, gfx.height() / 2 - 45, 8, TFT_WHITE);
  uiCenterText(status, gfx.height() - 50, 3, color);
}

static void uiMessage(const char* text, uint16_t color) {
  gfx.fillScreen(TFT_BLACK);
  uiCenterText(text, gfx.height() / 2 - 20, 4, color);
}
