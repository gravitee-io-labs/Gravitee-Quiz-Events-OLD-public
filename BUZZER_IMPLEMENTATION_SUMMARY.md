# Physical Buzzer Module - Implementation Summary

## Overview

A Bluetooth Low Energy (BLE) integration for physical quiz buzzers: nRF52840 firmware (Zephyr) and a Web Bluetooth module in the player app. A buzzer press answers the current question exactly like the `G` / `R` keys or a tap.

- Production: `https://quiz.events.gravitee.io/{slug}` (scoreboard on `/{slug}/scoreboard`)
- Local: `http://localhost:8080/{slug}`
- Documentation map: [BUZZER_INTEGRATION.md](BUZZER_INTEGRATION.md) (setup, usage, booth checklist, troubleshooting), [BUZZER_ARCHITECTURE.md](BUZZER_ARCHITECTURE.md) (diagrams, data flow, state machines), [NEW_FILES_LIST.md](NEW_FILES_LIST.md) (file inventory), [buzzer-firmware/README.md](buzzer-firmware/README.md) and [buzzer-firmware/QUICKSTART.md](buzzer-firmware/QUICKSTART.md) (firmware).

## What Exists

### 1. Buzzer firmware (`buzzer-firmware/`)

Firmware for nRF52840 boards (Nice!Nano / Pro Micro, board `promicro_nrf52840`):

- `CMakeLists.txt`, `prj.conf`, `promicro_nrf52840.overlay`: build, Zephyr and device tree configuration
- `src/config.h`: buzzer id, device names, pins, UUIDs, BLE and battery settings
- `src/main.c`: initialisation, advertising, connection callbacks, status LED patterns
- `src/buzzer_service.c/h`: custom BLE GATT service (button state, LED control, buzzer id)
- `src/button.c/h`: button handling with a 50 ms debounce
- `src/led.c/h`: on/off control of the buzzer LED (P0.06)
- `src/battery.c/h`: battery level from the internal VDDH/5 ADC channel, published through the standard Battery Service

### 2. Player app (`web/`)

The buzzer module lives in the player app and is loaded by the event page:

- `web/js/buzzer/ble.js`: Web Bluetooth manager
  - device selection, GATT discovery, buzzer id check (the id decides the colour)
  - button press notifications (client-side debounce 250 ms), battery level and low-battery flag
  - GATT operations queued per device, timeouts
  - automatic reconnect with exponential backoff and silent restore of known devices after a reload (Chrome/Edge 122+)
  - LED helpers: ready state (both on / both off), test pattern, optional per-answer feedback
- `web/js/buzzer/ui.js`: header button with status dot and the accessible dialog (one row per colour: connect / disconnect, battery, press test, messages; footer: Test LEDs, Disconnect all, Done)
- `web/js/buzzer/index.js`: `createBuzzerController`, the entry point (toasts, announcements, auto-restore)
- `web/js/buzzer/strings.js`: EN and FR texts
- `web/css/buzzer.css`: styling (loaded by `web/event.html`)
- `web/js/event/buzzer.js`: guarded dynamic import, so the game works without the module
- `web/js/event/main.js`: header slot, `ctx.onBuzzerPress`, kiosk mode (`?kiosk=1`)
- `web/js/event/views/game.js`: one answer path for taps, keys and buzzers; LED ready state
- `web/js/event/views/rules.js`: "Playing with buzzers?" card (Connect / Manage buzzers)
- `web/nginx.conf`: `Permissions-Policy: bluetooth=(self)`

### 3. Documentation

See the documentation map above. The booth checklist and the troubleshooting section are in `BUZZER_INTEGRATION.md`.

## Key Features Implemented

### Behaviour in the game
- Both connected buzzers light up while a question is open and go dark when it is answered, times out or the game ends
- A press is forwarded to the game only during a running question; presses while the buzzer dialog is open only light the test indicator
- First answer wins (buzzer, key or tap); no correct / wrong feedback during play (the server reveals it with the final results)
- `G` / `R` keyboard fallback at all times

### User experience
- Header button with a status dot (none / one / both / reconnecting / low battery)
- Dialog with one row per colour, battery level, low-battery warning (20 % or less), press test pad and "Test LEDs"
- Colour decided by the buzzer id: picking the red buzzer from the green row connects it as red
- Toasts and screen-reader announcements for connect, loss, reconnect and low battery
- EN / FR texts, accessible dialog (focus trap, live regions)
- Kiosk mode for the booth laptop: auto-reset between visitors without dropping the buzzers

### Reliability
- Firmware debounce (50 ms) and client debounce (250 ms per buzzer)
- Automatic reconnect with backoff (0.5, 1, 2, 4, 8 s, then every 15 s), "Stop reconnecting" button
- Serialised GATT operations with timeouts; manual disconnect never triggers a reconnect
- One BLE connection per buzzer (`CONFIG_BT_MAX_CONN=1`); the buzzer re-advertises after a disconnect
- Graceful degradation: no Web Bluetooth, no HTTPS, no buzzers: the game is unchanged

### Firmware
- Advertised name `Gravitee Quiz Buzzer - Green` / `Gravitee Quiz Buzzer - Red` (from `BUZZER_ID`)
- Connection confirmation: 5 blinks of the buzzer LED; onboard LED heartbeat (50 ms every 2 s advertising, every 5 s connected)
- A press while not connected makes the buzzer LED flash 3 times
- Battery: 18650 Li-ion, sampled at boot then every 5 minutes
- LED has no auto-off: it stays as last written by the app

## Technical Specifications

### BLE Protocol
- **Service UUID**: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- **Custom characteristics**: Button State (`…0002`, READ/NOTIFY, `0x01` on press only), LED Control (`…0003`, READ/WRITE, 3 bytes `[R,G,B]`, on if any byte > 128), Buzzer ID (`…0004`, READ, 1 = green, 2 = red)
- **Standard**: Battery Service `0x180F` / Battery Level `0x2A19` (READ/NOTIFY, percent)
- **Connection**: preferred interval 10-15 ms; range about 10 meters; no bonding or encryption

### Hardware
- **Microcontroller**: nRF52840 (ARM Cortex-M4), Nice!Nano / Pro Micro board
- **OS**: Zephyr RTOS (nRF Connect SDK)
- **Power**: 18650 Li-ion cell or USB
- **Input**: momentary push button on P0.11
- **Output**: white LED on P0.06 (on/off), onboard status LED on P0.15

### Browser Support
- Chrome 56+, Edge 79+, Opera 43+ (computer or Android)
- Safari, Firefox and all iOS browsers: no Web Bluetooth (the dialog says so; keys and taps still work)
- HTTPS or `localhost` is required (secure context)

## File Structure

The complete, current list of buzzer-related files is in [NEW_FILES_LIST.md](NEW_FILES_LIST.md).

## Getting Started

### For hardware development
1. Read `buzzer-firmware/QUICKSTART.md`
2. Build and flash the firmware to two boards (`BUZZER_ID` 1 and 2)
3. Check the startup LED sequence and that both advertise with the right name

### For the booth
1. Follow the "Booth setup checklist" in `BUZZER_INTEGRATION.md`
2. Open `https://quiz.events.gravitee.io/{slug}?kiosk=1` in Chrome, connect green then red from the header Bluetooth button, test the presses

### For customization
1. `buzzer-firmware/src/config.h` and `promicro_nrf52840.overlay` for firmware settings and pins
2. `web/js/buzzer/ble.js` for LED values, debounce, reconnect and battery threshold
3. `web/js/buzzer/strings.js` for texts

## Testing Checklist

### Hardware tests
- [ ] On power-up the buzzer LED lights for half a second, then the onboard LED blinks 5 times
- [ ] Advertises as `Gravitee Quiz Buzzer - Green` / `- Red`
- [ ] While waiting, both LEDs flash briefly every 2 s; a button press flashes the buzzer LED 3 times
- [ ] Battery level readable (Battery Service)

### Connection tests
- [ ] Both buzzers show up in the chooser, and a buzzer connected elsewhere does not
- [ ] Connecting from the dialog works for each colour; the buzzer blinks 5 times
- [ ] Colour follows the buzzer id, not the clicked row
- [ ] Battery level displays; low-battery warning at 20 % or less
- [ ] "Press received!" shows when each button is pressed; "Test LEDs" works

### Gameplay tests
- [ ] Button press submits the answer for its colour
- [ ] Both LEDs on when a question starts, off after the answer / timeout and at the end
- [ ] No double submissions (buzzer plus key at the same time)
- [ ] `G` / `R` keys work with and without buzzers
- [ ] Works throughout a full game

### Edge cases
- [ ] Switch a buzzer off and on mid-game: reconnect with backoff, game continues
- [ ] Page reload: buzzers restored automatically (Chrome/Edge 122+) or reconnected manually
- [ ] Buzzer connected to another computer: not listed in the chooser
- [ ] Safari / Firefox / `http://<LAN-IP>`: the dialog explains why Bluetooth is unavailable
- [ ] Kiosk mode: reset after a visitor, buzzers stay connected

## Notes

- Web Bluetooth requires HTTPS (or `localhost`)
- A page reload drops the BLE link; the app tries to restore known buzzers, otherwise reconnect from the dialog
- A buzzer accepts one connection and does not advertise while connected
- Battery life has not been measured on the 18650 build
- The game works normally without buzzers

## Future Enhancements

Potential improvements:
- [ ] Per-answer LED patterns (the game would need to know the result during play)
- [ ] Haptic feedback support
- [ ] BLE pairing/bonding for security
- [ ] Firmware OTA updates
- [ ] Remove or wire in the constants of `config.h` that the code does not use (`LED_AUTO_OFF_TIMEOUT_MS`, `BUTTON_NOTIFICATION_TIMEOUT_MS`, `STATUS_LED_PIN`, `BATTERY_ADC_CHANNEL`, `BATTERY_DIVIDER_RATIO`, `BATTERY_*_MV`)
- [ ] Advanced power profiling
- [ ] Custom enclosure designs
