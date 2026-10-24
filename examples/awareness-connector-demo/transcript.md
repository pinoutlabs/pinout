# Awareness → connector MCP agent transcript

> **SIMULATED** — scripted agent loop via real `createDaemonMcpServer` (PR2) against mock-devices + generateConnector fixtures. Pinout has never run on real hardware in this repository.

Generated: 2026-10-24T20:42:34.358Z

[system] MCP awareness/connector tools: pinout__nearby_devices, pinout__awareness_events, pinout__describe_nearby, pinout__request_enroll, pinout__generate_connector, pinout__connector_status, pinout__list_connectors

[agent] What devices are nearby?
[tool] pinout__nearby_devices
```json
{
  "devices": [
    {
      "id": "mock-serial-esp32-known",
      "transport": "serial",
      "identity": {
        "endpoint": "/dev/cu.mock-esp32-demo",
        "guessedModuleId": "pinout/esp32",
        "vendor": "Espressif",
        "deviceClass": "microcontroller",
        "vid": "303a",
        "pid": "1001",
        "advertisedName": "pinout-esp32-bridge",
        "firmware": "esp32-bridge",
        "version": "0.0.1-alpha.1"
      },
      "state": "PENDING_ENROLL",
      "firstSeen": 1792874554332,
      "lastSeen": 1792874554332,
      "health": {
        "status": "CONNECTED",
        "lifecycle": "ready",
        "lastUpdated": 1792874554332
      },
      "evidenceLevel": "SIMULATED",
      "confidence": 0.5,
      "connector": {
        "status": "none",
        "guidance": "No awareness connector yet — generate/approve via connector tools; physical-output stays human-gated."
      },
      "mock": true,
      "moduleId": "pinout/esp32",
      "honesty": "evidenceLevel=SIMULATED — do not claim physical hardware effect."
    },
    {
      "id": "mock-ble-unknown-lamp",
      "transport": "ble",
      "identity": {
        "endpoint": "aa:bb:cc:dd:ee:01",
        "guessedModuleId": "unknown/ble-lamp",
        "advertisedName": "DeskLamp-GATT-Unknown",
        "uuids": [
          "0000fff0-0000-1000-8000-00805f9b34fb",
          "0000fff1-0000-1000-8000-00805f9b34fb"
        ],
        "macHash": "077a24919e64dcdb"
      },
      "state": "IDENTIFIED",
      "firstSeen": 1792874554333,
      "lastSeen": 1792874554333,
      "health": {
        "status": "CONNECTED",
        "lifecycle": "ready",
        "lastUpdated": 1792874554333
      },
      "evidenceLevel": "SIMULATED",
      "confidence": 0.25,
      "connector": {
        "status": "none",
        "guidance": "No awareness connector yet — generate/approve via connector tools; physical-output stays human-gated."
      },
      "mock": true,
      "honesty": "evidenceLevel=SIMULATED — do not claim physical hardware effect."
    },
    {
      "id": "mock-mqtt-room-sensor",
      "transport": "mqtt",
      "identity": {
        "endpoint": "mqtt://127.0.0.1/tele/sim-room/SENSOR",
        "guessedModuleId": "unknown/mqtt-sensor",
        "advertisedName": "sim-room-sensor"
      },
      "state": "IDENTIFIED",
      "firstSeen": 1792874554334,
      "lastSeen": 1792874554334,
      "health": {
        "status": "CONNECTED",
        "lifecycle": "ready",
        "lastUpdated": 1792874554334
      },
      "evidenceLevel": "SIMULATED",
      "confidence": 0.25,
      "connector": {
        "status": "none",
        "guidance": "No awareness connector yet — generate/approve via connector tools; physical-output stays human-gated."
      },
      "mock": true,
      "honesty": "evidenceLevel=SIMULATED — do not claim physical hardware effect."
    }
  ],
  "count": 3,
  "honesty": "evidenceLevel is SupportLevel (SIMULATED unless COMPILE_TESTED/HARDWARE_VERIFIED). Never claim hardware from SIMULATED/UNKNOWN."
}
```

[agent] Describe the unknown BLE lamp (mock-ble-unknown-lamp).
[tool] pinout__describe_nearby
```json
{
  "id": "mock-ble-unknown-lamp",
  "transport": "ble",
  "identity": {
    "endpoint": "aa:bb:cc:dd:ee:01",
    "guessedModuleId": "unknown/ble-lamp",
    "advertisedName": "DeskLamp-GATT-Unknown",
    "uuids": [
      "0000fff0-0000-1000-8000-00805f9b34fb",
      "0000fff1-0000-1000-8000-00805f9b34fb"
    ],
    "macHash": "077a24919e64dcdb"
  },
  "state": "IDENTIFIED",
  "firstSeen": 1792874554333,
  "lastSeen": 1792874554333,
  "health": {
    "status": "CONNECTED",
    "lifecycle": "ready",
    "lastUpdated": 1792874554333
  },
  "evidenceLevel": "SIMULATED",
  "confidence": 0.25,
  "connector": {
    "status": "none",
    "guidance": "No awareness connector yet — generate/approve via connector tools; physical-output stays human-gated."
  },
  "mock": true,
  "honesty": "evidenceLevel=SIMULATED — do not claim physical hardware effect."
}
```

[agent] Check connector status for conn-mock-ble-unknown-lamp.
[tool] pinout__connector_status
```json
{
  "id": "conn-mock-ble-unknown-lamp",
  "awarenessId": "mock-ble-unknown-lamp",
  "status": "INSTALLED",
  "evidenceLevel": "SIMULATED",
  "mode": "installed",
  "capabilities": [
    {
      "id": "ble.gatt.00001800.00002a00.read",
      "physicalOutput": false,
      "requiresApproval": false
    },
    {
      "id": "ble.gatt.0000ff10.0000ff11.write",
      "physicalOutput": true,
      "requiresApproval": true,
      "args": {
        "value": {
          "type": "string",
          "required": true
        }
      }
    },
    {
      "id": "ble.gatt.0000ff10.0000ff12.write",
      "physicalOutput": true,
      "requiresApproval": true,
      "args": {
        "value": {
          "type": "string",
          "required": true
        }
      }
    },
    {
      "id": "ble.gatt.0000ff10.0000ff13.notify",
      "physicalOutput": true,
      "requiresApproval": true,
      "args": {
        "value": {
          "type": "number",
          "required": true
        }
      }
    }
  ],
  "approvedCapabilities": [
    "ble.gatt.00001800.00002a00.read",
    "ble.gatt.0000ff10.0000ff12.write",
    "ble.gatt.0000ff10.0000ff13.notify"
  ],
  "ranges": {
    "ble.gatt.0000ff10.0000ff13.notify": {
      "value": {
        "min": 0,
        "max": 80
      }
    }
  },
  "armed": false,
  "generated": true,
  "source": "gatt",
  "moduleId": "ble-lamp-proto/connector",
  "pendingApprovals": [
    "ble.gatt.0000ff10.0000ff11.write",
    "ble.gatt.0000ff10.0000ff12.write",
    "ble.gatt.0000ff10.0000ff13.notify"
  ],
  "report": {
    "quarantine": true,
    "conformanceGate": "passed",
    "neverInstalls": true,
    "neverRegisters": true,
    "notes": [
      "Generated via @pinout/generator generateConnector (source=gatt).",
      "Fixture: fixtures/generator/ble-gatt-lamp/gatt-dump.json",
      "Evidence SIMULATED (capped ≤ COMPILE_TESTED; never HARDWARE_VERIFIED here).",
      "Physical-output capabilities blocked until HUMAN APPROVES ranges.",
      "Install/register deferred to PR4 daemon routes — this stub only simulates lifecycle.",
      "Nothing was auto-armed."
    ]
  },
  "honesty": "evidenceLevel=SIMULATED — do not claim physical hardware effect.",
  "guidance": "INSTALLED: capabilities follow normal lease/arm/safety rules. Always surface evidenceLevel (SupportLevel) honestly; SIMULATED/UNKNOWN are not hardware.",
  "humanApprovalRequiredForPhysicalOutput": false
}
```

[agent] List all connectors.
[tool] pinout__list_connectors
```json
{
  "connectors": [
    {
      "id": "conn-mock-ble-unknown-lamp",
      "awarenessId": "mock-ble-unknown-lamp",
      "status": "INSTALLED",
      "evidenceLevel": "SIMULATED",
      "mode": "installed",
      "capabilities": [
        {
          "id": "ble.gatt.00001800.00002a00.read",
          "physicalOutput": false,
          "requiresApproval": false
        },
        {
          "id": "ble.gatt.0000ff10.0000ff11.write",
          "physicalOutput": true,
          "requiresApproval": true,
          "args": {
            "value": {
              "type": "string",
              "required": true
            }
          }
        },
        {
          "id": "ble.gatt.0000ff10.0000ff12.write",
          "physicalOutput": true,
          "requiresApproval": true,
          "args": {
            "value": {
              "type": "string",
              "required": true
            }
          }
        },
        {
          "id": "ble.gatt.0000ff10.0000ff13.notify",
          "physicalOutput": true,
          "requiresApproval": true,
          "args": {
            "value": {
              "type": "number",
              "required": true
            }
          }
        }
      ],
      "approvedCapabilities": [
        "ble.gatt.00001800.00002a00.read",
        "ble.gatt.0000ff10.0000ff12.write",
        "ble.gatt.0000ff10.0000ff13.notify"
      ],
      "ranges": {
        "ble.gatt.0000ff10.0000ff13.notify": {
          "value": {
            "min": 0,
            "max": 80
          }
        }
      },
      "armed": false,
      "generated": true,
      "source": "gatt",
      "moduleId": "ble-lamp-proto/connector",
      "pendingApprovals": [
        "ble.gatt.0000ff10.0000ff11.write",
        "ble.gatt.0000ff10.0000ff12.write",
        "ble.gatt.0000ff10.0000ff13.notify"
      ],
      "report": {
        "quarantine": true,
        "conformanceGate": "passed",
        "neverInstalls": true,
        "neverRegisters": true,
        "notes": [
          "Generated via @pinout/generator generateConnector (source=gatt).",
          "Fixture: fixtures/generator/ble-gatt-lamp/gatt-dump.json",
          "Evidence SIMULATED (capped ≤ COMPILE_TESTED; never HARDWARE_VERIFIED here).",
          "Physical-output capabilities blocked until HUMAN APPROVES ranges.",
          "Install/register deferred to PR4 daemon routes — this stub only simulates lifecycle.",
          "Nothing was auto-armed."
        ]
      },
      "honesty": "evidenceLevel=SIMULATED — do not claim physical hardware effect.",
      "guidance": "INSTALLED: capabilities follow normal lease/arm/safety rules. Always surface evidenceLevel (SupportLevel) honestly; SIMULATED/UNKNOWN are not hardware.",
      "humanApprovalRequiredForPhysicalOutput": false
    }
  ],
  "count": 1,
  "honesty": "Read-only capabilities of a QUARANTINED connector are usable; physical-output capabilities are not until a human approves. Always surface evidenceLevel honestly — SIMULATED unless a hardware record says otherwise; never claim hardware."
}
```

[human] Reminder: physical-output ranges require an explicit HUMAN APPROVES step outside the agent. Agents must not invent approved ranges.

---

## Honesty

- Awareness from real pinoutd `--mock-devices` (PR1).
- MCP tools from real `createDaemonMcpServer` (PR2).
- Connectors from `@pinout/generator` `generateConnector` + fixtures (PR3).
- Approve/install HTTP still facade-stubbed until PR4.
- Evidence level for generated connectors ≤ `COMPILE_TESTED`.
- Nothing auto-armed.
