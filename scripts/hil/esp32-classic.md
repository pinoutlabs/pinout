# ESP32 Classic Hardware-in-the-Loop (HIL) Procedure & Evidence Matrix

## Overview

This document specifies the step-by-step physical verification procedure and evidence collection template for the alpha reference ESP32 classic target (`firmware/boards/esp32-devkit-v1.json`) wired according to the reference circuit in `hardware/reference/esp32-classic-led-sensor.md`.

> **CRITICAL EXECUTION RULES:**
> 1. **Separation of Evidence:** Firmware acknowledgments and protocol responses must be recorded in a distinct column from independently observed physical instrument measurements. A firmware `{"ok": true}` is not proof of physical safe state.
> 2. **Never Auto-Flash:** Never invoke automated flashing tooling on an unconfirmed or unidentified serial target. Firmware upload must be an explicit, operator-supervised manual action.
> 3. **Active-Low Coverage:** The active-low test fixture (GPIO 4) must be explicitly exercised and verified to maintain a `HIGH` (3.3 V / OFF) electrical safe state upon disarm, watchdog expiry, host termination, or reconnect.

---

## 1. Test Harness & Equipment Requirements

- **Target Device:** ESP32-WROOM-32 DevKit V1 30-pin board with CP2102 or CH340 USB-UART bridge.
- **Reference Circuit:** Low-voltage breadboard fixture wired as specified in `hardware/reference/esp32-classic-led-sensor.md`:
  - Output 1 (Active-High): GPIO 2 $\rightarrow$ $330\,\Omega$ resistor $\rightarrow$ Red LED $\rightarrow$ GND (Safe level: `LOW`).
  - Output 2 (Active-Low): 3.3 V $\rightarrow$ $330\,\Omega$ resistor $\rightarrow$ Green LED $\rightarrow$ GPIO 4 (Safe level: `HIGH`).
  - Input Sensor: GPIO 13 $\rightarrow$ Tactile pushbutton $S_1$ $\rightarrow$ GND (Internal pull-up enabled).
- **Measurement Instruments:**
  - **Primary Timing Instrument:** 2-channel or 4-channel Digital Storage Oscilloscope (DSO) or USB Logic Analyzer (sample rate $\ge 1\text{ MS/s}$, timing resolution $\le 1\,\mu\text{s}$, minimum precision $\le 1\text{ ms}$).
    - Channel 1 probe: GPIO 2 (Active-High Output).
    - Channel 2 probe: GPIO 4 (Active-Low Output).
    - Channel 3 probe (optional): GPIO 13 (Sensor Input).
  - **Secondary / Backup Instrument:** Calibrated Digital Multimeter (DMM) for DC voltage verification, or a second timestamping microcontroller running synchronized GPIO capture firmware.
- **Host System:** Linux or macOS workstation running Node.js 20+, PlatformIO Core, and Pinout CLI.

---

## 2. Test Procedure

### Phase 1: Environment Baseline & Read-Only Discovery
1. Record host OS, kernel version, Node version, PlatformIO version, and git commit SHA.
2. Connect USB cable. Record USB VID:PID and assigned serial device node (`/dev/cu.*` or `/dev/ttyUSB*`).
3. Run `npm run pinout -- ports` and `pinout discover`. Confirm that discovery performs passive read-only enumeration without resetting or actuating the target.

### Phase 2: Manual Flash & Identity Handshake
1. Manually build and upload the alpha bridge firmware:
   ```bash
   cd firmware/esp32-bridge
   pio run -e esp32dev -t upload
   ```
2. Open serial monitor or run `pinout hello --port <PORT>`.
3. Capture the initial `ready` broadcast event and verify protocol fields: `firmware == "esp32-bridge"`, `protocol == 1`, `version == "0.0.1-alpha.1"`, and capability list.
4. Verify `resetOnConnect: false` behavior: connect without DTR/RTS pulsing and confirm the board does not reboot unexpectedly.

### Phase 3: Configuration, Arming & Output/Readback Verification
1. Configure outputs with explicit safe-state declarations using the watchdog/arming handshake described in `docs/protocol.md`:
   - GPIO 2: `mode: "output"`, `polarity: "active-high"`, `safeLevel: 0`.
   - GPIO 4: `mode: "output"`, `polarity: "active-low"`, `safeLevel: 1`.
   - GPIO 13: `mode: "pullup"`.
2. Confirm that prior to explicit arming, the device refuses actuation and physical outputs remain at their safe levels (LED1 off, LED2 off).
3. Issue an explicit arm command.
4. Drive GPIO 2 `HIGH` $\rightarrow$ verify protocol ACK and physically observe LED1 illuminated ($V \approx 2.0\text{ V}$ across LED, $3.3\text{ V}$ at GPIO 2). Read back GPIO 2 level.
5. Drive GPIO 2 `LOW` $\rightarrow$ verify protocol ACK and observe LED1 extinguished ($0\text{ V}$ at GPIO 2).
6. Drive GPIO 4 `LOW` $\rightarrow$ verify protocol ACK and observe LED2 illuminated ($0\text{ V}$ at GPIO 4). Read back GPIO 4 level.
7. Drive GPIO 4 `HIGH` $\rightarrow$ verify protocol ACK and observe LED2 extinguished ($3.3\text{ V}$ at GPIO 4).

### Phase 4: Sensor Event Observation
1. Register a watch on GPIO 13 (`gpio.watch`).
2. Depress tactile switch $S_1$. Verify that a `gpio.changed` event is emitted with `value: false` and observe oscilloscope falling edge.
3. Release tactile switch $S_1$. Verify that a `gpio.changed` event is emitted with `value: true` and observe oscilloscope rising edge.

### Phase 5: Invalid Pin & Safety Guard Rejection
1. Attempt `gpio.write` or `gpio.mode` on SPI Flash pins (GPIO 6, 7, 8, 9, 10, 11). Verify firmware returns `INVALID_PIN` error and MCU continues operating without crashing.
2. Attempt `gpio.write` on MTDI boot strap pin (GPIO 12). Verify firmware returns `INVALID_PIN` error.
3. Attempt `gpio.write` (output mode) on input-only pin (GPIO 34). Verify firmware returns `INVALID_PIN` error.

### Phase 6: Watchdog Expiry & Safe-State Trip
1. Set up oscilloscope trigger on falling edge of GPIO 2 and rising edge of GPIO 4.
2. Configure a negotiated watchdog interval of $T_{\text{watchdog}} = 500\text{ ms}$.
3. Arm device and set outputs to active state (GPIO 2 `HIGH`, GPIO 4 `LOW` — both LEDs on).
4. Intentionally cease host heartbeat transmissions.
5. Measure the elapsed time from the last valid heartbeat deadline until outputs transition to their declared safe states (GPIO 2 $\rightarrow 0\text{ V}$, GPIO 4 $\rightarrow 3.3\text{ V}$).
6. Verify that measured response time satisfies:
   $$T_{\text{watchdog}} \le T_{\text{trip}} \le T_{\text{watchdog}} + \Delta t_{\text{max}}$$
   where $\Delta t_{\text{max}} \le 50\text{ ms}$ jitter tolerance.

### Phase 7: Host Process Crash / Kill Test
1. Arm device and set outputs to active state (both LEDs on).
2. Issue an ungraceful host process kill (`kill -9 <PID>` of host Pinout process).
3. Record oscilloscope trace showing the elapsed time until device-local watchdog detects missing heartbeats and drives GPIO 2 `LOW` and GPIO 4 `HIGH`.
4. Confirm both LEDs physically turn OFF.

### Phase 8: USB Unplug & Reconnect Recovery Test
1. Arm device and actuate outputs.
2. Physically disconnect USB cable mid-operation.
3. Reconnect USB cable.
4. Inspect device boot state: confirm device boots in a **DISARMED** state with outputs at safe levels.
5. Verify that the device does **NOT** automatically resume actuation or re-energize outputs without a fresh handshake and explicit arming sequence.

### Phase 9: Awareness + automatic connector (real hardware) — **NOT RUN**
> Software demo (`npm run demo:awareness`) is **SIMULATED** only. Do **not** mark this phase verified until a dated `hardware/records/` entry exists. See also [`awareness-connectors.md`](./awareness-connectors.md).

1. Attach a **known** Pinout firmware board; confirm awareness `IDENTIFIED` with the expected `moduleId` (passive discovery / hello — no auto-flash, no auto-arm).
2. Attach or advertise an **unknown** BLE or MQTT endpoint with no matching module; confirm awareness `SEEN` / `UNKNOWN` evidence.
3. Generate a connector; confirm quarantine is **read-only** and evidence ≤ `COMPILE_TESTED`.
4. Attempt physical-output invoke **before** operator approval; confirm rejection (`SAFETY_APPROVAL_REQUIRED` or equivalent) and **no** GPIO/radio actuation.
5. Operator performs an explicit **HUMAN APPROVES** step with documented numeric ranges; install; confirm still **disarmed**.
6. Out-of-range invoke rejected; in-range invoke observed with independent instruments (not firmware ACK alone).
7. Record results under `hardware/records/` — until then catalog/evidence remain non-`HARDWARE_VERIFIED`.

---

## 3. Fill-in Evidence Matrix Template

*Copy this template when creating a dated record under `hardware/records/YYYY-MM-DD-esp32-classic-reference-circuit.md`.*

```markdown
# ESP32 Classic Reference Circuit Test Record: YYYY-MM-DD

- **Date:** YYYY-MM-DD HH:MM UTC
- **Operator:** <Name / GitHub Handle>
- **Host OS & Hardware:** <e.g., macOS Sonoma 14.6.1 / Apple M2 or Ubuntu 22.04 LTS x86_64>
- **Node.js Version:** <e.g., v20.17.0>
- **PlatformIO Core Version:** <e.g., 6.1.15>
- **Firmware Commit SHA:** <e.g., 64d69cc...>
- **Target Board:** ESP32-WROOM-32 DevKit V1 30-pin (ESP32-D0WD)
- **USB-UART Bridge:** <CP2102 (10c4:ea60) or CH340 (1a86:7523)>
- **Measurement Instruments:** <e.g., Rigol DS1054Z 50MHz Oscilloscope / Saleae Logic 8>

### Evidence Log

| Step # | Test Case / Stimulus | Firmware / Protocol ACK | Physical Observation / Instrument Measurement | Result (PASS / FAIL / PENDING) | Notes / Traces |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1.1** | Read-only discovery (`pinout ports`) | Enumerates port path | No voltage change on pins; no target reset | PENDING | |
| **2.1** | Manual Flash (`pio run -t upload`) | Flash tool logs 100% success | ROM boot log followed by stable 3.3 V rail | PENDING | |
| **2.2** | Handshake `sys.hello` | Returns `firmware: "esp32-bridge"`, `protocol: 1`, `version: "0.0.1-alpha.1"` | Red power LED on; blue LED off ($0\text{ V}$) | PENDING | |
| **3.1** | Declare safe state (GPIO 2 low, GPIO 4 high) | Config ACK received | DMM: GPIO 2 = 0.00 V, GPIO 4 = 3.29 V; LEDs off | PENDING | |
| **3.2** | Actuation before arming | Returns `NOT_ARMED` error | DMM: GPIO 2 = 0.00 V, GPIO 4 = 3.29 V; no actuation | PENDING | |
| **3.3** | Explicit Arm command | Returns `ARMED` status | Outputs remain at safe levels until commanded | PENDING | |
| **3.4** | GPIO 2 Write HIGH (Active-High) | `{"pin": 2, "value": true}` | Scope Ch1: 3.30 V step; LED1 (Red) illuminates | PENDING | |
| **3.5** | GPIO 2 Write LOW | `{"pin": 2, "value": false}` | Scope Ch1: 0.00 V; LED1 extinguishes | PENDING | |
| **3.6** | GPIO 4 Write LOW (Active-Low) | `{"pin": 4, "value": false}` | Scope Ch2: 0.00 V; LED2 (Green) illuminates | PENDING | |
| **3.7** | GPIO 4 Write HIGH | `{"pin": 4, "value": true}` | Scope Ch2: 3.30 V; LED2 extinguishes | PENDING | |
| **4.1** | GPIO 13 Button Press | Emits `gpio.changed` `{"pin": 13, "value": false}` | Scope Ch3: Falling edge to 0 V on switch closure | PENDING | |
| **4.2** | GPIO 13 Button Release | Emits `gpio.changed` `{"pin": 13, "value": true}` | Scope Ch3: Rising edge to 3.3 V on switch release | PENDING | |
| **5.1** | Invalid Pin: SPI Flash (GPIO 6–11) | Returns `INVALID_PIN` | MCU execution uninterrupted; 3.3V rail stable | PENDING | |
| **5.2** | Invalid Pin: Boot Strap (GPIO 12) | Returns `INVALID_PIN` | Output not driven | PENDING | |
| **5.3** | Invalid Pin: Input-Only Output (GPIO 34) | Returns `INVALID_PIN` | Output not driven | PENDING | |
| **6.1** | Watchdog Expiry (Heartbeat ceased) | Host observes socket timeout | Scope: GPIO 2 drops to 0 V; GPIO 4 rises to 3.3 V | PENDING | Measured latency: __ ms |
| **7.1** | Host Process Kill (`kill -9`) | Process terminated | Scope: GPIO 2 drops to 0 V; GPIO 4 rises to 3.3 V | PENDING | Measured latency: __ ms |
| **8.1** | USB Unplug mid-operation | Link severed | 3.3 V rail de-energized; all LEDs off | PENDING | |
| **8.2** | USB Reconnect | `ready` event emitted; status is disarmed | LEDs remain unlit; device does not resume | PENDING | |

### Raw Protocol & Instrument Excerpts

#### Handshake Raw JSON
```json
// Paste raw JSON response here
```

#### Oscilloscope / Logic Analyzer Timing Capture
```text
// Paste timing measurements, channel assignments, and delta markers here
```

#### Protocol Journal Log Excerpt
```text
// Paste daemon / CLI journal lines here
```
```
