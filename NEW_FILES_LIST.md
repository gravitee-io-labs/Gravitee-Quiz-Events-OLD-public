# Buzzer-related Files

Inventory of the files that make up the physical buzzer integration in the current repository. For how they work together see [BUZZER_ARCHITECTURE.md](BUZZER_ARCHITECTURE.md); for setup and troubleshooting see [BUZZER_INTEGRATION.md](BUZZER_INTEGRATION.md).

## Documentation

| File | Content |
|---|---|
| `BUZZER_INTEGRATION.md` | Setup, usage, kiosk mode, booth setup checklist, troubleshooting, customization, BLE specification |
| `BUZZER_ARCHITECTURE.md` | System diagram, press-to-answer data flow, GATT structure, state machines, power, error handling |
| `BUZZER_IMPLEMENTATION_SUMMARY.md` | What exists, key features, technical specs, test checklist |
| `NEW_FILES_LIST.md` | This inventory |
| `buzzer-firmware/README.md` | Firmware reference: pins, BLE service, build, behaviour |
| `buzzer-firmware/QUICKSTART.md` | Step by step: wire, build, flash and test two buzzers |

## Firmware (`buzzer-firmware/`)

| File | Role |
|---|---|
| `CMakeLists.txt` | CMake build |
| `prj.conf` | Zephyr configuration (BLE peripheral, 1 connection, Battery Service, ADC, UF2 output) |
| `promicro_nrf52840.overlay` | Device tree for Nice!Nano / Pro Micro: button (P0.11), status LED (P0.15), buzzer LED (P0.06), ADC, DC/DC |
| `src/config.h` | `BUZZER_ID`, device names, pins, UUIDs, advertising and connection settings, battery constants |
| `src/main.c` | Start-up sequence, advertising, connection callbacks, status LED heartbeat, button callback |
| `src/buzzer_service.c` / `.h` | Custom GATT service: button state (notify), LED control, buzzer id |
| `src/button.c` / `.h` | GPIO interrupt and 50 ms debounce |
| `src/led.c` / `.h` | Buzzer LED on / off (P0.06) |
| `src/battery.c` / `.h` | Battery voltage from the VDDH/5 channel, percentage, Battery Service update |

`buzzer-firmware/build/` is local build output (`build/buzzer-firmware/zephyr/zephyr.uf2` is the file to flash), not source.

## Player app (`web/`)

| File | Role |
|---|---|
| `web/js/buzzer/index.js` | Module entry point: `createBuzzerController` |
| `web/js/buzzer/ble.js` | Web Bluetooth manager: connect, restore, notifications, battery, LED writes, reconnect |
| `web/js/buzzer/ui.js` | Header button with status dot and the buzzer dialog |
| `web/js/buzzer/strings.js` | EN and FR texts of the module |
| `web/css/buzzer.css` | Styles of the button, dot and dialog |
| `web/js/event/buzzer.js` | Guarded dynamic import of the module |
| `web/js/event/main.js` | Puts the button in the app bar, `ctx.onBuzzerPress`, kiosk mode (`?kiosk=1`, `noscoreboard=1`) |
| `web/js/event/kiosk.js` | Kiosk idle reset (120 s) |
| `web/js/event/views/game.js` | Shared answer path for taps, `G` / `R` keys and buzzers; LED ready state (`setReady`) |
| `web/js/event/views/rules.js` | "Playing with buzzers?" card with Connect / Manage buzzers |
| `web/js/lib/strings.js` | `rules.buzzer_*` texts of that card |
| `web/css/event.css` | `.ev-buzzer` card; hides the buzzer UI on touch devices outside kiosk mode |
| `web/event.html` | Loads `buzzer.css` |
| `web/nginx.conf` | `Permissions-Policy: bluetooth=(self)` |

## Where the former `game-client` buzzer code went

The legacy `game-client/` app has been removed; its buzzer code was ported to `web/`:

| Former file | Now |
|---|---|
| `game-client/js/buzzer.js` (BLE manager) | `web/js/buzzer/ble.js` |
| `game-client/js/buzzer-ui.js` (UI and game glue) | `web/js/buzzer/ui.js`, `web/js/buzzer/index.js`, `web/js/event/buzzer.js` |
| buzzer modal and footer button in `game-client/index.html` | built by `ui.js` (header button and `<dialog>`) |
| buzzer styles in `game-client/css/styles.css` | `web/css/buzzer.css` |
| buzzer glue in `game-client/js/app.js` | `web/js/event/main.js`, `web/js/event/views/game.js` |
| buzzer texts in `game-client/js/i18n.js` | `web/js/buzzer/strings.js`, `web/js/lib/strings.js` |

## Other mentions

`README.md` (features and repository layout), `docs/ARCHITECTURE.md` (buzzer requirement) and `docs/DEPLOYMENT.md` (secure context, supported browsers, troubleshooting row) refer to the buzzers.
