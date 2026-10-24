# Awareness → connector MCP agent transcript

> **SIMULATED** — scripted agent loop via real `createDaemonMcpServer` (PR2) against mock-devices, generateConnector fixtures, and real `/v1/connectors*` (PR4). Pinout has never run on real hardware in this repository.

Generated: 2026-10-24T20:58:21.786Z

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
      "firstSeen": 1792875498681,
      "lastSeen": 1792875498681,
      "health": {
        "status": "CONNECTED",
        "lifecycle": "ready",
        "lastUpdated": 1792875498681
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
      "firstSeen": 1792875498683,
      "lastSeen": 1792875498683,
      "health": {
        "status": "CONNECTED",
        "lifecycle": "ready",
        "lastUpdated": 1792875498683
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
      "firstSeen": 1792875498683,
      "lastSeen": 1792875498683,
      "health": {
        "status": "CONNECTED",
        "lifecycle": "ready",
        "lastUpdated": 1792875498683
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
  "firstSeen": 1792875498683,
  "lastSeen": 1792875498683,
  "health": {
    "status": "CONNECTED",
    "lifecycle": "ready",
    "lastUpdated": 1792875498683
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

[agent] Check connector status for 1736bd73-4deb-4299-8709-f8143a7e67c2.
[tool] pinout__connector_status
```json
{
  "id": "1736bd73-4deb-4299-8709-f8143a7e67c2",
  "moduleId": "ble-lamp-proto/connector",
  "version": "0.1.0",
  "status": "INSTALLED",
  "evidenceLevel": "COMPILE_TESTED",
  "capabilities": [
    {
      "name": "ble.gatt.00001800.00002a00.read",
      "physicalOutput": false,
      "enabled": true,
      "description": "Device Name",
      "reversible": true,
      "safety": {
        "physicalOutput": false,
        "reversible": true
      }
    },
    {
      "name": "ble.gatt.0000ff10.0000ff11.write",
      "physicalOutput": true,
      "enabled": false,
      "description": "Power / on-off",
      "reversible": true,
      "safety": {
        "physicalOutput": true,
        "reversible": true
      }
    },
    {
      "name": "ble.gatt.0000ff10.0000ff12.write",
      "physicalOutput": true,
      "enabled": false,
      "description": "Brightness",
      "reversible": true,
      "safety": {
        "physicalOutput": true,
        "reversible": true
      }
    },
    {
      "name": "ble.gatt.0000ff10.0000ff13.notify",
      "physicalOutput": true,
      "enabled": true,
      "description": "Fault notifications",
      "reversible": true,
      "safety": {
        "physicalOutput": true,
        "reversible": true
      }
    }
  ],
  "safety": {
    "physicalOutputsDisabled": false,
    "requiresHumanApproval": true,
    "autoInstallForbidden": true,
    "autoFlashForbidden": true,
    "autoActuateForbidden": true
  },
  "safetyFlags": {
    "physicalOutputBlockedUntilHumanApproval": false,
    "requiresHumanApproval": true,
    "autoInstallForbidden": true,
    "autoFlashForbidden": true,
    "autoActuateForbidden": true
  },
  "report": {
    "passed": true,
    "checks": [
      {
        "name": "manifest",
        "passed": true
      },
      {
        "name": "manifest",
        "passed": true,
        "detail": "pinout.module.json missing"
      },
      {
        "name": "compatibility",
        "passed": true
      },
      {
        "name": "module id",
        "passed": true,
        "detail": "ble-lamp-proto/connector"
      },
      {
        "name": "entrypoint",
        "passed": true
      },
      {
        "name": "manifest capability parity",
        "passed": true,
        "detail": "manifest and module capability declarations must match"
      },
      {
        "name": "simulation declaration",
        "passed": true
      },
      {
        "name": "4 capabilities",
        "passed": true
      },
      {
        "name": "schemas",
        "passed": true
      },
      {
        "name": "policy references",
        "passed": true
      },
      {
        "name": "backend flag parity",
        "passed": true,
        "detail": "backend factories must honor simulated=false"
      },
      {
        "name": "backend lifecycle",
        "passed": true
      },
      {
        "name": "simulator parity",
        "passed": true
      },
      {
        "name": "unknown action rejection",
        "passed": true
      },
      {
        "name": "backend close",
        "passed": true
      },
      {
        "name": "integrity",
        "passed": true,
        "detail": "UNSIGNED"
      }
    ],
    "reasons": [],
    "generator": {
      "generator": "generateConnector",
      "moduleId": "ble-lamp-proto/connector",
      "evidenceLevel": "COMPILE_TESTED",
      "pendingApprovals": [
        "ble.gatt.0000ff10.0000ff11.write",
        "ble.gatt.0000ff10.0000ff12.write",
        "ble.gatt.0000ff10.0000ff13.notify"
      ],
      "neverInstalls": true,
      "neverRegisters": true,
      "uncertainties": [],
      "transportKinds": [
        "simulated",
        "ble-gatt"
      ],
      "provenance": {
        "pinoutVersion": "0.0.1-alpha.1",
        "generatorVersion": "0.2.0",
        "provider": "template",
        "model": "deterministic-v1",
        "timestamp": "2026-10-24T20:58:18.711Z",
        "sourceHashes": {
          "raw": "e22382ad32aaf0e0e85ed3ec494937940d1efd4da4952f3f7463158d59a7ec06"
        },
        "status": "CONFORMANCE_PASSED"
      }
    },
    "level": "L2",
    "integrityStatus": "UNSIGNED"
  },
  "contentHash": "d1fad07969ee69aff9dbafefbc39c2cb7dc24f7eddcbc5617e24a7547ae560ef",
  "manifestHash": "3563667100900e55a41ff659b1bd013902ba94f3c77adf2b016e033e38181cd5",
  "createdAt": "2026-10-24T20:58:21.713Z",
  "updatedAt": "2026-10-24T20:58:21.772Z",
  "installPath": "/tmp/pinout-awareness-demo-5tCzGV/modules/ble-lamp-proto--connector",
  "awarenessId": "mock-ble-unknown-lamp",
  "approval": {
    "approvedAt": "2026-10-24T20:58:21.724Z",
    "approvedBy": "demo-operator",
    "capabilities": [
      "ble.gatt.00001800.00002a00.read",
      "ble.gatt.0000ff10.0000ff13.notify"
    ],
    "ranges": {
      "ble.gatt.0000ff10.0000ff13.notify": {
        "value": {
          "min": 0,
          "max": 80
        }
      }
    }
  },
  "honesty": "evidenceLevel=COMPILE_TESTED — firmware/module compiled in CI; not a hardware claim.",
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
      "id": "1736bd73-4deb-4299-8709-f8143a7e67c2",
      "moduleId": "ble-lamp-proto/connector",
      "version": "0.1.0",
      "status": "INSTALLED",
      "evidenceLevel": "COMPILE_TESTED",
      "capabilities": [
        {
          "name": "ble.gatt.00001800.00002a00.read",
          "physicalOutput": false,
          "enabled": true,
          "description": "Device Name",
          "reversible": true,
          "safety": {
            "physicalOutput": false,
            "reversible": true
          }
        },
        {
          "name": "ble.gatt.0000ff10.0000ff11.write",
          "physicalOutput": true,
          "enabled": false,
          "description": "Power / on-off",
          "reversible": true,
          "safety": {
            "physicalOutput": true,
            "reversible": true
          }
        },
        {
          "name": "ble.gatt.0000ff10.0000ff12.write",
          "physicalOutput": true,
          "enabled": false,
          "description": "Brightness",
          "reversible": true,
          "safety": {
            "physicalOutput": true,
            "reversible": true
          }
        },
        {
          "name": "ble.gatt.0000ff10.0000ff13.notify",
          "physicalOutput": true,
          "enabled": true,
          "description": "Fault notifications",
          "reversible": true,
          "safety": {
            "physicalOutput": true,
            "reversible": true
          }
        }
      ],
      "safety": {
        "physicalOutputsDisabled": false,
        "requiresHumanApproval": true,
        "autoInstallForbidden": true,
        "autoFlashForbidden": true,
        "autoActuateForbidden": true
      },
      "safetyFlags": {
        "physicalOutputBlockedUntilHumanApproval": false,
        "requiresHumanApproval": true,
        "autoInstallForbidden": true,
        "autoFlashForbidden": true,
        "autoActuateForbidden": true
      },
      "report": {
        "passed": true,
        "checks": [
          {
            "name": "manifest",
            "passed": true
          },
          {
            "name": "manifest",
            "passed": true,
            "detail": "pinout.module.json missing"
          },
          {
            "name": "compatibility",
            "passed": true
          },
          {
            "name": "module id",
            "passed": true,
            "detail": "ble-lamp-proto/connector"
          },
          {
            "name": "entrypoint",
            "passed": true
          },
          {
            "name": "manifest capability parity",
            "passed": true,
            "detail": "manifest and module capability declarations must match"
          },
          {
            "name": "simulation declaration",
            "passed": true
          },
          {
            "name": "4 capabilities",
            "passed": true
          },
          {
            "name": "schemas",
            "passed": true
          },
          {
            "name": "policy references",
            "passed": true
          },
          {
            "name": "backend flag parity",
            "passed": true,
            "detail": "backend factories must honor simulated=false"
          },
          {
            "name": "backend lifecycle",
            "passed": true
          },
          {
            "name": "simulator parity",
            "passed": true
          },
          {
            "name": "unknown action rejection",
            "passed": true
          },
          {
            "name": "backend close",
            "passed": true
          },
          {
            "name": "integrity",
            "passed": true,
            "detail": "UNSIGNED"
          }
        ],
        "reasons": [],
        "generator": {
          "generator": "generateConnector",
          "moduleId": "ble-lamp-proto/connector",
          "evidenceLevel": "COMPILE_TESTED",
          "pendingApprovals": [
            "ble.gatt.0000ff10.0000ff11.write",
            "ble.gatt.0000ff10.0000ff12.write",
            "ble.gatt.0000ff10.0000ff13.notify"
          ],
          "neverInstalls": true,
          "neverRegisters": true,
          "uncertainties": [],
          "transportKinds": [
            "simulated",
            "ble-gatt"
          ],
          "provenance": {
            "pinoutVersion": "0.0.1-alpha.1",
            "generatorVersion": "0.2.0",
            "provider": "template",
            "model": "deterministic-v1",
            "timestamp": "2026-10-24T20:58:18.711Z",
            "sourceHashes": {
              "raw": "e22382ad32aaf0e0e85ed3ec494937940d1efd4da4952f3f7463158d59a7ec06"
            },
            "status": "CONFORMANCE_PASSED"
          }
        },
        "level": "L2",
        "integrityStatus": "UNSIGNED"
      },
      "contentHash": "d1fad07969ee69aff9dbafefbc39c2cb7dc24f7eddcbc5617e24a7547ae560ef",
      "manifestHash": "3563667100900e55a41ff659b1bd013902ba94f3c77adf2b016e033e38181cd5",
      "createdAt": "2026-10-24T20:58:21.713Z",
      "updatedAt": "2026-10-24T20:58:21.772Z",
      "installPath": "/tmp/pinout-awareness-demo-5tCzGV/modules/ble-lamp-proto--connector",
      "awarenessId": "mock-ble-unknown-lamp",
      "approval": {
        "approvedAt": "2026-10-24T20:58:21.724Z",
        "approvedBy": "demo-operator",
        "capabilities": [
          "ble.gatt.00001800.00002a00.read",
          "ble.gatt.0000ff10.0000ff13.notify"
        ],
        "ranges": {
          "ble.gatt.0000ff10.0000ff13.notify": {
            "value": {
              "min": 0,
              "max": 80
            }
          }
        }
      },
      "honesty": "evidenceLevel=COMPILE_TESTED — firmware/module compiled in CI; not a hardware claim.",
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
- Lifecycle via real pinoutd `/v1/connectors*` (PR4) — generate → quarantine → approve → install.
- Evidence level for generated connectors ≤ `COMPILE_TESTED`.
- Nothing auto-armed.
