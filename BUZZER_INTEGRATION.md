# Physical Buzzer Integration for the Gravitee Quiz Game

This module adds support for two physical Bluetooth buzzers (Green and Red) to the player app. A press on a buzzer answers the current question exactly like the `G` / `R` keys or a tap on the on-screen buttons.

Where to play:

| Environment | URL |
|---|---|
| Production | `https://quiz.events.gravitee.io/{slug}` |
| Local (docker compose) | `http://localhost:8080/{slug}` |
| Scoreboard (TV) | `https://quiz.events.gravitee.io/{slug}/scoreboard` |

## Features

- **Wireless Bluetooth connectivity**: two buzzers connect to the browser through the Web Bluetooth API.
- **Header button with status dot**: opens the buzzer dialog (one row per colour: green and red). The dot is hollow when no buzzer is connected, half full with one, full with both, blinks amber while reconnecting and turns into an amber diamond when a battery is low.
- **Same answer path as keys and taps**: a buzzer press, the `G` / `R` keys and a tap all call the same function in the game. The first answer wins, a second one for the same question is ignored.
- **LED "ready" light**: both connected buzzers light up while a question is open (when the countdown starts) and go dark when the question is answered or times out, and when the game ends.
- **Battery monitoring**: battery level per buzzer, with a low-battery warning at 20 % or less.
- **Automatic reconnect**: an unexpected disconnect is retried with an exponential backoff; after a page reload the app tries to restore the buzzers this browser already knows (Chrome/Edge 122+).
- **Keyboard fallback**: `G` (green) and `R` (red) always work, with or without buzzers.
- **Kiosk mode** (`?kiosk=1`) for the booth laptop.
- **Graceful degradation**: without Web Bluetooth (or without buzzers) the game works unchanged; the dialog explains why Bluetooth is unavailable.

## Architecture

The integration has two parts. See [BUZZER_ARCHITECTURE.md](BUZZER_ARCHITECTURE.md) for the diagrams and [NEW_FILES_LIST.md](NEW_FILES_LIST.md) for the full file inventory.

### 1. Buzzer firmware (`buzzer-firmware/`)

Zephyr/nRF Connect firmware for an nRF52840 board (Nice!Nano / Pro Micro, board `promicro_nrf52840`).

**Key files:**
- `src/main.c`: initialisation, advertising, connection callbacks, status LED patterns
- `src/buzzer_service.c`: custom BLE GATT service (button state, LED control, buzzer id)
- `src/button.c`: button handling with a 50 ms debounce
- `src/led.c`: on/off control of the buzzer LED
- `src/battery.c`: battery level (VDDH/5 ADC channel) published through the standard Battery Service
- `src/config.h`: buzzer id, device names, pins, UUIDs, BLE and battery settings
- `promicro_nrf52840.overlay`: device tree (button, LEDs, ADC, DC/DC)

### 2. Player app (`web/`)

The buzzer module is a self-contained part of the player app and is loaded by the event page (`/{slug}`).

**Key files:**
- `web/js/buzzer/ble.js`: Web Bluetooth manager (connect, notifications, battery, LED writes, reconnect)
- `web/js/buzzer/ui.js`: header button and the accessible buzzer dialog
- `web/js/buzzer/index.js`: `createBuzzerController`, the module entry point
- `web/js/buzzer/strings.js`: EN and FR texts
- `web/css/buzzer.css`: styles (loaded by `web/event.html`)
- `web/js/event/buzzer.js`: guarded dynamic import of the module (the game works the same if it cannot load)
- `web/js/event/main.js`: puts the button in the app bar and wires `ctx.onBuzzerPress`; kiosk mode
- `web/js/event/views/game.js`: shared answer path (keys, taps, buzzers) and the LED ready state
- `web/js/event/views/rules.js`: "Playing with buzzers?" card with a Connect / Manage button

## Requirements

| Requirement | Detail |
|---|---|
| Browser | Chrome 56+, Edge 79+ or Opera 43+, on a computer or an Android phone. **Safari, Firefox and every iOS browser have no Web Bluetooth.** |
| Secure context | The page must be served over **HTTPS or from `localhost`**. `http://<LAN-IP>:8080` is not a secure context: the dialog then shows "A secure connection is required". |
| Bluetooth | A working Bluetooth adapter, switched on. |
| One computer per buzzer | The firmware accepts **one** connection at a time (`CONFIG_BT_MAX_CONN=1`). |
| Silent restore after reload | Chrome/Edge 122+ (`navigator.bluetooth.getDevices()`). Older versions need a manual reconnect. |

The production web server sends `Permissions-Policy: bluetooth=(self)` (`web/nginx.conf`); the admin console does not allow Bluetooth.

## Hardware Requirements

### Per buzzer (2 required, one Green and one Red)
- nRF52840 board supported by the firmware overlay: Nice!Nano or Pro Micro nRF52840 (`promicro_nrf52840`)
- Momentary push button
- 1 white LED that lights the button (the green / red identity comes from the button or housing colour and from `BUZZER_ID`, not from the LED)
- 1x 220 Ω resistor for the LED
- 18650 Li-ion cell (3.0 V to 4.2 V) on the board's battery input, or USB power
- Enclosure (optional)

### Wiring

```
Nice!Nano / Pro Micro nRF52840 pin connections:
├── P0.11 → Button (active low, internal pull-up) → GND
├── P0.06 → LED anode (via 220Ω resistor); LED cathode → GND     (board pin "1")
├── P0.15 → onboard LED (connection heartbeat, active low), nothing to wire
└── Battery input ← 18650 Li-ion (read through the chip's internal VDDH/5 channel,
                    no external voltage divider needed)
```

## Setup Instructions

### Step 1: Build and flash the firmware

1. **Install the nRF Connect SDK** (the last local build used NCS v3.1.1):
   ```bash
   # Follow Nordic's official installation guide
   # https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/installation.html
   ```

2. **Set the buzzer id** in `buzzer-firmware/src/config.h`:
   ```c
   #define BUZZER_ID 1  // 1 for Green, 2 for Red
   ```
   The advertised name follows the id: `Gravitee Quiz Buzzer - Green` (1) or `Gravitee Quiz Buzzer - Red` (2). Any other value does not compile.

3. **Build the firmware**:
   ```bash
   cd buzzer-firmware
   west build -b promicro_nrf52840/nrf52840/uf2 --pristine
   ```

4. **Flash**: double-tap RESET to start the board's UF2 bootloader, then copy `build/buzzer-firmware/zephyr/zephyr.uf2` to the USB drive that appears. Step by step (with VS Code) in [buzzer-firmware/QUICKSTART.md](buzzer-firmware/QUICKSTART.md).

5. **Repeat for the second buzzer** with `BUZZER_ID 2` (use `--pristine` again after changing the id).

### Step 2: Player app

Nothing to configure. The buzzer module ships with the player app (`web/`) and is loaded by the event page; open the game and the Bluetooth button appears in the header (on the landing page, the rules page and during the game). To try it locally:

```bash
docker compose up -d --build
open http://localhost:8080/api-masters      # any event slug; localhost counts as a secure context
```

### Step 3: Browser

Use Chrome, Edge or Opera and enable Bluetooth on the computer. On a touch-only device (phone or tablet) the buzzer button and the rules card are hidden unless the page was opened with `?kiosk=1`, because visitors' phones have no buzzers.

## Usage Guide

### Connecting buzzers

1. **Switch on both buzzers.** At power-up the buzzer LED lights for half a second and the onboard LED blinks 5 times. While it waits for a connection the buzzer advertises as:
   - `Gravitee Quiz Buzzer - Green`
   - `Gravitee Quiz Buzzer - Red`

   and both LEDs flash briefly every 2 seconds.

2. **Click the Bluetooth button** in the header. The dialog has one row per colour.

3. **Click "Connect"** on a row. The browser opens its Bluetooth chooser (it lists only free buzzers: devices whose name starts with `Gravitee Quiz Buzzer` and that offer the buzzer service). Choose the buzzer:
   - the app connects, reads the buzzer id, subscribes to presses and battery, and flashes the LED;
   - the buzzer itself blinks 5 times to confirm the connection;
   - the row switches to "Connected" and shows the battery level.

4. **Verify**: press each buzzer, the row shows "Press received!". Presses made while the dialog is open never answer a question. "Test LEDs" lights the connected buzzers in turn (green, red, green, red).

The **colour is decided by the buzzer itself** (its id: 1 = green, 2 = red), not by the row you clicked. If you pick the red buzzer from the green row it is connected as red and the row tells you so. A colour that is already connected is never replaced.

### Playing the game

1. Register and start the game as usual.
2. When a question is shown (and its countdown starts), **both buzzer LEDs turn on**.
3. Answer with the **Green** or the **Red** buzzer. Taps and the `G` / `R` keys stay active at the same time. The first answer wins.
4. After the answer (or at timeout) **both LEDs turn off**. The game never shows whether an answer was right during play (the server reveals it with the final results), so there is no per-answer LED feedback.
5. About 0.65 s later the next question appears and the LEDs turn on again.
6. At the end of the game the LEDs stay off.

Presses outside a running question (landing, rules, results) are ignored. If a buzzer disconnects mid-game the game goes on with taps and keys while the app reconnects; after a reconnect the LED stays off until the next question.

### Managing connections

- **Disconnect one buzzer**: "Disconnect" on its row (the LED is switched off first, no automatic reconnect).
- **Disconnect all**: "Disconnect all" in the dialog footer.
- **Stop retrying**: while a buzzer shows "Connection lost. Reconnecting… (attempt n)", the row button reads "Stop reconnecting".
- **Reconnect**: "Connect" again.

**Automatic reconnect:** when a link drops unexpectedly, the app retries forever with delays of 0.5 s, 1 s, 2 s, 4 s, 8 s, then every 15 s (±20 % jitter). A toast (and a screen-reader announcement) tells the player when a buzzer is lost and when it is back. After a page **reload** the BLE link is dropped by the browser; the app then silently reconnects the buzzers this browser was already allowed to use (Chrome/Edge 122+), otherwise use "Connect" again.

### Kiosk mode (booth laptop)

Open `https://quiz.events.gravitee.io/{slug}?kiosk=1` on the booth laptop. Kiosk mode:

- resets to the landing page after 45 s on the results screen and after 120 s without input on any other screen (never during a game or while saving), so the next visitor starts clean;
- forgets the language choice and the previous player's details (no autofill) and hides the link back to the hub;
- keeps the page loaded between visitors (the reset does not reload), so **the buzzers stay connected**;
- shows the buzzer button even on touch devices.

Add `&noscoreboard=1` to hide the scoreboard buttons from visitors (the scoreboard stays available on its own URL).

## Booth setup checklist

Before the event:
- [ ] Both buzzers charged (18650 full, about 4.2 V) or on USB power, flashed with different ids (green = 1, red = 2) and labelled.
- [ ] The event is `live` in the admin console and one full game was played.

At the booth:
- [ ] Laptop with **Chrome** (or Edge / Opera), Bluetooth on, and no other computer, phone or browser tab connected to the buzzers.
- [ ] Open `https://quiz.events.gravitee.io/{slug}?kiosk=1` on the laptop.
- [ ] Open the scoreboard on the TV: `https://quiz.events.gravitee.io/{slug}/scoreboard` (press `F` for fullscreen).
- [ ] Switch on both buzzers (onboard LED blinks 5 times, then a short flash every 2 s).
- [ ] Header Bluetooth button → **Connect green** (choose `Gravitee Quiz Buzzer - Green`) → **Connect red** (choose `Gravitee Quiz Buzzer - Red`). Both rows say "Connected" and the dot is full.
- [ ] **Test presses**: press each buzzer, "Press received!" appears; use "Test LEDs" if in doubt.
- [ ] Check the battery of both buzzers in the dialog (below 20 % = swap or charge).
- [ ] Close the dialog and play a test round: LEDs light for each question and go dark on the answer. `G` / `R` on the keyboard work as a backup.

During the event: do not reload the page, keep an eye on the dot in the header (amber blink = reconnecting, amber diamond = low battery).

## Battery

- The firmware targets an **18650 Li-ion cell** (3.0 V empty to 4.2 V full) and measures it with the nRF52840's internal VDDH/5 channel. It is sampled at boot and then every 5 minutes, so the displayed level can lag behind.
- The level is published through the standard Battery Service (percent). `battery.c` converts millivolts with a piecewise Li-ion curve: 100 % at 4.20 V or more, 90 % at 4.10 V, 70 % at 4.00 V, 40 % at 3.85 V, 20 % at 3.70 V, 5 % at 3.55 V, 0 % at 3.45 V or less.
- `config.h` also declares `BATTERY_LOW_MV` (3.4 V, "about 20 %") and the other `BATTERY_*_MV` constants, but `battery.c` does not use them; the curve above is what decides the percentage.
- The web app flags a buzzer at **20 % or less** ("Battery low: n %" in the row, amber diamond on the header dot, one toast), and re-arms the warning once the level is back above 25 %.
- Battery life has not been measured on the 18650 build: charge both buzzers before each event.
- The LED has no firmware auto-off: it stays as last written, the app switches it off.

## Troubleshooting

### Buzzer not appearing in the Bluetooth chooser

1. **Is it already connected somewhere else?** The firmware accepts **one** connection and stops advertising while connected: a buzzer paired with another computer, a phone (nRF Connect...) or another browser tab will not appear. Disconnect it there, or switch the buzzer off and on.
2. Check it is advertising: the onboard LED and the buzzer LED flash briefly every 2 s while it waits for a connection.
3. Check the name: the chooser only shows devices named `Gravitee Quiz Buzzer…` that offer the buzzer service. A buzzer running an older firmware (other name, no custom service) must be re-flashed.
4. Bluetooth must be switched on; use Chrome, Edge or Opera; the page must be on HTTPS or `localhost`.
5. Move closer (about 10 m range) and remove obstacles.

### Connection drops

1. A **page reload or navigation drops the link**; the buzzer restarts advertising and Chrome/Edge 122+ reconnect automatically. If they do not, open the dialog and press "Connect".
2. While the row says "Reconnecting…" the app keeps retrying. If another computer grabbed the buzzer in the meantime, the retries fail until it is released.
3. Check the battery level, reduce the distance, limit Bluetooth interference and metal obstacles.

### Wrong colour, or "unknown id"

- The id (not the row you clicked) decides the colour: **1 = green, 2 = red**. A swapped colour means the buzzer was flashed with the other `BUZZER_ID`: re-flash it.
- "The green buzzer is already connected": two buzzers carry the same id. Re-flash one with the other id.
- "This buzzer has an unknown id": the id characteristic returned something other than 1 or 2; re-flash with a supported firmware.
- "That device is not a Gravitee quiz buzzer": the device lacks the buzzer service.

### Battery level missing or low

- The level appears after connecting and is refreshed by the buzzer every 5 minutes. A buzzer without the Battery Service still plays, it just shows no level. If the firmware cannot start its ADC it keeps reporting 100 %.
- A low-battery warning means 20 % or less (about 3.7 V on the 18650 curve): charge or swap the cell.

### Button presses not registering

1. In the dialog, press the buzzer: "Press received!" must appear. If it does not, the link is down or the buzzer is not the one connected.
2. Check the button wiring (P0.11 to GND).
3. Presses closer than 250 ms on the same buzzer are ignored (50 ms debounce in the firmware plus 250 ms in the app), and presses outside a running question do nothing.
4. Read the serial output (see Testing).

### LED not working

1. Check the LED wiring and polarity (P0.06, 220 Ω resistor, cathode to GND).
2. In the dialog, use "Test LEDs". The LED is a single on/off output: it lights when any of the three written bytes is above 128.
3. Check `BUZZER_LED_PIN` in `config.h` and the `led1` entry of the overlay.

### Web Bluetooth not available

1. Use Chrome, Edge or Opera (not Safari, Firefox or any iOS browser).
2. Open the quiz over HTTPS (or `http://localhost:8080`).
3. Check that Bluetooth is enabled; the dialog says so when the browser reports no adapter.
4. "The browser blocked Bluetooth access": check the site permissions (lock icon in the address bar) and that no proxy rewrites the `Permissions-Policy` header.

## Security Considerations

- **No BLE security**: the firmware does no bonding or encryption (`CONFIG_BT_GATT_AUTO_SEC_REQ=n`, plain permissions). Any BLE device in range can connect to a free buzzer, read its state and switch its LED. Once a browser is connected nobody else can take the buzzer (one connection).
- **No pairing code**: "pairing" in the browser is a site permission (Chrome remembers the chosen buzzers per site, which enables the silent restore), not BLE pairing. Revoke it from the browser's site settings if needed, for example on a shared laptop.
- **Same server rules**: a buzzer press is just another way to click an answer; the game session, submit token and timing rules are unchanged.
- **Range limited**: BLE typically works within 10 meters.

## Customization

### LED behaviour

The "ready" light is driven from `web/js/event/views/game.js` (`ctx.buzzer.setReady(true | false)`), which calls `setReady` in `web/js/buzzer/ble.js`. The LED colours are the `LED` constants in `ble.js`:

```javascript
export const LED = Object.freeze({ green: [0, 255, 0], red: [255, 0, 0], off: [0, 0, 0] });
```

The hardware has one white LED, so only on (any byte > 128) and off matter. The module also offers `feedback(color, isCorrect)` (steady 600 ms flash when correct, three blinks when wrong); the game does not call it because correctness is not known during play.

### Changing pin assignments

The device tree overlay is the source of truth for the button and the LEDs. Edit `buzzer-firmware/promicro_nrf52840.overlay` (`button0`, `status_led`, `buzzer_led`) and keep `BUZZER_LED_PIN` in `buzzer-firmware/src/config.h` in sync, because `led.c` (GATT LED control) uses the constant while `main.c` (status patterns) uses the overlay:

```c
#define BUZZER_LED_PIN      6   // P0.06 - external white LED
```

`BUTTON_PIN` in `config.h` is only a fallback when the overlay has no `sw0` alias.

### Adjusting debounce

Firmware (`config.h`): `#define BUTTON_DEBOUNCE_MS 50`. App (`ble.js`): the `debounceMs` option of `createBuzzerManager` (default 250 ms per buzzer).

### Heartbeat blink

`LED_BLINK_DISCONNECTED_MS` (2000) and `LED_BLINK_CONNECTED_MS` (5000) at the top of `buzzer-firmware/src/main.c`.

### Reconnect and low battery thresholds

`reconnectDelays` and `jitter` options of `createBuzzerManager`, and `BATTERY_LOW` (20) in `web/js/buzzer/ble.js`.

### Texts

`web/js/buzzer/strings.js` (EN and FR). A host dictionary entry under `buzzer.*` overrides the built-in text.

## BLE Specifications

### Advertising and connection

| Item | Value |
|---|---|
| Name | `Gravitee Quiz Buzzer - Green` or `Gravitee Quiz Buzzer - Red` (set from `BUZZER_ID`, sent in the scan response) |
| Advertising data | flags + complete 128-bit buzzer service UUID |
| Advertising interval | 50 ms to 100 ms |
| Preferred connection interval | 10 ms to 15 ms, latency 0, supervision timeout 4 s |
| Connections | 1 (`CONFIG_BT_MAX_CONN=1`); advertising stops while connected and restarts after a disconnect |
| Security | none (no bonding, no encryption) |

### Service UUID
`6E400001-B5A3-F393-E0A9-E50E24DCCA9E` (custom Quiz Buzzer Service)

### Characteristics

| Characteristic | UUID | Properties | Description |
|----------------|------|------------|-------------|
| Button State | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | READ, NOTIFY | 1 byte. `0x01` is notified on every **press**; releases are never notified (a read returns `1` after the first press). |
| LED Control | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | READ, WRITE | Exactly 3 bytes `[R, G, B]` (other lengths are rejected). The LED is on if any byte is above 128, off otherwise, and stays as written. A read returns the last value written. |
| Buzzer ID | `6E400004-B5A3-F393-E0A9-E50E24DCCA9E` | READ | 1 byte: `0x01` = Green, `0x02` = Red |
| Battery Level | `00002A19-0000-1000-8000-00805F9B34FB` (in the standard Battery Service `0000180F-…`) | READ, NOTIFY | 1 byte, 0 to 100 % |

## Testing

### Test the firmware
Serial logging is already enabled in `prj.conf` (`printk` over the board's USB serial port):

```bash
cd buzzer-firmware
west build -b promicro_nrf52840/nrf52840/uf2 --pristine
# flash the UF2, then read the serial output (macOS: /dev/tty.usbmodem*, Linux: /dev/ttyACM0)
screen /dev/ttyACM0 115200
```

### Test the player app
1. Open the browser console (F12).
2. Connect the buzzers from the dialog and watch for warnings (`buzzer: LED write failed…`).
3. Press the buttons: the row shows "Press received!" and the header button pulses.
4. Use "Test LEDs", then play a round.
5. To see which buzzers are advertising or connected, `chrome://bluetooth-internals` in Chrome lists the nearby devices.

## License

MIT License - See main project LICENSE file

## Contributing

Contributions welcome! Areas for improvement:
- Per-answer LED patterns (needs the game to know the result)
- Haptic feedback support
- Multi-language firmware messages
- Custom button actions
- Enhanced power management

## Resources

- [Web Bluetooth API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
- [Nordic nRF52840 Documentation](https://www.nordicsemi.com/Products/nRF52840)
- [Zephyr RTOS Documentation](https://docs.zephyrproject.org/)
- [BLE GATT Specifications](https://www.bluetooth.com/specifications/gatt/)
