# POMO for iPhone (native SwiftUI)

This is a **real native iOS app** for the espstudy ESP32-C3 Pomodoro timer. It is not a web wrapper and does not depend on Web Bluetooth. It uses **CoreBluetooth**, which iPhone supports.

## What is included

```text
PomoApp/
├── PomoApp.xcodeproj/          Open this in Xcode
├── Info.plist                  Bluetooth usage permission
├── Assets.xcassets/            App icon + accent colour
└── Sources/
    ├── PomoApp.swift           @main entry point
    ├── ContentView.swift       SwiftUI dashboard
    ├── PomoBLE.swift           CoreBluetooth client + framing
    ├── PomoModels.swift        Status JSON + commands
    └── Theme.swift             Colours
```

It mirrors the website:

- Dark charcoal UI, coral accent, round progress ring
- Focus / Short Break / Long Break modes
- Start, pause, reset, next mode, refresh
- Task label stored locally on the iPhone only
- Sessions, focus minutes, weekly Mon–Sun chart
- Three editable durations with **Apply to ESP32**
- Clear stats
- Silent completion toast — no sound, no buzzer

## Open and run in Xcode

1. Open `PomoApp.xcodeproj` in Xcode.
2. Select the **PomoApp** target.
3. In **Signing & Capabilities**:
   - Set your **Team**.
   - Change **Bundle Identifier** if you want (default: `com.noah.pomo`).
   - Leave automatic signing enabled.
4. Connect your iPhone by USB (or use a wireless device).
5. Select your iPhone as the run destination.
6. Press **Run**.

> CoreBluetooth does not work in the iOS Simulator. Use a real iPhone or iPad.

The app asks for Bluetooth permission the first time you tap **Connect**. Approve it.

## Connect to the timer

1. Power on the ESP32-C3. Confirm the round display shows `espstudy` advertising / the timer.
2. Open POMO on the iPhone.
3. Tap **Connect**.
4. The pill turns green when the service, status and command characteristics are found.

The app scans only for devices advertising the POMO service, then reads the initial status and enables notifications.

## BLE protocol parity

| Item | UUID |
|---|---|
| Service | `7b6e0001-8d2a-4c6f-9a31-5f2c8e4d1000` |
| Status (read + notify) | `7b6e0002-8d2a-4c6f-9a31-5f2c8e4d1000` |
| Command (write with response) | `7b6e0003-8d2a-4c6f-9a31-5f2c8e4d1000` |

Status JSON is identical to the website:

```json
{"mode":0,"rem":1500,"set":1500,"run":false,"sessions":0,"minutes":0,"daily":[0,0,0,0,0,0,0]}
```

Commands are identical too:

```json
{"cmd":"toggle"}
{"cmd":"start"}
{"cmd":"pause"}
{"cmd":"reset"}
{"cmd":"mode","value":0}
{"cmd":"set","value":25,"mode":0}
{"cmd":"clearstats"}
{"cmd":"status"}
```

Long values are split into frames:

```text
[generation, sequence, total, payloadLength] + up to 13 payload bytes
```

The firmware and website use the same 4-byte header and 13-byte payload. This app also accepts a whole JSON value in one notification if a larger MTU is negotiated.

The ESP32 remains the source of truth. The iPhone interpolates the countdown locally for smoothness and re-anchors on every read/notification.

## Troubleshooting

- **Bluetooth is off** — enable Bluetooth in iPhone Settings.
- **No espstudy device found** — make sure the ESP32 is powered and not already connected to another phone.
- **Bluetooth permission denied** — go to Settings → POMO → Bluetooth and enable it.
- **Service not found** — the ESP32 may be running older firmware; reflash `pomo/firmware/pomo_esp32.ino`.
- **Buttons do nothing** — they are disabled until the status pill says **Connected**.
- **Countdown jumps** — normal after a notification; the device value wins.

## Notes

- No analytics, backend, account or network access is required.
- The task label uses `UserDefaults` and never goes to the ESP32.
- `bluetooth-central` background mode is enabled so BLE events can wake the app.
- Nothing in this app produces sound.
