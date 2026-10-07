# Physical Buzzer System Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│              Player app in the browser  (web/, https://…/{slug})         │
│                                                                          │
│  Game  (web/js/event/)                  Buzzer module  (web/js/buzzer/)  │
│  ┌─────────────────────────┐            ┌────────────────────────────┐  │
│  │ buzzer.js (loader)      │──import───►│ index.js                   │  │
│  │ main.js                 │◄─onPress───│  createBuzzerController    │  │
│  │  ctx.onBuzzerPress      │            │   ├─ ui.js                 │  │
│  │ views/game.js           │──setReady─►│   │   header button+status │  │
│  │  answer(color)          │            │   │   dot, <dialog> rows   │  │
│  │  keys G / R, taps       │            │   ├─ strings.js  (EN / FR) │  │
│  └─────────────────────────┘            │   └─ ble.js  BLE manager   │  │
│                                         └─────────────┬──────────────┘  │
│                                                       │                  │
│  ┌────────────────────────────────────────────────────▼───────────────┐ │
│  │ Web Bluetooth API  (HTTPS or localhost only; Chrome / Edge / Opera)│ │
│  │  requestDevice() · getDevices() · gatt.connect() · notifications   │ │
│  └────────────────────────────────────────────────────┬───────────────┘ │
└───────────────────────────────────────────────────────┼─────────────────┘
                                                        │ Bluetooth LE (GATT)
                         ┌──────────────────────────────┴──────────────┐
                         │                                             │
┌────────────────────────▼───────────┐   ┌─────────────────────────────▼──────┐
│ Green buzzer      BUZZER_ID = 1    │   │ Red buzzer        BUZZER_ID = 2    │
│ "Gravitee Quiz Buzzer - Green"     │   │ "Gravitee Quiz Buzzer - Red"       │
│                                    │   │                                    │
│ nRF52840 (Nice!Nano / Pro Micro)   │   │ same hardware, same firmware,      │
│  main.c            init, adv, LEDs │   │ only BUZZER_ID differs             │
│  buzzer_service.c  GATT service    │   │                                    │
│  button.c          50 ms debounce  │   │ Button   P0.11 (pull-up)           │
│  led.c             buzzer LED      │   │ LED      P0.06 (white LED)         │
│  battery.c         VDDH/5 -> BAS   │   │ Status   P0.15 (onboard LED)       │
│                                    │   │ Battery  18650 Li-ion              │
└────────────────────────────────────┘   └────────────────────────────────────┘
        One connection per buzzer: a connected buzzer stops advertising
        (CONFIG_BT_MAX_CONN=1), so it is invisible to a second computer.
```

Both buzzers run the same firmware. The id (1 = green, 2 = red) is compiled in with `BUZZER_ID` in `buzzer-firmware/src/config.h`; it sets the advertised name and the value of the Buzzer ID characteristic. The browser decides the colour of a connected device from that characteristic only.

### Where the code lives

| Layer | File | Role |
|---|---|---|
| Game | `web/js/event/buzzer.js` | Guarded dynamic import of the buzzer module (the game works without it) |
| Game | `web/js/event/main.js` | Puts the header button in the app bar, forwards presses to `ctx.onBuzzerPress`, kiosk mode |
| Game | `web/js/event/views/game.js` | One `answer(color, via)` for taps, `G` / `R` keys and buzzer presses; calls `setReady(true / false)` |
| Module | `web/js/buzzer/index.js` | `createBuzzerController`: wires BLE, UI, toasts, auto-restore |
| Module | `web/js/buzzer/ble.js` | `createBuzzerManager`: Web Bluetooth, GATT queue, reconnect, LED patterns |
| Module | `web/js/buzzer/ui.js` | Header button with status dot, dialog with one row per colour |
| Module | `web/js/buzzer/strings.js` | EN / FR texts |
| Styles | `web/css/buzzer.css` | Button, dot and dialog styles |

## Data Flow - Button Press to Answer Submission

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Player presses the physical button (P0.11, active low)        │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 2. Button interrupt (button.c)                                  │
│    - GPIO interrupt on both edges                               │
│    - Debounce timer started (50 ms)                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 3. Button callback (main.c)                                     │
│    - State re-read after the debounce; only a change is reported│
│    - Release: ignored. Press with a BLE client connected: go on │
│    - Press while NOT connected: 3 quick flashes of the LED      │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 4. Buzzer service (buzzer_service.c)                            │
│    - button_state = 1, notification 0x01 if the client enabled  │
│      notifications (releases are never notified)                │
└────────────────────────────┬────────────────────────────────────┘
                             │ BLE notification
┌────────────────────────────▼────────────────────────────────────┐
│ 5. Web Bluetooth (ble.js)                                       │
│    - characteristicvaluechanged, first byte == 1 means pressed  │
│    - handlePress(): drops a second press of the same buzzer     │
│      within 250 ms, then emits 'press' { color, at }            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 6. Controller (index.js)                                        │
│    - ui.showPress(color): header pulse, "Press received!"       │
│    - dialog open: stop here (testing never answers a question)  │
│    - otherwise onPress(color)                                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 7. event/main.js → ctx.onBuzzerPress(color)                     │
│    - set by the game view while it is mounted, null elsewhere   │
│      (presses on landing / rules / results screens do nothing)  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 8. views/game.js  answer(color, 'buzzer')                       │
│    - same function as the G / R keys and the tap handlers       │
│    - ignored when locked or time is up (first answer wins)      │
│    - stops the clock, records { question_id, player_answer,     │
│      time_taken }, locks the buttons                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 9. LED "ready" state (ble.js setReady(false))                   │
│    - writes [0,0,0] to the LED Control characteristic of every  │
│      connected buzzer (queued per device)                       │
│    - led.c: led_off(). No correct / wrong feedback: the server  │
│      only reveals correctness with the final results            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 10. Next question (650 ms later)                                │
│     - once its image is ready: setReady(true) writes            │
│       [0,255,0] / [255,0,0]; any byte > 128 → LED on            │
│     - the countdown starts                                      │
└─────────────────────────────────────────────────────────────────┘
```

## BLE GATT Service Structure

```
┌─────────────────────────────────────────────────────────────────┐
│ Quiz Buzzer Service (custom)                                    │
│ UUID: 6E400001-B5A3-F393-E0A9-E50E24DCCA9E                      │
│ Listed in the advertising data; the name is in the scan response│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ┌─────────────────────────────────────────────────────────┐   │
│ │ Button State Characteristic                              │   │
│ │ UUID: 6E400002-B5A3-F393-E0A9-E50E24DCCA9E               │   │
│ │ Properties: READ, NOTIFY                                 │   │
│ │ Value: 1 byte. 0x01 is notified on each press.           │   │
│ │        Releases are not notified; a read returns 1 once  │   │
│ │        the button was pressed (it is never reset to 0).  │   │
│ │ ┌─────────────────────────────────────────────────────┐ │   │
│ │ │ CCC Descriptor (0x2902)                             │ │   │
│ │ │ - the client must enable notifications              │ │   │
│ │ └─────────────────────────────────────────────────────┘ │   │
│ └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────┐   │
│ │ LED Control Characteristic                               │   │
│ │ UUID: 6E400003-B5A3-F393-E0A9-E50E24DCCA9E               │   │
│ │ Properties: READ, WRITE                                  │   │
│ │ Value: exactly 3 bytes [R, G, B]; other lengths are      │   │
│ │ rejected. The hardware LED is a single white LED:        │   │
│ │   any byte > 128  → LED on                               │   │
│ │   all bytes ≤ 128 → LED off                              │   │
│ │ The state is kept as written (no firmware auto-off).     │   │
│ │ Used by the app: [0,255,0] (green ready), [255,0,0]      │   │
│ │ (red ready), [0,0,0] (off).                              │   │
│ └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────┐   │
│ │ Buzzer ID Characteristic                                 │   │
│ │ UUID: 6E400004-B5A3-F393-E0A9-E50E24DCCA9E               │   │
│ │ Properties: READ                                         │   │
│ │ Value: 1 byte (0x01 = Green, 0x02 = Red)                 │   │
│ └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Battery Service (standard, Zephyr CONFIG_BT_BAS)                │
│ UUID: 0000180F-0000-1000-8000-00805F9B34FB                      │
│ Not part of the custom service: the app asks for it as an       │
│ optional service and works without it.                          │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐   │
│ │ Battery Level Characteristic                             │   │
│ │ UUID: 00002A19-0000-1000-8000-00805F9B34FB               │   │
│ │ Properties: READ, NOTIFY                                 │   │
│ │ Value: 1 byte (0-100 %)                                  │   │
│ │ Updated at boot, then at most every 5 minutes            │   │
│ └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

Device selection in the browser: `requestDevice({ filters: [{ namePrefix: 'Gravitee Quiz Buzzer', services: [buzzer service] }], optionalServices: [battery service] })`.

Connection parameters: advertising 50 to 100 ms; preferred connection interval 10 to 15 ms, latency 0, supervision timeout 4 s. The firmware has `CONFIG_BT_MAX_CONN=1`, no bonding and no encryption.

## Connection State Machines

### Buzzer (firmware)

```
┌─────────────┐
│   POWER ON  │
└──────┬──────┘
       ▼
┌───────────────────────────────────────────────┐
│ INITIALIZING                                  │
│ buzzer LED test (0.5 s), onboard LED blinks 5x│
│ button, bt_enable, name, GATT, battery (ADC)  │
└──────┬─────────────────────────────┬──────────┘
       │ success                     │ failure
       ▼                             ▼
┌──────────────────────────┐    ┌─────────┐
│ ADVERTISING              │    │  ERROR  │
│ every 50-100 ms          │    └─────────┘
│ heartbeat: onboard LED   │◄───────────────────────┐
│ and buzzer LED flash     │                        │
│ 50 ms every 2 s          │                        │
│ button press: buzzer LED │                        │ disconnect, any reason
│ flashes 3x               │                        │ (advertising restarts
└──────┬───────────────────┘                        │  after about 100 ms)
       │ a client connects (no pairing step)        │
       ▼                                            │
┌──────────────────────────┐                        │
│ CONNECTED                │────────────────────────┘
│ advertising stopped      │
│ (max 1 connection)       │
│ buzzer LED blinks 5x     │
│ heartbeat: onboard LED   │
│ 50 ms every 5 s          │
│                          │
│ press -> notify 0x01     │
│  (once the client has    │
│  enabled notifications)  │
│ LED Control write        │
│  -> LED on / off, kept   │
│     until the next write │
└──────────────────────────┘
```

### Browser (one slot per colour, `ble.js`)

```
                click "Connect": the browser chooser opens
┌──────────────┐ ──────────────────────────────────────► ┌────────────┐
│ disconnected │ ◄── chooser cancelled, connect failed ── │ connecting │
└──────────────┘                                         └─────┬──────┘
       ▲                                                       │ GATT connect, read id,
       │ "Disconnect" (LED switched off first, no retry)       │ enable press + battery
       │                                                       │ notifications
       │                                                 ┌─────▼──────┐
       ├─────────────────────────────────────────────────┤ connected  │◄─────────┐
       │                                                 └─────┬──────┘          │
       │                                                       │ link lost       │ retry works
       │ "Stop reconnecting"                                   │ (not manual)    │ (LED flash 200 ms)
       │                                                 ┌─────▼──────┐          │
       └─────────────────────────────────────────────────┤reconnecting├──────────┘
                                                         └────────────┘
```

While `reconnecting`, the slot retries after 0.5, 1, 2, 4 and 8 s, then every 15 s (each delay +/-20 %), forever; each attempt has a 12 s connect budget.

`restore()` runs once at start (Chrome/Edge 122+): it reconnects the devices the browser already knows (`getDevices()`), with a 6 s budget each, without a chooser.

## Power and LED Behaviour

| Item | Value | Source |
|---|---|---|
| Battery | 18650 Li-ion (3.0 V to 4.2 V) or USB | `config.h`, `battery.c` |
| Battery measurement | internal VDDH/5 ADC channel, at boot then every 5 minutes (the main loop wakes every 10 s and the sampling is rate-limited), 2 % hysteresis | `battery.c`, `config.h` |
| Percentage curve | 100 % at 4.20 V, 90 % at 4.10 V, 70 % at 4.00 V, 40 % at 3.85 V, 20 % at 3.70 V, 5 % at 3.55 V, 0 % at 3.45 V | `battery.c` |
| Declared thresholds | `BATTERY_LOW_MV` 3.4 V ("about 20 %") and friends exist in `config.h` but are not used by `battery.c` | `config.h` |
| Low-battery flag in the app | 20 % or less (`BATTERY_LOW` in `ble.js`) | `ble.js` |
| DC/DC regulator | enabled | `promicro_nrf52840.overlay` |
| Advertising / connection interval | 50 to 100 ms / 10 to 15 ms | `config.h` |
| Onboard LED (P0.15, active low) | 50 ms flash every 2 s while advertising, every 5 s while connected | `main.c` |
| Buzzer LED (P0.06, active high) | only lit by the app (LED Control), by the 5 connection blinks, the 3 flashes of a press while disconnected, and the heartbeat while disconnected; no auto-off | `main.c`, `led.c` |
| Consumption / battery life | not measured on the 18650 build | |

If the ADC cannot be initialised the firmware keeps reporting 100 %.

## Error Handling Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    Error Scenarios                           │
└──────────────────────────────────────────────────────────────┘

1. Connection lost
   Browser ─────X────► Buzzer
      │
      └─► gattserverdisconnected event
           │
           ├─► slot 'reconnecting': toast + screen-reader message,
           │   header dot blinks amber, row shows "attempt n"
           │
           ├─► retries with backoff until it works or the user clicks
           │   "Stop reconnecting"
           │
           └─► the game continues with taps and the G / R keys

2. Page reload
   The browser drops the GATT link, the buzzer advertises again.
   Chrome/Edge 122+ restore the known buzzers silently; otherwise the
   player presses "Connect" again.

3. Chooser cancelled
   NotFoundError ("User cancelled") ──► silent, nothing to report

4. Buzzer not in the chooser
   Already connected elsewhere (one connection at a time, no advertising
   while connected), switched off, out of range, or another firmware.

5. Wrong or unknown device
   - id 1 / 2 decides the colour, not the row that was clicked ('assigned')
   - colour already connected ──► 'taken', the other device is dropped
   - id not 1 or 2 ──► 'unknown id'; no buzzer service ──► 'not a buzzer'

6. Button bounce / double press
   Firmware: 50 ms debounce. App: 250 ms per buzzer.

7. Duplicate or late answer
   game.js answer(): locked flag set first, so the first of key / tap /
   buzzer wins; an answer after the deadline counts as a timeout.

8. BLE operation failure
   GATT operations are queued per device (Web Bluetooth rejects
   overlapping operations) and time out after 15 s. A failed LED write
   is logged (console.warn) and the game continues.

9. Battery service missing or ADC unavailable
   The app shows no battery for that buzzer; the firmware reports a
   constant 100 % when its ADC cannot start.

10. Web Bluetooth unavailable
   Browser without Web Bluetooth, or page not on HTTPS / localhost: the
   header icon turns into "bluetooth-slash" and the dialog explains why.
   The game itself is not affected.
```

See [BUZZER_INTEGRATION.md](BUZZER_INTEGRATION.md) for setup, the booth checklist and troubleshooting.
