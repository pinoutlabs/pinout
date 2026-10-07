# Pinout Setup Guide

This guide walks operators and testers through initial environment setup, reference circuit wiring, manual firmware flashing, diagnostic verification with `pinout doctor`, and hardware enrollment.

---

## ⏱️ Acceptance Goal: Under 15 Minutes Setup

Pinout aims for a fresh operator or second tester to repeat setup in **under 15 minutes** after physical wiring and firmware preparation.

> **Time Yourself:** Please measure and record your setup duration from the completion of physical wiring to your first successful status verification and actuation. Record your findings and notes in your test log.

Copy this block into `hardware/records/YYYY-MM-DD-setup-trial.md` (do not overwrite another tester's file). Honest >15 min is a valid outcome.

```markdown
- Start (wiring + firmware done):
- End (first status + actuation):
- Elapsed:
- `pinout doctor` FAIL/WARN hits + how resolved:
- Times you had to ask a maintainer:
- Under 15 min? (yes/no, no judgment):
```

`pinout doctor` is non-actuating (only `sys.hello` during discovery).

---

## Prerequisites

- **Node.js**: Version 20.0.0 or higher (`node -v`).
- **USB Data Cable**: Ensure the cable carries USB data lines (not a charge-only cable).
- **Target Hardware**:
  - Reference Target: Classic ESP32 DevKit (ESP-WROOM-32 30-pin, CP2102 or CH340 USB bridge).
  - Or Software Simulation: No hardware required (pass `--mock`).
- **Build Tooling (for physical hardware)**: [PlatformIO Core (CLI)](https://platformio.org/install/cli) or Arduino IDE.

---

## Step 1: Wire the Reference Circuit

Before connecting USB, wire your breadboard according to [`hardware/reference/esp32-classic-led-sensor.md`](../hardware/reference/esp32-classic-led-sensor.md).

### Circuit Wiring Summary

| From ESP32 Pin | Component | To Destination | Function | Declared Safe Level |
| :--- | :--- | :--- | :--- | :--- |
| **GPIO 2** (D2) | $330\,\Omega$ Resistor ($R_1$) $\rightarrow$ Red LED ($LED_1$) Anode | GND Rail (LED Cathode) | Active-High Output | `LOW` (0 / Off) |
| **3.3 V** (3V3) | $330\,\Omega$ Resistor ($R_2$) $\rightarrow$ Green LED ($LED_2$) Anode | **GPIO 4** (D4) (LED Cathode) | Active-Low Output | `HIGH` (1 / Off) |
| **GPIO 13** (D13) | Pushbutton Switch ($S_1$) Terminal 1 | GND Rail (Terminal 2) | Digital Input (Pull-Up) | Idle `HIGH` / Pressed `LOW` |
| **GND** | Jumper wire | Breadboard Ground Rail | Common Ground | Reference |

```text
       +3.3V (ESP32 3V3 Pin)
         |
         +-----------------------------+
         |                             |
        [R2: 330 Ohm]                  |
         |                             |
       (LED2: Green)                   |
         | (Cathode)                   |
         |                             |
      GPIO 4 [ACTIVE-LOW OUTPUT]       |
                                       |
      GPIO 2 [ACTIVE-HIGH OUTPUT]      |
         |                             |
        [R1: 330 Ohm]                  |
         |                             |
       (LED1: Red)                     |
         | (Cathode)                   |
         |                             |
         +-----------------------------+
         |                             |
        GND                            |
                                       |
      GPIO 13 [INPUT, PULL-UP]         |
         |                             |
        /  Switch S1 (Button)          |
       o   o                           |
         |                             |
        GND ---------------------------+
```

> ⚠️ **Forbidden Pins Warning:** Never connect circuits or external pull-ups to **GPIO 6–11** (integrated SPI flash) or **GPIO 12** (MTDI flash voltage strapping pin).

---

## Step 2: Flash Bridge Firmware (Explicit Manual Flashing)

Pinout enforces a strict safety boundary: **Pinout tools never automatically flash firmware to connected hardware.** Firmware upload must be explicitly initiated by the operator.

1. Connect the ESP32 DevKit to your host machine via USB cable.
2. Build and upload the bridge firmware using PlatformIO:

```bash
cd firmware/esp32-bridge
pio run -e esp32dev -t upload
```

3. For complete flashing instructions, troubleshooting serial boot logs, or using Arduino IDE, see [`firmware/esp32-bridge/README.md`](../firmware/esp32-bridge/README.md).

---

## Step 3: Start the Pinout Execution Daemon

`pinoutd` coordinates multi-agent leases, safety halts, and audit journals:

```bash
# Start daemon with demo devices in the background or in a separate terminal:
node packages/daemon/dist/main.js --demo
```

Verify daemon health:

```bash
npm run pinout -- daemon status
```

*(Note: Direct developer bring-up commands such as `hello`, `ports`, and direct `--port` commands operate in-process and do not strictly require a running daemon, but production agent workflows and MCP require `pinoutd`.)*

---

## Step 4: Run the Diagnostic Doctor

The `pinout doctor` command executes a comprehensive, staged diagnostic. It is provably **non-actuating**: it queries environment, daemon, and serial identity handshakes without toggling outputs or driving pins.

```bash
# Run full diagnostic:
npm run pinout -- doctor

# Probe a specific serial port:
npm run pinout -- doctor --port /dev/cu.usbserial-0001

# Skip daemon check for standalone direct bring-up:
npm run pinout -- doctor --no-daemon

# Structured JSON output for automated agent tooling:
npm run pinout -- doctor --json
```

### Understanding Doctor Output Stages

1. **`[ENVIRONMENT]`**:
   - `node-version`: Verifies Node.js $\ge 20$.
   - `pinout-home`: Confirms `~/.pinout` (or `$PINOUT_HOME`) is present and writable.
   - `env-vars`: Displays resolved `PINOUT_*` environment variables and fallback defaults.
2. **`[DAEMON]`**:
   - `daemon-health`: Confirms `pinoutd` is reachable and healthy at the resolved daemon URL.
3. **`[SERIAL & BOARD DISCOVERY]`**:
   - `serial-ports`: Lists detected serial interfaces.
   - `board-match`: Matches USB VID/PID against known descriptors in `firmware/boards/`. Warns if the board is unidentified and reiterates that Pinout will not auto-flash.
4. **`[FIRMWARE IDENTITY]`**:
   - `firmware-identity`: Executes a bounded `sys.hello` handshake. Validates protocol version and checks for advertised watchdog/arming features.
5. **`[CONFIGURATION & REGISTRY]`**:
   - `enrolled-devices`: Verifies enrolled devices in `~/.pinout/devices.json` and checks whether configured hardware ports are physically attached.
6. **`[SIMULATOR]`**:
   - `mock-handshake`: Verifies built-in software simulation readiness.

### Doctor Status Codes & Remedies

- **`PASS`**: Component is fully verified and ready.
- **`WARN`**: Action recommended (e.g. board unidentified, legacy firmware missing watchdog/arming, device port unplugged, or daemon not running on default loopback). Follow the printed **Next Step**.
- **`FAIL`**: Action required to proceed (e.g. Node version outdated, daemon auth rejected, firmware not responding, protocol version mismatch). Follow the printed remedy.
- **`SKIP`**: Step skipped (e.g. `--no-daemon` flag passed).

---

## Step 5: Enroll Device Identity

Capture the hardware identity and register the device with a stable name in `~/.pinout/devices.json`:

```bash
# Discover candidate ports:
npm run pinout -- discover

# Enroll detected hardware device:
npm run pinout -- enroll --id esp32-classic --port /dev/cu.usbserial-0001 --yes

# Or enroll the deterministic simulator:
npm run pinout -- enroll --id lab-esp --mock --yes
```

Inspect the registered device:

```bash
npm run pinout -- devices
npm run pinout -- device inspect esp32-classic
```

---

## Step 6: Verify with Non-Actuating Status Read

Verify communication with your enrolled device without changing pin states:

```bash
# Query device identity and advertised capabilities:
npm run pinout -- hello --port /dev/cu.usbserial-0001

# Inspect runtime health and operational state:
npm run pinout -- runtime inspect esp32-classic
```

---

## Step 7: Safe Physical Actuation

Pinout devices boot **disarmed** into an electrically safe state. Sustained actuation requires explicit session arming and an active watchdog heartbeat.

1. Read the input button status (GPIO 13):
   ```bash
   npm run pinout -- gpio read 13 --port /dev/cu.usbserial-0001
   ```
2. For higher-level module workflows, structured driver authoring, and the forthcoming reference Lamp module, see [`docs/cli.md`](cli.md) and [`docs/lamp.md`](lamp.md) *(forthcoming)*.

---

## Summary Checklist

- [ ] Node.js $\ge 20$ installed.
- [ ] Reference circuit wired and double-checked against pin restrictions.
- [ ] Firmware flashed manually via PlatformIO.
- [ ] `pinoutd` daemon started.
- [ ] `pinout doctor` returns `STATUS: READY` or `STATUS: READY (WITH WARNINGS)`.
- [ ] Device enrolled via `pinout enroll`.
- [ ] Read-only verification succeeded via `pinout hello`.
- [ ] Total setup duration recorded.
