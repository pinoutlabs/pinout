#!/usr/bin/env node
/**
 * Host-side Raspberry Pi Pico profile validation (no hardware required).
 *
 * Copies main.py + the Pico config into a temp directory and puts sim/ on
 * PYTHONPATH so the bridge runs with HARDWARE=True and Pico pin policy.
 * Asserts:
 *   - ready event advertises boardId raspberry-pi-pico and ledPin 25
 *   - onboard LED blink path (gpio.write / toggle on pin 25)
 *   - reserved pins 23/24/29 → INVALID_PIN
 *   - out-of-map pins → INVALID_PIN
 *   - ADC on GP26 returns a shaped result under the simulator
 *   - I2C write/read and SPI transfer sensor-ready hooks under the simulator
 *   - unknown actions → UNSUPPORTED_ACTION
 *
 * Evidence: SIMULATED only. Not HARDWARE_VERIFIED.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDir = fileURLToPath(new URL('.', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const pathSep = process.platform === 'win32' ? ';' : ':';

function pythonAvailable() {
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function request(id, action, payload = {}) {
  return JSON.stringify({ v: 1, id, action, payload });
}

const expectations = [
  {
    action: 'sys.hello',
    assert(_response, result) {
      if (result.firmware !== 'micropython-bridge') throw new Error('firmware mismatch');
      if (result.boardId !== 'raspberry-pi-pico') throw new Error('boardId must be raspberry-pi-pico');
      if (result.ledPin !== 25) throw new Error('ledPin must be 25 for non-W Pico');
      if (result.hardware !== true) throw new Error('sim machine should set hardware=true');
      if (result.protocol !== 1) throw new Error('protocol must be 1');
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 25, value: 1 },
    assert(_response, result) {
      if (result.pin !== 25 || result.value !== 1) throw new Error('LED on write failed');
    },
  },
  {
    action: 'gpio.toggle',
    payload: { pin: 25 },
    assert(_response, result) {
      if (result.value !== 0) throw new Error('LED toggle should clear');
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 25, value: 1 },
    assert(_response, result) {
      if (result.value !== 1) throw new Error('LED blink high failed');
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 23, value: 1 },
    assert(response) {
      if (response.ok !== false || response.error.code !== 'INVALID_PIN') {
        throw new Error('reserved pin 23 must be INVALID_PIN');
      }
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 24, value: 0 },
    assert(response) {
      if (response.ok !== false || response.error.code !== 'INVALID_PIN') {
        throw new Error('reserved pin 24 must be INVALID_PIN');
      }
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 29, value: 0 },
    assert(response) {
      if (response.ok !== false || response.error.code !== 'INVALID_PIN') {
        throw new Error('reserved pin 29 must be INVALID_PIN');
      }
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 99, value: 0 },
    assert(response) {
      if (response.ok !== false || response.error.code !== 'INVALID_PIN') {
        throw new Error('out-of-map pin must be INVALID_PIN on Pico profile');
      }
    },
  },
  {
    action: 'gpio.mode',
    payload: { pin: 2, mode: 'input-pullup' },
    assert(_response, result) {
      if (result.mode !== 'input-pullup') throw new Error('gpio.mode echo mismatch');
    },
  },
  {
    action: 'adc.read',
    payload: { pin: 26 },
    assert(_response, result) {
      if (result.pin !== 26) throw new Error('adc pin mismatch');
      if (typeof result.raw !== 'number' || typeof result.scale !== 'number') {
        throw new Error('adc result needs raw and scale');
      }
    },
  },
  {
    action: 'adc.read',
    payload: { pin: 2 },
    assert(response) {
      if (response.ok !== false || response.error.code !== 'INVALID_PIN') {
        throw new Error('non-ADC pin must be INVALID_PIN');
      }
    },
  },
  {
    action: 'pwm.configure',
    payload: { pin: 15, frequency: 1000 },
    assert(_response, result) {
      if (result.pin !== 15 || result.frequency !== 1000) throw new Error('pwm.configure mismatch');
    },
  },
  {
    action: 'pwm.write',
    payload: { pin: 15, duty: 32768 },
    assert(_response, result) {
      if (result.duty !== 32768) throw new Error('pwm.write duty mismatch');
    },
  },
  {
    action: 'i2c.write',
    payload: { address: 0x48, data: [1, 2, 3] },
    assert(_response, result) {
      if (result.written !== 3) throw new Error('i2c.write length mismatch');
    },
  },
  {
    action: 'i2c.read',
    payload: { address: 0x48, length: 3 },
    assert(_response, result) {
      if (!Array.isArray(result.data) || result.data.length !== 3) {
        throw new Error('i2c.read data shape mismatch');
      }
    },
  },
  {
    action: 'i2c.scan',
    payload: {},
    assert(_response, result) {
      if (!Array.isArray(result.addresses)) throw new Error('i2c.scan addresses missing');
    },
  },
  {
    action: 'spi.transfer',
    payload: { data: [0xaa, 0x55] },
    assert(_response, result) {
      if (!Array.isArray(result.data) || result.data.length !== 2) {
        throw new Error('spi.transfer data shape mismatch');
      }
    },
  },
  {
    action: 'vendor.custom',
    payload: {},
    assert(response) {
      if (response.error?.code !== 'UNSUPPORTED_ACTION') {
        throw new Error('expected UNSUPPORTED_ACTION');
      }
    },
  },
];

function main() {
  if (!pythonAvailable()) {
    console.log('SKIP: python3 unavailable; Pico bridge profile not validated');
    process.exit(0);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'pinout-pico-sim-'));
  try {
    copyFileSync(join(bridgeDir, 'main.py'), join(workDir, 'main.py'));
    copyFileSync(
      join(bridgeDir, 'boards', 'raspberry-pi-pico', 'config.py'),
      join(workDir, 'config.py'),
    );

    const input =
      expectations
        .map((item, index) => request(String(index + 1), item.action, item.payload || {}))
        .join('\n') + '\n';

    const run = spawnSync(python, ['-u', 'main.py'], {
      input,
      encoding: 'utf8',
      cwd: workDir,
      env: {
        ...process.env,
        PYTHONPATH: [join(bridgeDir, 'sim'), workDir].join(pathSep),
      },
      timeout: 20000,
    });

    if (run.error) {
      console.error(`FAIL: could not spawn python: ${run.error.message}`);
      process.exit(1);
    }
    if (run.status !== 0) {
      console.error(`FAIL: bridge exited with ${run.status}\n${run.stderr}`);
      process.exit(1);
    }

    const messages = run.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

    const ready = messages.find((message) => message.event === 'ready');
    if (!ready || ready.payload?.boardId !== 'raspberry-pi-pico') {
      console.error('FAIL: ready event missing boardId raspberry-pi-pico\n' + run.stdout);
      process.exit(1);
    }
    if (ready.payload?.ledPin !== 25) {
      console.error('FAIL: ready event ledPin must be 25\n' + run.stdout);
      process.exit(1);
    }

    const responses = messages.filter((message) => message.id !== undefined);
    if (responses.length !== expectations.length) {
      console.error(
        `FAIL: expected ${expectations.length} responses, got ${responses.length}\n${run.stdout}`,
      );
      process.exit(1);
    }

    let failures = 0;
    expectations.forEach((item, index) => {
      const response = responses[index];
      const label = `${item.action} (#${index + 1})`;
      try {
        if (response.v !== 1) throw new Error('missing v=1');
        if (response.id !== String(index + 1)) throw new Error(`id mismatch: ${response.id}`);
        item.assert(response, response.ok ? response.result : undefined);
        console.log(`  ok  ${label}`);
      } catch (error) {
        failures += 1;
        console.error(`  FAIL ${label}: ${error.message}`);
      }
    });

    if (failures > 0) {
      console.error(`${failures}/${expectations.length} Pico profile checks failed`);
      process.exit(1);
    }
    console.log(
      `PASS: ${expectations.length}/${expectations.length} Pico profile checks (SIMULATED; not HARDWARE_VERIFIED)`,
    );
    process.exit(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
