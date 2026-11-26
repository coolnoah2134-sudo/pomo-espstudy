# POMO · espstudy

A complete ESP32-C3 Pomodoro timer with a round GC9A01 display, encoder controls, Wi-Fi/NTP clock, BLE status/commands, and a premium Web Bluetooth dashboard that deploys to Vercel.

**There is no buzzer in this project.** No buzzer pin, `tone()`, beep function, sound asset, or audible notification is used. Timer completion is shown silently on the display and in the website toast.

The ESP32 is the single source of truth. The website displays device status and sends commands; its countdown is only a smooth visual interpolation that is re-synced by every BLE notification.

---

## Files

```text
pomo/
├── firmware/
│   └── pomo_esp32.ino      # Arduino sketch for ESP32-C3
├── website/
│   ├── index.html          # Dashboard markup
│   ├── style.css           # Dark charcoal / coral responsive styling
│   ├── script.js           # Web Bluetooth client and UI logic
│   └── package.json        # Optional local dev server
├── vercel.json             # Static deployment from website/
└── README.md               # This guide
```

---

## Hardware and wiring

| Component | ESP32-C3 Super Mini pin |
|---|---|
| GC9A01 SCLK | GPIO 4 |
| GC9A01 MOSI | GPIO 6 |
| GC9A01 RST | GPIO 3 |
| GC9A01 DC | GPIO 2 |
| GC9A01 CS | GPIO 7 |
| Encoder CLK / A | GPIO 0 |
| Encoder DT / B | GPIO 1 |
| Encoder SW / button | GPIO 5 |
| Power | USB-C |

Connect display VCC to 3V3 and GND to GND. Encoder common pin goes to GND; the sketch uses `INPUT_PULLUP` on GPIO 0, 1 and 5. No MISO is needed.

---

## Arduino libraries

Install these in Arduino IDE (Tools → Manage Libraries…):

| Library | Recommended version | Notes |
|---|---:|---|
| Arduino ESP32 boards | 2.0.17+ (3.x also supported) | Board: **ESP32C3 Dev Module** |
| LovyanGFX | 1.2.0+ | Uses `LGFX_Device`, `Bus_SPI`, `Panel_GC9A01` |
| NimBLE-Arduino | **2.3.6** | Primary target; v3.x callback signatures are also guarded in the sketch |
| Preferences | built into ESP32 core | No install needed |
| WiFi | built into ESP32 core | No install needed |
| time | built into ESP32 core | No install needed |

The sketch checks `NIMBLE_CPP_VERSION_MAJOR` and supports both NimBLE 2.x and 3.x callback APIs. If you hit an unexpected library-version issue, pin NimBLE-Arduino to 2.3.6.

---

## Upload the firmware

1. Install Arduino IDE 2.x and the ESP32 boards package.
2. Install the libraries above.
3. Open `firmware/pomo_esp32.ino`.
4. Select:
   - Board: **ESP32C3 Dev Module**
   - Upload Speed: **921600** (reduce to 115200 if your cable is unreliable)
   - USB CDC On Boot: **Enabled** (gives Serial over the Super Mini's USB-C)
   - Flash Size: default for your module
5. Connect the board by USB-C and press Upload.
6. If autoreset fails, hold the board's **BOOT** button while uploading, then release it when the upload finishes.
7. Open Serial Monitor at 115200. The display should light immediately; BLE advertises as **espstudy**.

There are no blocking `delay()` calls in `loop()`. Wi-Fi, NTP, timer, encoder, display and BLE are all polled cooperatively.

---

## Wi-Fi and time

Initial values in the sketch are exactly:

```cpp
WIFI_SSID     = "Wokwi-GUEST";
WIFI_PASSWORD = "";
NTP_SERVER    = "pool.ntp.org";
TIMEZONE      = "NZST-12NZDT,M9.5.0,M4.1.0/3";
```

Behavior:

- Wi-Fi starts in STA mode and reconnects every 5 seconds if association fails or drops.
- NTP is requested only while Wi-Fi is connected.
- The local timezone string gives NZST/NZDT with automatic daylight-saving transitions.
- Once synced, the clock is anchored to `millis()` and keeps running through Wi-Fi loss or reboot of the router.
- A resync re-anchors every 30 minutes when Wi-Fi is available.
- Wi-Fi is used **only** for time; there is no HTTP server, no cloud API and no Wi-Fi link to the website.
- BLE stays independent and works with Wi-Fi disconnected.
- The display shows `W:OK`/`W:--` and `B:ON`/`B:--` for Wi-Fi and BLE status.
- Weekly statistics reset on Monday using local NZ time once the clock is synced.

---

## Controls

| Action | Result |
|---|---|
| Short press encoder button | Start / pause the timer |
| Long press encoder button (≈0.7 s) | Switch Focus → Short Break → Long Break → Focus |
| Rotate encoder while timer is stopped | Change the current mode's duration (1–180 min) and save it |
| Website mode buttons | Same mode switch, sent over BLE |
| Website Reset | Reloads the current mode's duration |
| Website Next mode | Same as long press |

Rotation and button presses are polled with debouncing; a 2 ms minimum gap between encoder steps and a 30–700 ms short-press window prevent accidental repeated inputs. The button's long-press action fires once per physical press.

Timer completion:

- Focus completion increments completed sessions, adds the configured focus minutes to total and the correct Mon–Sun day, then selects a Short Break (Long Break every 4th focus session).
- Break completion returns to Focus.
- Nothing is audible. The round display and website toast communicate completion silently.

---

## BLE protocol

Advertised name: **espstudy**

| Role | UUID | Properties |
|---|---|---|
| Service | `7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000` | — |
| Status | `7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000` | READ, NOTIFY |
| Command | `7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000` | WRITE, WRITE WITHOUT RESPONSE |

### Status JSON

A READ of the Status characteristic always returns the complete object:

```json
{"mode":0,"rem":1500,"set":1500,"run":false,"sessions":0,"minutes":0,"daily":[0,0,0,0,0,0,0]}
```

- `mode`: `0` Focus, `1` Short Break, `2` Long Break
- `rem`, `set`: seconds
- `run`: timer running state
- `sessions`: completed focus sessions
- `minutes`: total focus minutes
- `daily`: focus minutes Monday → Sunday

The firmware sends a fresh framed Status notification after every accepted command and after encoder-driven changes. A status notification may also arrive on connect. The website re-anchors its display on every notification.

### Framing (both directions)

Default ATT MTU is 23 bytes, so a 17-byte payload is safe on every browser. JSON is split into frames:

```text
byte 0        generation (1–255, never 0; increments per message)
byte 1        sequence index (0-based)
byte 2        total frame count
byte 3        payload length in bytes (1–13)
bytes 4..n    UTF-8 JSON fragment
```

Maximum payload is 13 bytes, maximum 16 frames. The website and firmware both reassemble by generation + sequence. The website also accepts a raw JSON object in one write if a larger MTU was negotiated, and the firmware accepts raw JSON on the Command characteristic. Incomplete command batches time out after 2 seconds on the ESP32.

### Commands

All commands are UTF-8 JSON objects. Unknown commands and invalid values are ignored.

```json
{"cmd":"toggle"}
{"cmd":"start"}
{"cmd":"pause"}
{"cmd":"reset"}
{"cmd":"mode","value":0}
{"cmd":"set","value":25}
{"cmd":"clearstats"}
```

- `mode` value must be `0`, `1` or `2`.
- `set` value must be a whole number of minutes from `1` to `180` and applies to the current mode.
- Extension: `set` accepts an optional `"mode"` field (`0`–`2`) so the website can save all three durations without switching modes, e.g. `{"cmd":"set","value":5,"mode":1}`. Saving the currently active mode reloads that mode's countdown; the other two modes are saved without affecting the running mode.
- Extension: `{"cmd":"status"}` requests a fresh notification without changing state (used by the refresh button).

---

## Deploy the website to Vercel

The project is static: no backend, no database, no paid API, no server-side BLE. Vercel supplies HTTPS, which Web Bluetooth requires.

1. Create a GitHub/GitLab/Bitbucket repository from the `pomo/` folder (or push that folder as the repo root).
2. In Vercel, choose **Add New → Project** and import the repository.
3. Build settings are already in `vercel.json`:
   - Framework Preset: **Other**
   - Build Command: empty
   - Output Directory: `website`
4. Click **Deploy**. The published URL is HTTPS and can be opened directly.
5. Optional: add a custom domain in Project → Settings → Domains; Vercel issues the certificate automatically.

Local preview (also a secure context):

```bash
cd pomo/website
npm run dev
# open http://localhost:3000
```

`localhost` is treated as secure by browsers, so Bluetooth works locally over plain HTTP.

### Browser requirements

- Web Bluetooth is supported in Chrome/Edge on desktop (Windows/macOS/Linux/ChromeOS) and Chrome on Android.
- Safari and Firefox do not implement Web Bluetooth; the page shows a clear error.
- The page must be served over **HTTPS** or `localhost`. `vercel.app` and Vercel custom domains are HTTPS.
- The user must grant Bluetooth permission via the browser's device picker. This is why the Connect button calls `navigator.bluetooth.requestDevice()` directly from a click handler.
- The picker requests devices named **espstudy** (and **POMO-C3** for older builds) with the custom service included via `optionalServices`.

---

## Connect and use

1. Power the ESP32 by USB-C. Confirm the round display shows the timer and `B:--`.
2. Open the deployed site (or `http://localhost:3000`) in Chrome/Edge.
3. Click **Connect**.
4. Pick **espstudy** in the browser dialog.
5. The pill turns green and the dashboard fills with the device's current state.
6. Use Start/Pause, Reset, mode buttons or Next mode. Duration changes made with the encoder appear in the website on the next notification.
7. Click **Disconnect** to release the GATT connection. The timer keeps running on the ESP32.

If the browser says "Device not found", make sure the sketch uploaded successfully, the board is powered, and no other device/app is currently connected to it.

---

## Cross-review: firmware ↔ website parity

| Item | Firmware | Website | Match |
|---|---|---|---|
| Service UUID | `7b6e0001-…d1000` | Same constant | ✅ |
| Status UUID | `7b6e0002-…d1000` | Same constant | ✅ |
| Command UUID | `7b6e0003-…d1000` | Same constant | ✅ |
| Advertised name | `espstudy` | Requests `espstudy` + legacy `POMO-C3` | ✅ |
| Status properties | READ + NOTIFY | Uses `readValue()` and notification listener | ✅ |
| Command properties | WRITE + WRITE_NR | `writeValueWithResponse()` with fallbacks | ✅ |
| Status keys | `mode,rem,set,run,sessions,minutes,daily[7]` | Validates exactly this shape | ✅ |
| Frame header | 4 bytes, 13-byte payload, max 16 | Same constants and parser | ✅ |
| Commands | toggle/start/pause/reset/mode/set/clearstats (+ optional status) | Sends all of them | ✅ |
| `set` optional mode | Accepted and validated | Apply sends `mode` field for all three durations | ✅ |
| Timer authority | `millis()` state machine + Preferences | Display-only interpolation, re-anchored on notify | ✅ |
| Statistics | Persistent, NZ Monday reset | Read-only display + clear command | ✅ |
| Sound | None | None | ✅ |

---

## Troubleshooting

- **Display stays dark:** recheck SCLK 4, MOSI 6, RST 3, DC 2, CS 7 and 3V3/GND. Confirm LovyanGFX is installed.
- **Device name not shown:** BLE advertising starts in `setup()`; power-cycle after upload. Clear the phone/desktop Bluetooth cache if an old `POMO-C3` entry persists.
- **Wi-Fi never shows OK:** the initial SSID is `Wokwi-GUEST` with an empty password as specified. Edit the constants at the top of the sketch for your real network; BLE still works without it.
- **Clock shows `--:--`:** NTP needs internet access. The timer does not depend on time sync.
- **Connect fails:** use HTTPS/localhost, Chrome/Edge, and ensure the device is not already connected elsewhere.
- **Notifications never update:** click the ↻ refresh button, which sends `{"cmd":"status"}`; if nothing returns, reconnect.
