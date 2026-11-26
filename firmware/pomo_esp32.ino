/*
 * POMO — ESP32-C3 Super Mini Pomodoro firmware
 * ------------------------------------------------
 * Hardware:
 *   - ESP32-C3 Super Mini
 *   - 1.28" GC9A01 round IPS 240x240 (LovyanGFX)
 *   - Rotary encoder with push button
 *   - USB-C power
 *   - NO buzzer is used or required
 *
 * Wiring (as specified):
 *   Display SCLK -> GPIO 4
 *   Display MOSI -> GPIO 6
 *   Display RST  -> GPIO 3
 *   Display DC   -> GPIO 2
 *   Display CS   -> GPIO 7
 *   Encoder CLK  -> GPIO 0
 *   Encoder DT   -> GPIO 1
 *   Encoder SW   -> GPIO 5
 *
 * BLE name: espstudy
 * Service:  7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000
 * Status:   7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000 (READ / NOTIFY)
 * Command:  7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000 (WRITE / WRITE_NR)
 *
 * All code is non-blocking: Wi-Fi, NTP, timer, encoder, display and BLE are
 * polled from loop(). There are no delay() calls.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <time.h>
#include <Preferences.h>
#include <NimBLEDevice.h>

// NimBLE-Arduino 2.x and 3.x use slightly different callback signatures.
// Both are supported; 2.3.6 is the recommended version (see README).
#if __has_include(<NimBLECppVersion.h>)
  #include <NimBLECppVersion.h>
#endif
#ifndef NIMBLE_CPP_VERSION_MAJOR
  #define NIMBLE_CPP_VERSION_MAJOR 2
#endif
#define POMO_NIMBLE_V3 (NIMBLE_CPP_VERSION_MAJOR >= 3)

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
static const char* WIFI_SSID     = "Wokwi-GUEST";
static const char* WIFI_PASSWORD = "";
static const char* NTP_SERVER    = "pool.ntp.org";
static const char* TIMEZONE      = "NZST-12NZDT,M9.5.0,M4.1.0/3";

static const char* BLE_NAME      = "espstudy";
static const char* SERVICE_UUID  = "7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000";
static const char* STATUS_UUID   = "7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000";
static const char* COMMAND_UUID  = "7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000";

static const uint8_t PIN_ENC_A   = 0;
static const uint8_t PIN_ENC_B   = 1;
static const uint8_t PIN_ENC_SW  = 5;

// Framing: byte0 = generation, byte1 = sequence, byte2 = total, byte3 = length.
// 4 header bytes + 13 payload bytes = 17 bytes, which fits in a 20-byte ATT
// write/notification (default MTU 23) on every browser.
static const size_t FRAME_PAYLOAD = 13;
static const size_t FRAME_SIZE    = 17;
static const size_t MAX_FRAMES    = 16;

// ---------------------------------------------------------------------------
// Display (LovyanGFX custom configuration for the specified pins)
// ---------------------------------------------------------------------------
class LGFX_Pomo : public lgfx::LGFX_Device {
  lgfx::Bus_SPI   _bus;
  lgfx::Panel_GC9A01 _panel;

public:
  LGFX_Pomo(void) {
    {
      auto cfg = _bus.config();
      cfg.spi_host    = SPI2_HOST;       // ESP32-C3: FSPI
      cfg.spi_mode    = 0;
      cfg.freq_write  = 40000000;
      cfg.freq_read   = 16000000;
      cfg.spi_3wire   = true;            // DC pin shared, no MISO
      cfg.use_lock    = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk    = 4;
      cfg.pin_mosi    = 6;
      cfg.pin_miso    = -1;
      cfg.pin_dc      = 2;
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs       = 7;
      cfg.pin_rst      = 3;
      cfg.pin_busy     = -1;
      cfg.panel_width  = 240;
      cfg.panel_height = 240;
      cfg.memory_width = 240;
      cfg.memory_height= 240;
      cfg.offset_x     = 0;
      cfg.offset_y     = 0;
      cfg.offset_rotation = 0;
      cfg.readable     = false;
      cfg.invert       = false;
      cfg.rgb_order    = false;
      cfg.dlen_16bit   = false;
      cfg.bus_shared   = false;
      _panel.config(cfg);
    }
    setPanel(&_panel);
  }
};

static LGFX_Pomo   lcd;
static LGFX_Sprite ui(&lcd);
static bool        uiReady = false;

// Colours (RGB888; LovyanGFX converts to the panel colour depth).
static const uint32_t C_BG     = 0x0B0D11;
static const uint32_t C_TRACK  = 0x232A33;
static const uint32_t C_TEXT   = 0xF2F3F5;
static const uint32_t C_MUTED  = 0x8B929C;
static const uint32_t C_ACCENT = 0xFF6B5A;
static const uint32_t C_BREAK  = 0x7FB3C8;

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
enum PomodoroMode : uint8_t { MODE_FOCUS = 0, MODE_SHORT = 1, MODE_LONG = 2 };

static Preferences prefs;

static uint16_t durationMin[3] = {25, 5, 15};
static uint32_t remainingMs    = 25UL * 60UL * 1000UL;
static bool     timerRunning   = false;
static uint32_t lastTimerTick  = 0;

static uint8_t  currentMode    = MODE_FOCUS;
static uint32_t sessions       = 0;
static uint32_t focusMinutes   = 0;
static uint32_t dailyMinutes[7] = {0, 0, 0, 0, 0, 0, 0}; // Mon .. Sun
static int      storedWeekKey  = 0;

static bool     wifiConnected  = false;
static bool     timeSynced     = false;
static uint32_t lastWifiTry    = 0;
static uint32_t lastNtpTry     = 0;
static uint32_t lastResync     = 0;
static uint32_t clockAnchorMs  = 0;
static time_t   clockAnchorEp  = 0;

static bool     bleConnected   = false;

// BLE objects and status transmit queue.
static NimBLEServer*           pServer       = nullptr;
static NimBLEService*          pService      = nullptr;
static NimBLECharacteristic*   pStatusChar   = nullptr;
static NimBLECharacteristic*   pCommandChar  = nullptr;

struct TxFrame {
  uint8_t data[FRAME_SIZE];
  uint8_t len;
};
static TxFrame  txFrames[MAX_FRAMES];
static uint8_t  txCount   = 0;
static uint8_t  txIndex   = 0;
static uint8_t  txGen     = 0;
static bool     txActive  = false;
static uint32_t txStartMs = 0;

// Command reassembly.
static uint8_t  rxGen      = 0xFF;
static uint8_t  rxTotal    = 0;
static uint8_t  rxParts[MAX_FRAMES][FRAME_PAYLOAD];
static uint8_t  rxLens[MAX_FRAMES];
static bool     rxHave[MAX_FRAMES];
static uint32_t rxLastMs   = 0;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
static uint16_t clampMinutes(uint32_t v) {
  if (v < 1) return 1;
  if (v > 180) return 180;
  return (uint16_t)v;
}

static void loadPreferences() {
  prefs.begin("pomo", false);
  durationMin[0] = clampMinutes(prefs.getUInt("focus", 25));
  durationMin[1] = clampMinutes(prefs.getUInt("short", 5));
  durationMin[2] = clampMinutes(prefs.getUInt("long", 15));
  sessions     = prefs.getUInt("sessions", 0);
  focusMinutes = prefs.getUInt("minutes", 0);
  for (uint8_t i = 0; i < 7; ++i) {
    char key[4] = {'d', (char)('0' + i), 0, 0};
    dailyMinutes[i] = prefs.getUInt(key, 0);
  }
  storedWeekKey = prefs.getInt("week", 0);
  prefs.end();

  remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
}

static void saveSettings() {
  prefs.begin("pomo", false);
  prefs.putUInt("focus", durationMin[0]);
  prefs.putUInt("short", durationMin[1]);
  prefs.putUInt("long",  durationMin[2]);
  prefs.end();
}

static void saveStats() {
  prefs.begin("pomo", false);
  prefs.putUInt("sessions", sessions);
  prefs.putUInt("minutes", focusMinutes);
  for (uint8_t i = 0; i < 7; ++i) {
    char key[4] = {'d', (char)('0' + i), 0, 0};
    prefs.putUInt(key, dailyMinutes[i]);
  }
  prefs.putInt("week", storedWeekKey);
  prefs.end();
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
static time_t currentEpoch() {
  if (timeSynced) {
    return clockAnchorEp + (time_t)((millis() - clockAnchorMs) / 1000UL);
  }
  time_t now = time(nullptr);
  return (now > 1700000000L) ? now : 0;
}

// Monday = 0 ... Sunday = 6
static uint8_t localDayIndex(time_t epoch) {
  if (epoch < 1700000000L) return 0;
  struct tm* t = localtime(&epoch);
  if (!t) return 0;
  return (uint8_t)((t->tm_wday + 6) % 7);
}

static int currentWeekKey() {
  time_t epoch = currentEpoch();
  if (epoch < 1700000000L) return 0;
  struct tm* t = localtime(&epoch);
  if (!t) return 0;
  uint8_t mondayBack = (uint8_t)((t->tm_wday + 6) % 7);
  time_t localMidnight = epoch - (time_t)(t->tm_hour * 3600 + t->tm_min * 60 + t->tm_sec);
  time_t monday = localMidnight - (time_t)mondayBack * 86400L;
  return (int)(monday / 86400L);
}

static void pollWifiAndTime() {
  uint32_t now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) wifiConnected = true;

    if (!timeSynced) {
      time_t t = time(nullptr);
      if (t > 1700000000L) {
        clockAnchorEp = t;
        clockAnchorMs = now;
        timeSynced = true;
        int wk = currentWeekKey();
        if (storedWeekKey == 0 && wk != 0) {
          storedWeekKey = wk;
          saveStats();
        }
      } else if (now - lastNtpTry >= 2000UL) {
        configTime(0, 0, NTP_SERVER);
        lastNtpTry = now;
      }
    } else if (now - lastResync >= 1800000UL) {
      // Re-anchor to the system clock maintained by SNTP, then keep ticking
      // from millis() even if Wi-Fi drops later.
      time_t t = time(nullptr);
      if (t > 1700000000L) {
        clockAnchorEp = t;
        clockAnchorMs = now;
      }
      lastResync = now;
    }
  } else {
    if (wifiConnected) wifiConnected = false;
    if (now - lastWifiTry >= 5000UL) {
      WiFi.disconnect(false);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      lastWifiTry = now;
    }
  }

  if (timeSynced && storedWeekKey != 0) {
    int wk = currentWeekKey();
    if (wk != 0 && wk != storedWeekKey) {
      for (uint8_t i = 0; i < 7; ++i) dailyMinutes[i] = 0;
      storedWeekKey = wk;
      saveStats();
    }
  }
}

// ---------------------------------------------------------------------------
// BLE status publishing (complete JSON for READ, framed JSON for NOTIFY)
// ---------------------------------------------------------------------------
static void publishStatus() {
  char json[192];
  uint32_t remSeconds = (remainingMs + 999UL) / 1000UL;
  snprintf(json, sizeof(json),
           "{\"mode\":%u,\"rem\":%lu,\"set\":%lu,\"run\":%s,"
           "\"sessions\":%lu,\"minutes\":%lu,\"daily\":[%lu,%lu,%lu,%lu,%lu,%lu,%lu]}",
           (unsigned)currentMode,
           (unsigned long)remSeconds,
           (unsigned long)((uint32_t)durationMin[currentMode] * 60UL),
           timerRunning ? "true" : "false",
           (unsigned long)sessions,
           (unsigned long)focusMinutes,
           (unsigned long)dailyMinutes[0], (unsigned long)dailyMinutes[1],
           (unsigned long)dailyMinutes[2], (unsigned long)dailyMinutes[3],
           (unsigned long)dailyMinutes[4], (unsigned long)dailyMinutes[5],
           (unsigned long)dailyMinutes[6]);

  if (pStatusChar) pStatusChar->setValue(json);

  size_t len = strlen(json);
  uint8_t total = (uint8_t)((len + FRAME_PAYLOAD - 1) / FRAME_PAYLOAD);
  if (total == 0) total = 1;
  if (total > MAX_FRAMES) total = MAX_FRAMES;

  txGen++;
  if (txGen == 0) txGen = 1;
  size_t offset = 0;
  for (uint8_t i = 0; i < total; ++i) {
    size_t n = len - offset;
    if (n > FRAME_PAYLOAD) n = FRAME_PAYLOAD;
    txFrames[i].data[0] = txGen;
    txFrames[i].data[1] = i;
    txFrames[i].data[2] = total;
    txFrames[i].data[3] = (uint8_t)n;
    memcpy(txFrames[i].data + 4, json + offset, n);
    txFrames[i].len = (uint8_t)(4 + n);
    offset += n;
  }
  txCount = total;
  txIndex = 0;
  txStartMs = millis();
  txActive = true;
}

static void pumpStatusTx() {
  if (!txActive) return;
  if (!pServer || pServer->getConnectedCount() == 0) {
    txActive = false;
    return;
  }
  // Drop a stale batch if no client subscribed (e.g. immediately on connect).
  if (millis() - txStartMs > 3000UL) {
    txActive = false;
    return;
  }
  if (pStatusChar->notify(txFrames[txIndex].data, txFrames[txIndex].len)) {
    txIndex++;
    if (txIndex >= txCount) txActive = false;
  }
}

// ---------------------------------------------------------------------------
// Timer and command handling
// ---------------------------------------------------------------------------
static void setMode(uint8_t mode, bool notify = true) {
  if (mode > 2) return;
  currentMode = mode;
  timerRunning = false;
  remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
  lastTimerTick = millis();
  if (notify) publishStatus();
}

static void toggleTimer() {
  if (timerRunning) {
    timerRunning = false;
  } else {
    if (remainingMs == 0) remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
    timerRunning = true;
    lastTimerTick = millis();
  }
  publishStatus();
}

static void onTimerComplete() {
  timerRunning = false;
  remainingMs = 0;

  if (currentMode == MODE_FOCUS) {
    sessions++;
    uint32_t finishedMinutes = durationMin[MODE_FOCUS];
    focusMinutes += finishedMinutes;
    dailyMinutes[localDayIndex(currentEpoch())] += finishedMinutes;
    currentMode = (sessions % 4 == 0) ? MODE_LONG : MODE_SHORT;
  } else {
    currentMode = MODE_FOCUS;
  }

  remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
  lastTimerTick = millis();
  saveStats();
  publishStatus();
}

static void pollTimer() {
  uint32_t now = millis();
  if (timerRunning) {
    uint32_t delta = now - lastTimerTick;
    lastTimerTick = now;
    if (delta >= remainingMs) {
      onTimerComplete();
    } else {
      remainingMs -= delta;
    }
  } else {
    lastTimerTick = now;
  }
}

static const char* extractCmd(const char* json, size_t len) {
  static char cmd[24];
  const char* p = strstr(json, "\"cmd\"");
  if (!p) return nullptr;
  p = strchr(p, ':');
  if (!p) return nullptr;
  ++p;
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
  if (*p != '"') return nullptr;
  ++p;
  const char* end = strchr(p, '"');
  if (!end) return nullptr;
  size_t n = (size_t)(end - p);
  if (n == 0 || n >= sizeof(cmd)) return nullptr;
  // Must not run past the supplied buffer.
  if (end >= json + len) return nullptr;
  memcpy(cmd, p, n);
  cmd[n] = 0;
  return cmd;
}

static bool extractInt(const char* json, const char* key, int32_t* out) {
  char needle[16];
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  const char* p = strstr(json, needle);
  if (!p) return false;
  p = strchr(p + strlen(needle), ':');
  if (!p) return false;
  ++p;
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
  char* end = nullptr;
  long v = strtol(p, &end, 10);
  if (end == p) return false;
  while (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n') ++end;
  if (*end != ',' && *end != '}' && *end != 0) return false;
  *out = (int32_t)v;
  return true;
}

static void processCommand(const uint8_t* data, size_t len) {
  if (!data || len < 2 || len > 120) return;
  char json[128];
  memcpy(json, data, len);
  json[len] = 0;
  // Strict-enough validation: must be a single JSON object.
  if (json[0] != '{' || json[len - 1] != '}') return;

  const char* cmd = extractCmd(json, len);
  if (!cmd) return;

  if (strcmp(cmd, "toggle") == 0) {
    toggleTimer();
    return;
  }
  if (strcmp(cmd, "start") == 0) {
    if (!timerRunning) {
      if (remainingMs == 0) remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
      timerRunning = true;
      lastTimerTick = millis();
    }
    publishStatus();
    return;
  }
  if (strcmp(cmd, "pause") == 0) {
    timerRunning = false;
    publishStatus();
    return;
  }
  if (strcmp(cmd, "reset") == 0) {
    timerRunning = false;
    remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
    lastTimerTick = millis();
    publishStatus();
    return;
  }
  if (strcmp(cmd, "mode") == 0) {
    int32_t value = -1;
    if (!extractInt(json, "value", &value)) return;
    if (value < 0 || value > 2) return;
    setMode((uint8_t)value);
    return;
  }
  if (strcmp(cmd, "set") == 0) {
    int32_t value = -1;
    if (!extractInt(json, "value", &value)) return;
    if (value < 1 || value > 180) return;

    // Optional "mode" (0..2) allows the website to save all three durations
    // without switching modes. Omitted = current mode.
    int32_t target = -1;
    if (extractInt(json, "mode", &target) && (target < 0 || target > 2)) return;
    uint8_t mode = (target >= 0) ? (uint8_t)target : currentMode;

    durationMin[mode] = (uint16_t)value;
    if (mode == currentMode) {
      timerRunning = false;
      remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
      lastTimerTick = millis();
    }
    saveSettings();
    publishStatus();
    return;
  }
  if (strcmp(cmd, "clearstats") == 0) {
    sessions = 0;
    focusMinutes = 0;
    for (uint8_t i = 0; i < 7; ++i) dailyMinutes[i] = 0;
    saveStats();
    publishStatus();
    return;
  }
  if (strcmp(cmd, "status") == 0) {
    // Diagnostic extension: request a fresh notification without changing state.
    publishStatus();
    return;
  }
  // Unknown commands are ignored (validation).
}

static void handleCommandFrame(const uint8_t* data, size_t len) {
  if (!data || len < 4 || len > FRAME_SIZE) return;
  uint8_t gen = data[0];
  uint8_t seq = data[1];
  uint8_t total = data[2];
  uint8_t payloadLen = data[3];
  if (payloadLen > FRAME_PAYLOAD) return;
  if (len != (size_t)(4 + payloadLen)) return;
  if (total == 0 || total > MAX_FRAMES || seq >= total) return;

  if (gen != rxGen || seq == 0) {
    if (seq != 0 && gen != rxGen) return; // stale frame from an older batch
    rxGen = gen;
    rxTotal = total;
    for (uint8_t i = 0; i < MAX_FRAMES; ++i) rxHave[i] = false;
  }
  if (total != rxTotal) return;

  memcpy(rxParts[seq], data + 4, payloadLen);
  rxLens[seq] = payloadLen;
  rxHave[seq] = true;
  rxLastMs = millis();

  bool complete = true;
  for (uint8_t i = 0; i < rxTotal; ++i) {
    if (!rxHave[i]) { complete = false; break; }
  }
  if (!complete) return;

  uint8_t joined[128];
  size_t n = 0;
  for (uint8_t i = 0; i < rxTotal; ++i) {
    if (n + rxLens[i] > sizeof(joined)) return;
    memcpy(joined + n, rxParts[i], rxLens[i]);
    n += rxLens[i];
  }
  rxGen = 0xFF; // consume batch
  processCommand(joined, n);
}

static void handleIncomingCommand(const uint8_t* data, size_t len) {
  if (!data || len == 0) return;
  if (data[0] == (uint8_t)'{') {
    // Browser negotiated a large MTU and sent the whole JSON in one write.
    processCommand(data, len);
  } else {
    handleCommandFrame(data, len);
  }
  rxLastMs = millis();
}

// ---------------------------------------------------------------------------
// BLE setup and callbacks
// ---------------------------------------------------------------------------
class PomoServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& info) override {
    bleConnected = true;
    server->updateConnParams(info.getConnHandle(), 24, 48, 0, 180);
    publishStatus();
  }

  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    bleConnected = false;
    txActive = false;
    NimBLEDevice::startAdvertising();
  }
};

static PomoServerCallbacks serverCallbacks;

class PomoCommandCallbacks : public NimBLECharacteristicCallbacks {
  void handle(const uint8_t* data, size_t len) {
    handleIncomingCommand(data, len);
  }

#if POMO_NIMBLE_V3
  uint8_t onWrite(NimBLECharacteristic*, NimBLEAttValue& value, NimBLEConnInfo&) override {
    // Copy before reading: NimBLEAttValue pointers are only stable on a copy.
    std::string copy(reinterpret_cast<const char*>(value.data()), value.size());
    handle((const uint8_t*)copy.data(), copy.size());
    return NimBLEGattStatus::Success;
  }
#else
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo&) override {
    std::string value = characteristic->getValue();
    handle((const uint8_t*)value.data(), value.size());
  }
#endif
};

static PomoCommandCallbacks commandCallbacks;

static void setupBle() {
  NimBLEDevice::init(BLE_NAME);
  pServer = NimBLEDevice::createServer();
#if POMO_NIMBLE_V3
  pServer->setCallbacks(serverCallbacks);
#else
  pServer->setCallbacks(&serverCallbacks);
#endif
  pService = pServer->createService(SERVICE_UUID);

  pStatusChar = pService->createCharacteristic(
      STATUS_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY,
      256);
  pCommandChar = pService->createCharacteristic(
      COMMAND_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR,
      64);

  pStatusChar->setValue("{}");
  publishStatus(); // fills the READ value before any client connects

#if POMO_NIMBLE_V3
  pCommandChar->setCallbacks(commandCallbacks);
  pServer->start();
#else
  pCommandChar->setCallbacks(&commandCallbacks);
  pService->start();
#endif

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->setName(BLE_NAME);
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->enableScanResponse(true);
  advertising->start();
}

// ---------------------------------------------------------------------------
// Rotary encoder (polled, debounced)
// ---------------------------------------------------------------------------
static uint8_t encoderState = 0;
static uint32_t lastEncoderMs = 0;
static uint32_t buttonDownMs = 0;
static bool buttonDown = false;
static bool buttonHandled = false;

// Quadrature transition table for states 0,1,3,2.
static const int8_t ENCODER_DELTA[16] = {
   0, +1, -1,  0,
  -1,  0,  0, +1,
  +1,  0,  0, -1,
   0, -1, +1,  0
};

static void nextMode() {
  uint8_t mode = currentMode == MODE_FOCUS ? MODE_SHORT
               : currentMode == MODE_SHORT ? MODE_LONG
                                           : MODE_FOCUS;
  setMode(mode);
}

static void pollEncoder() {
  uint32_t now = millis();

  uint8_t next = (digitalRead(PIN_ENC_A) ? 1 : 0) | (digitalRead(PIN_ENC_B) ? 2 : 0);
  if (next != encoderState) {
    int8_t delta = ENCODER_DELTA[(encoderState << 2) | next];
    encoderState = next;
    if (delta != 0 && (now - lastEncoderMs) >= 2UL) {
      lastEncoderMs = now;
      // Rotation adjusts the current mode's duration when the timer is idle.
      if (!timerRunning) {
        int value = (int)durationMin[currentMode] + (int)delta;
        durationMin[currentMode] = clampMinutes((uint32_t)value);
        remainingMs = (uint32_t)durationMin[currentMode] * 60000UL;
        saveSettings();
        publishStatus();
      }
    }
  }

  bool pressed = (digitalRead(PIN_ENC_SW) == LOW);
  if (pressed && !buttonDown) {
    buttonDown = true;
    buttonDownMs = now;
    buttonHandled = false;
  } else if (pressed && buttonDown && !buttonHandled && (now - buttonDownMs) >= 700UL) {
    buttonHandled = true;
    nextMode(); // long press = switch mode
  } else if (!pressed && buttonDown) {
    uint32_t held = now - buttonDownMs;
    if (!buttonHandled && held >= 30UL && held < 700UL) {
      toggleTimer(); // short press = start / pause
    }
    buttonDown = false;
    buttonHandled = false;
  }

  // Discard an in-progress command batch if a client stopped mid-write.
  if (rxGen != 0xFF && (now - rxLastMs) > 2000UL) rxGen = 0xFF;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
static void drawUi() {
  if (!uiReady) return;

  // 5 fps is smooth for a seconds display and keeps SPI time away from BLE.
  static uint32_t lastUiDraw = 0;
  uint32_t nowMs = millis();
  if (nowMs - lastUiDraw < 200UL) return;
  lastUiDraw = nowMs;

  time_t epoch = currentEpoch();
  char clockBuf[16] = "--:--";
  char dateBuf[16] = "-- ---";
  if (epoch > 0) {
    struct tm* t = localtime(&epoch);
    if (t) {
      strftime(clockBuf, sizeof(clockBuf), "%H:%M", t);
      strftime(dateBuf, sizeof(dateBuf), "%d %b", t);
    }
  }

  uint32_t remSeconds = (remainingMs + 999UL) / 1000UL;
  uint32_t totalSeconds = (uint32_t)durationMin[currentMode] * 60UL;
  char timeBuf[16];
  snprintf(timeBuf, sizeof(timeBuf), "%02lu:%02lu",
           (unsigned long)(remSeconds / 60UL), (unsigned long)(remSeconds % 60UL));

  double progress = 1.0;
  if (totalSeconds > 0) {
    progress = 1.0 - ((double)remainingMs / ((double)totalSeconds * 1000.0));
    if (progress < 0) progress = 0;
    if (progress > 1) progress = 1;
  }

  const uint32_t accent = (currentMode == MODE_FOCUS) ? C_ACCENT : C_BREAK;
  const char* modeText = currentMode == MODE_FOCUS ? "FOCUS"
                       : currentMode == MODE_SHORT ? "SHORT BREAK" : "LONG BREAK";
  const char* stateText = timerRunning ? "RUNNING" : (remainingMs == (uint32_t)durationMin[currentMode] * 60000UL ? "READY" : "PAUSED");

  ui.fillScreen(C_BG);
  ui.startWrite();

  // Outer progress ring.
  ui.drawCircle(120, 120, 106, C_TRACK);
  int startAngle = -90;
  int endAngle = startAngle + (int)(360.0 * progress);
  if (endAngle > startAngle) ui.drawArc(120, 120, 106, 106, startAngle, endAngle, accent);
  ui.drawCircle(120, 120, 100, 0x161A20);

  ui.setTextDatum(textdatum_t::middle_center);
  ui.setTextColor(accent);
  ui.setFont(&fonts::DejaVu12);
  ui.drawString(modeText, 120, 35);

  ui.setTextColor(C_TEXT);
  ui.setFont(&fonts::Orbitron_Light_32);
  ui.drawString(timeBuf, 120, 94);

  ui.setFont(&fonts::DejaVu12);
  ui.setTextColor(timerRunning ? accent : C_MUTED);
  ui.drawString(stateText, 120, 145);

  char statBuf[48];
  snprintf(statBuf, sizeof(statBuf), "%lu SESSIONS   %lu MIN",
           (unsigned long)sessions, (unsigned long)focusMinutes);
  ui.setTextColor(C_MUTED);
  ui.drawString(statBuf, 120, 174);

  char clockBuf2[40];
  snprintf(clockBuf2, sizeof(clockBuf2), "%s  %s", clockBuf, dateBuf);
  ui.setTextColor(C_TEXT);
  ui.drawString(clockBuf2, 120, 196);

  char statusBuf[32];
  snprintf(statusBuf, sizeof(statusBuf), "W:%s  B:%s",
           wifiConnected ? "OK" : "--", bleConnected ? "ON" : "--");
  ui.setTextColor(C_MUTED);
  ui.drawString(statusBuf, 120, 213);

  ui.endWrite();
  ui.pushSprite(&lcd, 0, 0);
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  uint32_t settleStart = millis(); // one-time hardware settle, still non-blocking
  while (millis() - settleStart < 50UL) yield();

  pinMode(PIN_ENC_A, INPUT_PULLUP);
  pinMode(PIN_ENC_B, INPUT_PULLUP);
  pinMode(PIN_ENC_SW, INPUT_PULLUP);
  encoderState = (digitalRead(PIN_ENC_A) ? 1 : 0) | (digitalRead(PIN_ENC_B) ? 2 : 0);

  lcd.init();
  lcd.setRotation(0);
  lcd.fillScreen(C_BG);
  ui.setColorDepth(16);
  if (ui.createSprite(240, 240) != nullptr) {
    uiReady = true;
    ui.fillScreen(C_BG);
  }

  setenv("TZ", TIMEZONE, 1);
  tzset();
  loadPreferences();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiTry = millis();

  setupBle();
  lastTimerTick = millis();
  drawUi();
}

void loop() {
  pollWifiAndTime();
  pollTimer();
  pollEncoder();
  pumpStatusTx();
  drawUi();
  yield();
}
