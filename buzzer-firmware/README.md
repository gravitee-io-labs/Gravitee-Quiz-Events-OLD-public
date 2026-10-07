# Quiz Game Buzzer Firmware (NRF52840)

This firmware turns an NRF52840-based board (Nice!Nano / Pro Micro, `promicro_nrf52840`) into a Bluetooth Low Energy (BLE) quiz game buzzer with LED feedback. The player app (`web/js/buzzer/`) talks to it with Web Bluetooth; see [../BUZZER_INTEGRATION.md](../BUZZER_INTEGRATION.md) for the web side, usage and troubleshooting, and [../BUZZER_ARCHITECTURE.md](../BUZZER_ARCHITECTURE.md) for the diagrams.

## Features

- **BLE GATT Service**: Custom service for quiz buzzer functionality, plus the standard Battery Service
- **Button Detection**: Debounced (50 ms) button press notification via BLE
- **LED Control**: On/off control of the buzzer LED from the game client
- **Battery Monitoring**: 18650 Li-ion level, reported through the Battery Service
- **Two Buzzer Support**: Green (id 1) and Red (id 2) identification, set at build time
- **Single connection**: one BLE client at a time; the buzzer does not advertise while connected

## Hardware Requirements

- NRF52840 board supported by the overlay: Nice!Nano / Pro Micro nRF52840 (2 units - one for Green, one for Red). Other boards need their own overlay (aliases `sw0`, `led0`, `led1`) and a matching `BUZZER_LED_PIN`
- Push button connected to P0.11 and GND
- White LED on P0.06 through a 220 Ω resistor (it lights the button; the green / red identity is `BUZZER_ID` and the button / housing colour)
- 18650 Li-ion cell (3.0 V to 4.2 V) on the board's battery input, or USB power

## Pin Configuration

Pins are defined in the device tree overlay (`promicro_nrf52840.overlay`); `config.h` carries the LED pin used by `led.c`:

- **Button**: P0.11 (active low with internal pull-up, 50 ms debounce)
- **Buzzer LED**: P0.06 (external white LED, active high)
- **Status LED**: P0.15 (onboard LED, active low) - connection heartbeat
- **Battery**: internal VDDH/5 ADC channel, no external divider needed

## BLE Service Specification

**Device name**: `Gravitee Quiz Buzzer - Green` (id 1) or `Gravitee Quiz Buzzer - Red` (id 2). The browser filters on the prefix `Gravitee Quiz Buzzer` and on the service UUID.

**Advertising**: connectable, 50 ms to 100 ms interval, 128-bit service UUID in the advertising data (the name is in the scan response). Preferred connection interval 10 ms to 15 ms. `CONFIG_BT_MAX_CONN=1`: while a client is connected the buzzer does not advertise, so it does not appear in another computer's Bluetooth chooser; advertising restarts after a disconnect. No bonding or encryption.

**Service UUID**: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` (Custom Quiz Buzzer Service)

### Characteristics:

1. **Button State** (UUID: `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`)
   - Properties: READ, NOTIFY
   - Value: 1 byte. `0x01` is notified on every press (the client must enable notifications). Releases are not notified, so a read returns `1` after the first press.

2. **LED Control** (UUID: `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`)
   - Properties: WRITE, READ
   - Value: exactly 3 bytes `[R, G, B]` (other lengths are rejected). The LED is on if any byte is above 128 and off otherwise; it stays as written (there is no auto-off). A read returns the last value written.

3. **Buzzer ID** (UUID: `6E400004-B5A3-F393-E0A9-E50E24DCCA9E`)
   - Properties: READ
   - Value: 1 byte (0x01 = Green, 0x02 = Red)

4. **Battery Level** (UUID: `00002A19-0000-1000-8000-00805F9B34FB`, in the standard Battery Service `0000180F-0000-1000-8000-00805F9B34FB`, provided by Zephyr `CONFIG_BT_BAS`)
   - Properties: READ, NOTIFY
   - Value: 1 byte (0-100%)

## Building the Firmware

### Prerequisites

1. Install [nRF Connect SDK](https://www.nordicsemi.com/Products/Development-software/nRF-Connect-SDK) (the last local build used v3.1.1)
2. Install [nRF Command Line Tools](https://www.nordicsemi.com/Products/Development-tools/nrf-command-line-tools)

### Build Steps

```bash
# Initialize the nRF Connect SDK environment
source ~/ncs/zephyr/zephyr-env.sh

# Navigate to firmware directory
cd buzzer-firmware

# Build for the Pro Micro / Nice!Nano nRF52840 (UF2 bootloader variant)
west build -b promicro_nrf52840/nrf52840/uf2 --pristine
```

Double-tap RESET to start the UF2 bootloader and copy `build/buzzer-firmware/zephyr/zephyr.uf2` to the drive that appears. Set `BUZZER_ID` in `src/config.h` first (1 = Green, 2 = Red) and use `--pristine` again after changing it.

## Configuration

Edit `src/config.h` to customize:

- Buzzer ID (Green = 1 / Red = 2) and the device names derived from it
- Buzzer LED pin (`BUZZER_LED_PIN`; keep it in sync with the `led1` entry of the overlay)
- Button debounce (`BUTTON_DEBOUNCE_MS`), advertising and connection intervals
- UUIDs

The button, status LED and ADC come from `promicro_nrf52840.overlay`. The heartbeat blink periods (`LED_BLINK_DISCONNECTED_MS`, `LED_BLINK_CONNECTED_MS`) are at the top of `src/main.c`.

Some constants in `config.h` are currently not used by the code: `LED_AUTO_OFF_TIMEOUT_MS`, `BUTTON_NOTIFICATION_TIMEOUT_MS`, `STATUS_LED_PIN`, `BATTERY_ADC_CHANNEL`, `BATTERY_DIVIDER_RATIO` and the `BATTERY_*_MV` thresholds (the percentage comes from the curve in `battery.c`).

## Behaviour and Power

- **Power-up**: the buzzer LED lights for 0.5 s, then the onboard LED blinks 5 times
- **Advertising**: onboard LED and buzzer LED flash for 50 ms every 2 s; a button press flashes the buzzer LED 3 times
- **Connected**: the buzzer LED blinks 5 times; the onboard LED flashes for 50 ms every 5 s; a press sends the notification
- **Battery**: measured at boot and then every 5 minutes (2 % hysteresis). Percentage curve in `battery.c`: 100 % at 4.20 V or more, 90 % at 4.10 V, 70 % at 4.00 V, 40 % at 3.85 V, 20 % at 3.70 V, 5 % at 3.55 V, 0 % at 3.45 V or less. If the ADC cannot start, 100 % is reported. The web app flags 20 % or less as low
- **Power saving**: DC/DC regulator enabled, `CONFIG_PM`, moderate advertising interval, slow heartbeat. Current consumption and battery life have not been measured on the 18650 build

## Pairing Process

There is no BLE pairing or PIN. The "pairing" is the browser connecting through the Web Bluetooth chooser:

1. Power on the buzzer
2. Device advertises as "Gravitee Quiz Buzzer - Green" or "Gravitee Quiz Buzzer - Red"
3. Connect from the buzzer dialog in the player app (header Bluetooth button)
4. The buzzer LED blinks 5 times to confirm the connection

## Troubleshooting

- **Device not advertising / not in the chooser**: check power and reset the board; check that it is not already connected to another computer, phone or browser tab (one connection at a time)
- **Connection drops**: ensure the device is within 10m range and the battery is charged; a page reload also drops the link
- **Button not responding**: check the P0.11 wiring and the overlay
- **LED not working**: verify P0.06, the polarity and the 220 Ω resistor
- **Wrong colour in the app**: the colour comes from `BUZZER_ID`; re-flash with the other id

## License

MIT License - See main project LICENSE file
