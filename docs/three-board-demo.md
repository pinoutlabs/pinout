# Three-board LED demo

Pinout classifies each attached device as a **microcontroller**, with a board-specific pin map and a firmware-advertised set of capabilities. One laptop daemon owns USB connections. One static MCP adapter talks to that daemon. Changing boards does not change MCP configuration or its tool list.

```text
USB board running Pinout firmware
  → pinoutd --discover
  → sys.hello confirms boardId + supported capabilities
  → disarmed device registered with stable USB-derived ID
  → agent lists/describes devices through the same MCP connection
  → lease → configure safe output → arm → gpio.write → gpio.read → disarm
```

USB adapter IDs are candidates, not positive board identification. `--discover` explicitly enables opening candidate ports and polling; this can reset a board. Passive `pinout discover` still never opens ports. No command automatically flashes hardware. Unsupported/unflashed devices remain unregistered and produce diagnostics. Discovery retries failures after 15 seconds and polls connected boards every 2 seconds. Reconnect never restores an armed state. Boards without USB serial numbers use a path-derived ID; that ID can change when the port changes.

USB cannot determine what circuit is wired to a pin. Tell the agent which LED and pin you connected. “Analog pin 1” on the classic **Uno R3 / ATmega328P** means **A1 = GPIO 15**, which supports digital output. This target is not Uno R4, Nano, or Mega.

## Prepare firmware once

From the repository root, install dependencies and compile:

```bash
npm install
npm run build
python3 -m venv .venv
.venv/bin/pip install platformio
.venv/bin/pio run -d firmware/uno-bridge
.venv/bin/pio run -d firmware/esp32-bridge -e esp32dev -e esp32-c3-supermini
```

C3 compile here is manual/demo-only, not the CI default gate (CI compiles classic `esp32dev` only; C3 via release-candidate workflow).

Identify your physical board and serial port (`npm run pinout -- ports`). Close serial monitors before uploading or starting Pinout. Explicitly upload **only the matching target**, replacing `PORT`:

```bash
# Uno R3 / ATmega328P
.venv/bin/pio run -d firmware/uno-bridge -e uno -t upload --upload-port PORT
# Classic ESP32 DevKit / WROOM
.venv/bin/pio run -d firmware/esp32-bridge -e esp32dev -t upload --upload-port PORT
# ESP32-C3 SuperMini, native USB
.venv/bin/pio run -d firmware/esp32-bridge -e esp32-c3-supermini -t upload --upload-port PORT
```

For a C3 that will not upload, hold BOOT, tap RESET, release BOOT, and retry the explicitly selected upload. Reset afterward. “ESP32 Mini C3” is assumed to mean the common C3 SuperMini with native USB; confirm your actual board is that variant before flashing. Other mini boards can have different wiring.

## Wire the video circuit

Use a loose external LED and a 330 Ω series resistor, powered only from the board's USB connection:

| Board | LED anode via resistor | LED cathode | Logic |
| --- | --- | --- | --- |
| Uno R3 | A1 (GPIO 15) | GND | 5 V |
| ESP32 classic | GPIO 4 | GND | 3.3 V |
| ESP32-C3 SuperMini | GPIO 4 | GND | 3.3 V |

This is active-high wiring: `true` turns it on, `false` turns it off. For an active-low circuit, explicitly configure `safeLevel: "high"` and `polarity: "active-low"` before arming and invert the commands. The C3 onboard LED on GPIO 8 is intentionally unavailable: pins 2/8/9 are boot straps. Flash, USB, UART, and input-only restrictions are enforced by the board map and firmware. Do not move wiring while outputs are armed.

References: [Arduino Uno R3 documentation](https://docs.arduino.cc/hardware/uno-rev3/), [Arduino AVR Uno pin definitions](https://github.com/arduino/ArduinoCore-avr/blob/master/variants/standard/pins_arduino.h), [Espressif C3 schematic guidance](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/schematic-checklist.html).

## Start the runtime and configure MCP once

```bash
node packages/daemon/dist/main.js --discover
```

Leave it running; connect any of the three prepared boards. The console prints its device ID and disarmed status. Use a clean `PINOUT_HOME` for a separate demo registry if your normal registry already owns the same port. Existing configured ports are excluded from automatic discovery.

Add the following local **stdio MCP** server to an MCP client that can launch local processes; replace the absolute path once:

```json
{
  "mcpServers": {
    "pinout": {
      "command": "node",
      "args": ["/absolute/path/to/pinout/packages/mcp/dist/index.js"]
    }
  }
}
```

Start the daemon before the MCP client. Both automatically read the local daemon token from `~/.pinout/pinoutd.json` (or `PINOUT_HOME`). Do not copy the token into a video. For a custom `PINOUT_DAEMON_URL`, supply its `PINOUT_TOKEN` explicitly. A hosted chat client needs a supported connector/transport to your local MCP process; this stdio configuration is for a locally running MCP host, not a public remote connector.

The default catalog contains generic discovery/governance tools and **`pinout__invoke`**, regardless of which board is connected. `PINOUT_MCP_DYNAMIC_TOOLS=1` retains the old per-device catalog for compatibility. The embedded/demo adapters are development paths and retain their older dynamic tools.

## Agent prompt and exact calls

> Use Pinout to find my connected board. I connected an external active-high LED through a 330 ohm resistor to A1 on my Uno (or GPIO 4 on my ESP32/C3), with the cathode to GND. Describe the board and check the pin. Acquire control, configure its safe output, arm it, turn the LED on, and read the pin back. Report the acknowledgement/readback without claiming you saw it light up. Turn it off and disarm when I ask.

With `deviceId` from `pinout__list_devices`, the shared calls are:

```text
pinout__describe_device({deviceId})
pinout__acquire_lease({deviceId, ttlMs: 60000})
pinout__invoke({deviceId, capability:"gpio.configSafeState", args:{pin:15, safeLevel:"low", polarity:"active-high"}})
pinout__invoke({deviceId, capability:"sys.arm", args:{timeoutMs:1000}})
pinout__invoke({deviceId, capability:"gpio.write", args:{pin:15, value:true}})
pinout__invoke({deviceId, capability:"gpio.read", args:{pin:15}})
pinout__invoke({deviceId, capability:"gpio.write", args:{pin:15, value:false}})
pinout__invoke({deviceId, capability:"sys.disarm", args:{}})
pinout__release_lease({leaseId})
```

Use `pin:4` for either ESP32 fixture. For longer sessions renew control before the lease expires. The daemon maintains the firmware heartbeat while armed, even between model calls. Closing only the MCP client does not stop the separate daemon; explicitly disarm when finished. Daemon shutdown attempts disarm; daemon crash/link loss is handled by the device watchdog.

For a repeatable three-second on/off test through the real MCP subprocess:

```bash
npm run hardware:smoke -- --device DISCOVERED_ID --pin A1 --yes
# ESP32/C3:
npm run hardware:smoke -- --device DISCOVERED_ID --pin 4 --yes
```

The smoke test is for the active-high external LED above. It checks protocol readback, cleans up arming/lease state, and prints receipts with physical observation explicitly pending.

## Acceptance and evidence

Software checks include `npm test`, build, test typecheck, lint, docs check, all three firmware compilations, and `npm run test:firmware:uno` after the Uno build. The latter executes the actual Uno source with simulated GPIO/time. Uno intentionally does not advertise PWM, I2C, SPI, servo, or motor support; it rejects those capabilities. Its RX frame limit is 255 bytes plus newline, and its watchdog cannot be disabled (250–10000 ms).

For **each physical board tomorrow**, record the board label, firmware build, USB path, discovered ID, and:

1. Cold boot identifies the correct board and starts disarmed.
2. Before arming, a write is refused.
3. LED visibly turns on, stays on across model thinking time, and turns off; record GPIO readback separately.
4. Reserved/invalid pin request is refused and leaves the LED unchanged.
5. Kill the daemon while the LED is on; verify it goes off after the configured watchdog interval. Measure timing if claiming a bound.
6. Restart/replug: the board is disarmed and does not relight automatically. Repeat using the same MCP configuration.
7. Repeat with active-low wiring if claiming active-low physical validation.

Physical results are **pending** until observed. Neither a firmware build nor GPIO readback proves the LED illuminated. See the dated [software preparation record](../hardware/records/2026-09-08-three-board-preparation.md).
