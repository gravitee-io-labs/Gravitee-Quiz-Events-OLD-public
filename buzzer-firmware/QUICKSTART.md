# Quick Start Guide - Building Physical Buzzers

This guide will help you quickly build and deploy the buzzer firmware to your NRF52840 boards.

## Prerequisites Checklist

- [ ] Two Nice!Nano / Pro Micro nRF52840 boards (board `promicro_nrf52840`)
- [ ] USB cables for programming
- [ ] 2x Push buttons (momentary)
- [ ] 2x white LEDs (they light the button; the green / red identity comes from the button or housing colour and from `BUZZER_ID`)
- [ ] 2x 220Ω resistors (for LEDs)
- [ ] 2x 18650 Li-ion cells on the boards' battery input (optional: USB power also works)
- [ ] **nRF Connect SDK installed** (see Setup section below)
- [ ] Supported browser (Chrome/Edge/Opera) on the computer that runs the game

## Setup nRF Connect SDK (First Time Only)

### Using VS Code nRF Connect Extension (Recommended ✨)

The **nRF Connect for VS Code** extension is the modern, streamlined way to develop nRF applications.

1. **Install VS Code** (if not already installed)
   - Download from [code.visualstudio.com](https://code.visualstudio.com/)

2. **Install nRF Connect Extension**
   - Open VS Code
   - Go to Extensions (⌘+Shift+X on macOS, Ctrl+Shift+X on Windows/Linux)
   - Search for "nRF Connect for VS Code"
   - Click Install
   - Follow the extension's setup wizard

3. **Install Toolchain**
   - The extension will prompt you to install the toolchain
   - Click "Install Toolchain" in the welcome screen
   - Select a recent version (the last local build used v3.1.1)

4. **Install SDK**
   - After toolchain installation, click "Install SDK"
   - Select the latest nRF Connect SDK version

That's it! The extension handles all dependencies and environment setup automatically. ✅

## Quick Build Steps with VS Code

### 1. Hardware Assembly (per buzzer)

**Connect components to NRF52840:**

```
Button:
  - One leg → P0.11
  - Other leg → GND

LED (standard 2-pin white LED):
  - Anode (long leg, +) → 220Ω resistor → P0.06 (board pin "1")
  - Cathode (short leg, -) → GND

Battery (optional):
  - 18650 Li-ion → the board's battery input. The battery level is read
    through the nRF52840's internal VDDH/5 channel: no divider needed.

Note: The firmware uses P0.06 for the buzzer LED. The LED is a single
on/off output; the buzzer's colour (green / red) is its BUZZER_ID.
The onboard LED (P0.15) is used for status, nothing to wire.
```

### 2. Open Project in VS Code

1. **Open the buzzer-firmware folder** in VS Code
   ```bash
   cd /path/to/Gravitee-Quiz-Events
   code buzzer-firmware
   ```

2. **Create Build Configuration** (first time only)
   - Click on the nRF Connect icon in the left sidebar
   - In the "Applications" section, click "Add build configuration" (or the "+" button)
   - **Board**: `promicro_nrf52840` (Pro Micro / Nice!Nano nRF52840), UF2 bootloader variant `promicro_nrf52840/nrf52840/uf2`. The overlay `promicro_nrf52840.overlay` is written for this board; other boards need their own overlay (aliases `sw0`, `led0`, `led1`) and a matching `BUZZER_LED_PIN` in `config.h`
   - **Configuration**: Leave as default or select "prj.conf"
   - Click "Build Configuration" to create it
   - The build configuration will now appear in the sidebar

   **Troubleshooting:** If you don't see "Add build configuration":
   - Make sure you have `CMakeLists.txt` and `prj.conf` in the project root
   - Try: Command Palette (⌘+Shift+P) → "nRF Connect: Add Build Configuration"
   - If still not working, close and reopen the folder in VS Code

### 3. Flash GREEN Buzzer

1. **Edit config.h**
   - Open `src/config.h`
   - Set the `BUZZER_ID` line (line 15) to: `#define BUZZER_ID 1`
   - Save the file (⌘+S)

2. **Build the project**
   - Make sure your build configuration is selected (it should appear in the nRF Connect sidebar)
   - Click the "Build" button next to your configuration
   - Or use Command Palette (⌘+Shift+P) → "nRF Connect: Build"
   - Wait for build to complete

3. **Flash to device**
   
   **For Pro Micro / Nice!Nano boards:**
   - **Double-tap the RESET button** on the board (or short RST to GND twice quickly)
   - A USB drive will appear (e.g., "NICENANO" or similar)
   - **Drag and drop** `build/buzzer-firmware/zephyr/zephyr.uf2` onto the drive
   - The board will automatically reboot with your firmware

4. **Verify**
   - The LED lights for half a second, then the onboard LED blinks 5 times
   - The buzzer advertises as "Gravitee Quiz Buzzer - Green"
   - Check serial output if needed (click "Serial Terminal" in nRF Connect sidebar)

### 4. Flash RED Buzzer

1. **Edit config.h**
   - Open `src/config.h`
   - Set the `BUZZER_ID` line (line 15) to: `#define BUZZER_ID 2`
   - Save the file (⌘+S)

2. **Pristine Build** (recommended when changing config)
   - In nRF Connect sidebar, click "Pristine Build"
   - Or use Command Palette → "nRF Connect: Pristine Build"
   - This ensures a clean rebuild

3. **Connect second board**
   - Unplug first board
   - Plug in the second NRF52840 board via USB

4. **Flash to device**
   - Double-tap RESET and copy the new `build/buzzer-firmware/zephyr/zephyr.uf2` to the USB drive, as for the green buzzer

5. **Verify**
   - Same start-up sequence as the green buzzer (the colour is not visible on the LED)
   - Board should advertise as "Gravitee Quiz Buzzer - Red"

### 5. Test Buzzers

**Power on both buzzers:**
- At power-up the buzzer LED lights for half a second, then the onboard LED blinks 5 times
- While waiting for a connection, the onboard LED and the buzzer LED flash briefly every 2 seconds: the buzzer is advertising
- Pressing the button while not connected flashes the buzzer LED 3 times

**LED behaviour with the game (once connected):**
1. **Connected**: the buzzer LED blinks 5 times (and the onboard LED flashes every 5 s)
2. **Question open**: both connected buzzers' LEDs turn ON
3. **Answer given or time out**: both LEDs turn OFF (the game does not show right / wrong during play)
4. **Next question**: both LEDs turn ON again
5. **Game end**: LEDs stay OFF

**Debug with Serial Terminal (optional):**
- In VS Code, click "Serial Terminal" in nRF Connect sidebar
- Select the serial port of your board
- Press the button and see debug messages

### 6. Connect to Game

Production: `https://quiz.events.gravitee.io/{slug}`; local: `http://localhost:8080/{slug}` (Web Bluetooth needs HTTPS or localhost).

1. Open the game in Chrome/Edge/Opera
2. Click the Bluetooth button in the header (on the landing page, rules page or during the game)
3. Click "Connect" on the Green row
   - Select "Gravitee Quiz Buzzer - Green" from the browser dialog
   - Wait for "Connected" (the buzzer blinks 5 times)
4. Click "Connect" on the Red row
   - Select "Gravitee Quiz Buzzer - Red" from the browser dialog
   - Wait for "Connected"
5. Press each buzzer: "Press received!" appears; click "Test LEDs" to light them in turn
6. Start playing! (`G` / `R` on the keyboard always work)

A buzzer that is already connected to another computer does not show up in the browser dialog (one connection at a time). For a booth, see the "Booth setup checklist" in `../BUZZER_INTEGRATION.md`.

## Common Issues

### VS Code Extension Issues

**Extension not loading:**
1. Restart VS Code
2. Check if Python is installed: `python3 --version`
3. Reinstall the extension if needed

**Toolchain/SDK installation fails:**
1. Check internet connection
2. Make sure you have enough disk space (~5GB)
3. Try installing from nRF Connect sidebar → Toolchain Manager

**Build configuration missing:**
- Make sure you ran "Create a new application" step
- Check that `build` folder exists in your project
- Try "Add Build Configuration" from Command Palette

### UF2 drive does not appear / flashing fails

**Solutions:**
1. Check the USB cable (it must carry data, not only power)
2. Double-tap RESET faster (or short RST to GND twice quickly)
3. Make sure the board really runs the UF2 bootloader (Nice!Nano / Pro Micro) and was built with the `promicro_nrf52840/nrf52840/uf2` variant
4. Check device permissions (Linux): `sudo usermod -a -G dialout $USER`

### LED doesn't light up

**Checks:**
1. Verify LED polarity (long leg/anode to resistor, short leg/cathode to GND)
2. Check resistor value (220Ω)
3. Test LED with multimeter or 3V battery
4. Verify LED is connected to P0.06 (and `BUZZER_LED_PIN` is 6 in `config.h`)
5. Make sure the LED isn't burned out

### Button doesn't work

**Checks:**
1. Verify button is connected to P0.11 and GND
2. Test button continuity with multimeter
3. Check if button is normally open (not normally closed)

### Can't find buzzer in browser

**Checks:**
1. Is buzzer powered on? (onboard LED and buzzer LED flash every 2 s while advertising)
2. Is it **already connected to another computer, phone or browser tab**? The firmware accepts one connection and stops advertising while connected; disconnect it there or power cycle the buzzer
3. Is Bluetooth enabled on computer?
4. Using Chrome/Edge/Opera, on HTTPS or localhost?
5. Does it advertise as "Gravitee Quiz Buzzer - Green/Red"? Older firmware with another name must be re-flashed
6. Check distance (within 10 meters)

### Wrong colour in the game

The colour comes from the buzzer's id (`BUZZER_ID`: 1 = green, 2 = red), not from the row you click. Re-flash the buzzer with the other id if it is swapped; two buzzers with the same id cannot be connected together.

## Customization Examples

### Change LED Pin

Edit `src/config.h`:

```c
#define BUZZER_LED_PIN  6   // P0.06 - external white LED
```

and the `buzzer_led` entry (`led1` alias) of `promicro_nrf52840.overlay`: `led.c` (LED Control characteristic) uses the constant, `main.c` (connection blinks) uses the overlay.

Note: the LED is a simple on/off output (not RGB). The RGB bytes sent by the game are converted: if any value is above 128 the LED is on, otherwise off.

### Change Button Pin

The button comes from the overlay (`button0`, `gpios = <&gpio0 11 ...>`). `BUTTON_PIN` in `src/config.h` is only a fallback when no `sw0` alias exists.

### Change the blink rhythm

At the top of `src/main.c`:

```c
#define LED_BLINK_DISCONNECTED_MS 2000  // heartbeat while advertising
#define LED_BLINK_CONNECTED_MS   5000  // heartbeat while connected
```

There is no firmware auto-off for the buzzer LED: it stays as the game last wrote it (the game switches it off after each answer).

## Advanced: Debug Mode

Serial logging (`printk`) is already enabled in `prj.conf` (USB serial port of the board). For more detail, raise the log levels:

1. Edit `prj.conf`:
```conf
CONFIG_LOG_DEFAULT_LEVEL=3
CONFIG_BT_LOG_LEVEL_DBG=y
```
(replace the `CONFIG_BT_LOG_LEVEL_WRN=y` line)

2. Rebuild and flash:
```bash
west build -b promicro_nrf52840/nrf52840/uf2 --pristine
# then double-tap RESET and copy build/buzzer-firmware/zephyr/zephyr.uf2
```

3. View serial output:
```bash
# macOS
screen /dev/tty.usbmodem* 115200

# Linux
screen /dev/ttyACM0 115200

# Windows (use PuTTY or similar)
# Connect to the board's COM port at 115200 baud
```

## Next Steps

✅ Both buzzers working? Great!

Now you can:
- Do a full test with the "Booth setup checklist" in `../BUZZER_INTEGRATION.md`
- Customize the status LED patterns in `src/main.c`
- Adjust the BLE and button settings in `src/config.h`
- Add additional button actions
- Design a custom enclosure

## Support

- **Firmware Issues**: Check `buzzer-firmware/README.md`
- **Web Integration**: Check `../BUZZER_INTEGRATION.md` (setup, booth checklist, troubleshooting) and `../BUZZER_ARCHITECTURE.md`
- **General Help**: Open an issue on GitHub

Happy buzzing! 🎮
