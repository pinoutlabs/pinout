#!/usr/bin/env node
/**
 * Host-side validation matrix for the MicroPython bridge.
 *
 * Three dependency-free runs (node builtins + python3 stdlib only):
 *   1. software mode, shipped config: wire shape, error taxonomy, PWM/servo
 *      software shadow, deterministic sys.info, malformed-input handling.
 *   2. software mode, temp config with RESERVED_PINS={13} and MAX_WATCHES=3:
 *      reserved-pin rejection and the watch-table limit.
 *   3. fake-`machine` "hardware" mode: a stub machine.py in a temp dir logs
 *      every peripheral call to JSONL, so GPIO/PWM/servo/ADC/I2C/SPI code
 *      paths and BUS_ERROR mapping can be asserted without a board.
 *
 * Exits 0 on success, 1 on mismatch, prints SKIP (exit 0) when python3 is
 * unavailable. None of this is hardware verification: real-board behavior is
 * still unverified.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDir = fileURLToPath(new URL('.', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const RESPONSE_TIMEOUT_MS = 20000;

function pythonAvailable() {
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function request(id, action, payload = {}) {
  return JSON.stringify({ v: 1, id, action, payload });
}

function toLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
}

function assertEq(actual, expected, what) {
  if (actual !== expected) {
    const got = JSON.stringify(actual);
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${got}`);
  }
}

function assertCode(response, code) {
  if (response.ok !== false) throw new Error(`expected failure ${code}, got success`);
  assertEq(response.error.code, code, 'error.code');
}

function includesAll(actual, expected, what) {
  for (const entry of expected) {
    if (!Array.isArray(actual) || !actual.includes(entry)) {
      throw new Error(`${what}: missing ${entry}`);
    }
  }
}

function excludesAll(actual, unexpected, what) {
  for (const entry of unexpected) {
    if (Array.isArray(actual) && actual.includes(entry)) {
      throw new Error(`${what}: ${entry} must not be advertised here`);
    }
  }
}

function expectsResponse(entry) {
  return entry.raw === undefined || entry.expectResponse === true;
}

function buildInput(entries) {
  const lines = entries.map((entry) => {
    if (entry.raw !== undefined) return entry.raw;
    return request(entry.id, entry.action, entry.payload ?? {});
  });
  return `${lines.join('\n')}\n`;
}

let failures = 0;

function checkRun(runName, cwd, entries, env = {}, after) {
  const run = spawnSync(python, ['-u', 'main.py'], {
    input: buildInput(entries),
    encoding: 'utf8',
    cwd,
    timeout: RESPONSE_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });

  if (run.error) {
    failures += 1;
    console.error(`FAIL ${runName}: could not spawn python: ${run.error.message}`);
    return;
  }
  if (run.status !== 0) {
    failures += 1;
    console.error(`FAIL ${runName}: bridge exited with ${run.status}`);
    console.error(run.stderr);
    return;
  }

  const responses = toLines(run.stdout).map((line) => JSON.parse(line));
  const expectedCount = entries.filter(expectsResponse).length;
  if (responses.length !== expectedCount) {
    failures += 1;
    console.error(`FAIL ${runName}: expected ${expectedCount} responses, got ${responses.length}`);
    console.error(run.stdout);
    return;
  }

  let cursor = 0;
  entries.forEach((entry, index) => {
    if (!expectsResponse(entry)) return;
    const response = responses[cursor++];
    const fallback = `${entry.action ?? 'raw'} (#${index + 1})`;
    const label = `${runName} ${entry.label ?? fallback}`;
    try {
      assertEq(response.v, 1, 'v');
      if (entry.raw === undefined) {
        assertEq(response.id, String(entry.id), 'id');
      }
      if (response.ok !== true && response.ok !== false) throw new Error('ok must be boolean');
      if (response.ok === true && typeof response.result !== 'object') {
        throw new Error('success needs a result object');
      }
      if (response.ok === false) {
        const code = response.error?.code;
        const message = response.error?.message;
        if (typeof code !== 'string' || typeof message !== 'string') {
          throw new Error('failure envelope needs error.code and error.message');
        }
      }
      entry.assert(response, response.ok ? response.result : undefined);
      console.log(`  ok  ${label}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${label}: ${error.message}`);
    }
  });

  if (after) {
    try {
      after(responses);
      console.log(`  ok  ${runName} cross-checks`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${runName} cross-checks: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run 1: software mode with the shipped config.
// ---------------------------------------------------------------------------

const softwareEntries = [
  {
    id: '1',
    action: 'sys.hello',
    payload: {},
    assert(_response, result) {
      assertEq(result.firmware, 'micropython-bridge', 'firmware');
      assertEq(result.version, '0.2.0', 'version');
      assertEq(result.protocol, 1, 'protocol');
      assertEq(result.hardware, false, 'hardware');
      assertEq(result.board, 'host', 'board');
      includesAll(
        result.capabilities,
        ['sys.hello', 'gpio.write', 'pwm.configure', 'pwm.write', 'gpio.servo'],
        'soft capabilities',
      );
      excludesAll(
        result.capabilities,
        ['adc.read', 'i2c.scan', 'i2c.read', 'i2c.write', 'spi.transfer'],
        'soft capabilities',
      );
    },
  },
  {
    id: '2',
    action: 'sys.info',
    payload: {},
    assert(_response, result) {
      assertEq(result.hardware, false, 'hardware');
      assertEq(result.machine, 'simulator', 'machine');
    },
  },
  { id: '3', action: 'sys.info', payload: {}, assert() {} },
  {
    id: '4',
    action: 'sys.ping',
    payload: {},
    assert(_response, result) {
      assertEq(result.pong, true, 'pong');
    },
  },
  {
    id: '5',
    action: 'gpio.mode',
    payload: { pin: 4, mode: 'input-pullup' },
    assert(_response, result) {
      assertEq(result.mode, 'input-pullup', 'mode');
    },
  },
  {
    id: '6',
    action: 'gpio.write',
    payload: { pin: 4, value: 1 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  {
    id: '7',
    action: 'gpio.read',
    payload: { pin: 5 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  {
    id: '8',
    action: 'gpio.write',
    payload: { pin: 2, value: 1 },
    assert(_response, result) {
      assertEq(result.pin, 2, 'pin');
      assertEq(result.value, 1, 'value');
    },
  },
  {
    id: '9',
    action: 'gpio.read',
    payload: { pin: 2 },
    assert(_response, result) {
      assertEq(result.value, 1, 'value');
    },
  },
  {
    id: '10',
    action: 'gpio.toggle',
    payload: { pin: 2 },
    assert(_response, result) {
      assertEq(result.value, 0, 'toggled value');
    },
  },
  {
    id: '11',
    action: 'gpio.write',
    payload: { pin: 2, value: 7 },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    id: '12',
    action: 'gpio.write',
    payload: { pin: true, value: 1 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  {
    id: '13',
    action: 'gpio.mode',
    payload: { pin: 2, mode: 'nonsense' },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    id: '14',
    action: 'vendor.custom',
    payload: {},
    assert(response) {
      assertCode(response, 'UNSUPPORTED_ACTION');
    },
  },
  {
    id: '15',
    action: 'adc.read',
    payload: { pin: 32 },
    assert(response) {
      assertCode(response, 'UNSUPPORTED_CAPABILITY');
    },
  },
  {
    id: '16',
    action: 'i2c.scan',
    payload: {},
    assert(response) {
      assertCode(response, 'UNSUPPORTED_CAPABILITY');
    },
  },
  {
    id: '17',
    action: 'spi.transfer',
    payload: { data: [1, 2] },
    assert(response) {
      assertCode(response, 'UNSUPPORTED_CAPABILITY');
    },
  },
  {
    id: '18',
    action: 'pwm.configure',
    payload: { pin: 5, frequency: 1000 },
    assert(_response, result) {
      assertEq(result.frequency, 1000, 'frequency');
    },
  },
  {
    id: '19',
    action: 'pwm.write',
    payload: { pin: 5, duty: 32768 },
    assert(_response, result) {
      assertEq(result.duty, 32768, 'duty');
    },
  },
  {
    id: '20',
    action: 'pwm.write',
    payload: { pin: 5, duty: 70000 },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    id: '21',
    action: 'pwm.write',
    payload: { pin: 6, duty: 0 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  {
    id: '22',
    action: 'gpio.servo',
    payload: { pin: 6, angle: 90 },
    assert(_response, result) {
      assertEq(result.angle, 90, 'angle');
    },
  },
  {
    id: '23',
    action: 'gpio.servo',
    payload: { pin: 6, angle: 181 },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    id: '24',
    action: 'gpio.watch',
    payload: { pin: 2, enable: true },
    assert(_response, result) {
      assertEq(result.watching, true, 'watching');
    },
  },
  {
    id: '25',
    action: 'gpio.watch',
    payload: { pin: 2, enable: false },
    assert(_response, result) {
      assertEq(result.watching, false, 'watching');
    },
  },
  {
    id: '26',
    action: 'gpio.watch',
    payload: { pin: 2, enable: 'yes' },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    label: 'malformed JSON (#27)',
    raw: '{broken',
    expectResponse: true,
    assert(response) {
      assertCode(response, 'INVALID_JSON');
      assertEq(response.id, 'invalid', 'error id');
    },
  },
  { label: 'noise line (#28)', raw: 'boot log noise', assert() {} },
  {
    label: 'v2 request (#29)',
    raw: request('x', 'sys.ping').replace('"v":1', '"v":2'),
    expectResponse: true,
    assert(response) {
      assertCode(response, 'INVALID_MESSAGE');
    },
  },
  {
    label: 'numeric id (#30)',
    raw: JSON.stringify({ v: 1, id: 7, action: 'sys.ping' }),
    expectResponse: true,
    assert(response) {
      assertCode(response, 'INVALID_MESSAGE');
    },
  },
];

function compareSysInfoRepeats(responses) {
  const first = JSON.stringify(responses[1].result);
  const second = JSON.stringify(responses[2].result);
  if (first !== second) throw new Error(`sys.info is not deterministic:\n${first}\n${second}`);
}

// ---------------------------------------------------------------------------
// Run 2: software mode with a temp config (reserved pins + watch limit).
// ---------------------------------------------------------------------------

const reservedEntries = [
  {
    id: '1',
    action: 'gpio.mode',
    payload: { pin: 13, mode: 'output' },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
      if (!response.error.message.includes('reserved')) {
        throw new Error('reserved-pin message should say reserved');
      }
    },
  },
  {
    id: '2',
    action: 'gpio.write',
    payload: { pin: 13, value: 1 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  {
    id: '3',
    action: 'gpio.servo',
    payload: { pin: 13, angle: 0 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  { id: '4', action: 'gpio.watch', payload: { pin: 1 }, assert() {} },
  { id: '5', action: 'gpio.watch', payload: { pin: 2 }, assert() {} },
  { id: '6', action: 'gpio.watch', payload: { pin: 3 }, assert() {} },
  {
    id: '7',
    action: 'gpio.watch',
    payload: { pin: 4 },
    assert(response) {
      assertCode(response, 'WATCH_TABLE_FULL');
    },
  },
  {
    id: '8',
    action: 'gpio.watch',
    payload: { pin: 1, enable: false },
    assert(_response, result) {
      assertEq(result.watching, false, 'watching');
    },
  },
  {
    id: '9',
    action: 'gpio.watch',
    payload: { pin: 4 },
    assert(_response, result) {
      assertEq(result.watching, true, 'watching after a slot was freed');
    },
  },
];

// ---------------------------------------------------------------------------
// Run 3: fake-machine hardware mode. The stub logs every peripheral call.
// ---------------------------------------------------------------------------

const FAKE_MACHINE_PY = `"""Deterministic fake machine module for validate.js. Never flashed."""
import json
import os
import sys

_LOG_PATH = os.environ.get("PINOUT_MACHINE_LOG")


def _log(kind, *args):
    if not _LOG_PATH:
        return
    with open(_LOG_PATH, "a") as handle:
        handle.write(json.dumps([kind] + list(args)) + "\\n")


class Pin:
    OUT = 1
    IN = 0
    PULL_UP = 2
    PULL_DOWN = 3

    def __init__(self, pin, mode=-1, pull=None):
        self.pin = pin
        self.mode = mode
        self._value = 0
        _log("pin-init", pin, mode)

    def value(self, value=None):
        if value is None:
            return self._value
        self._value = 1 if value else 0
        _log("pin-write", self.pin, self._value)


class PWM:
    def __init__(self, pin):
        self.pin = pin
        self._freq = 0
        self._duty = 0

    def freq(self, value=None):
        if value is None:
            return self._freq
        self._freq = value
        _log("pwm-freq", self.pin.pin, value)

    def duty_u16(self, value):
        self._duty = value
        _log("pwm-duty-u16", self.pin.pin, value)

    def duty(self, value):
        self._duty = value
        _log("pwm-duty", self.pin.pin, value)

    def deinit(self):
        _log("pwm-deinit", self.pin.pin)


class ADC:
    def __init__(self, pin):
        self.pin = pin

    def read_u16(self):
        _log("adc-read-u16", self.pin.pin)
        return 32768


class SoftI2C:
    def __init__(self, scl=None, sda=None, freq=100000):
        self.scl = scl
        self.sda = sda
        self.freq = freq

    def scan(self):
        _log("i2c-scan")
        return [0x3C]

    def writeto(self, address, data):
        _log("i2c-write", address, list(data))
        if address == 0x50:
            raise OSError(5, "simulated NACK")

    def readfrom(self, address, length):
        _log("i2c-read", address, length)
        return bytes(range(1, length + 1))


class SoftSPI:
    def __init__(self, baudrate=1000000, polarity=0, phase=0, sck=None, mosi=None, miso=None):
        self.baudrate = baudrate

    def write_readinto(self, out, received):
        _log("spi-transfer", list(out))
        for index in range(len(received)):
            received[index] = 0x55


class UART:
    """Feeds stdin to the bridge once, then ends the process cleanly."""

    def __init__(self, uart_id, baudrate=115200, tx=None, rx=None):
        self.uart_id = uart_id
        self.baudrate = baudrate
        self._buffer = sys.stdin.buffer.read()
        self._spent = not self._buffer

    def read(self):
        if self._spent:
            raise SystemExit(0)
        self._spent = True
        return self._buffer

    def write(self, data):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
`;

const hardwareEntries = [
  {
    id: '1',
    action: 'sys.hello',
    payload: {},
    assert(_response, result) {
      assertEq(result.hardware, true, 'hardware');
      includesAll(
        result.capabilities,
        [
          'adc.read',
          'i2c.scan',
          'i2c.read',
          'i2c.write',
          'spi.transfer',
          'pwm.configure',
          'gpio.servo',
        ],
        'hardware capabilities',
      );
      if (typeof result.board !== 'string' || result.board.length === 0) {
        throw new Error('board must be a non-empty string');
      }
    },
  },
  {
    id: '2',
    action: 'gpio.write',
    payload: { pin: 2, value: 1 },
    assert(_response, result) {
      assertEq(result.value, 1, 'value');
    },
  },
  {
    id: '3',
    action: 'gpio.read',
    payload: { pin: 2 },
    assert(_response, result) {
      assertEq(result.value, 1, 'value');
    },
  },
  {
    id: '4',
    action: 'gpio.mode',
    payload: { pin: 4, mode: 'input-pullup' },
    assert(_response, result) {
      assertEq(result.mode, 'input-pullup', 'mode');
    },
  },
  {
    id: '5',
    action: 'gpio.write',
    payload: { pin: 4, value: 1 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  {
    id: '6',
    action: 'pwm.configure',
    payload: { pin: 5, frequency: 1000 },
    assert(_response, result) {
      assertEq(result.frequency, 1000, 'frequency');
    },
  },
  {
    id: '7',
    action: 'pwm.write',
    payload: { pin: 5, duty: 65535 },
    assert(_response, result) {
      assertEq(result.duty, 65535, 'duty');
    },
  },
  {
    id: '8',
    action: 'gpio.servo',
    payload: { pin: 6, angle: 180 },
    assert(_response, result) {
      assertEq(result.angle, 180, 'angle');
    },
  },
  {
    id: '9',
    action: 'adc.read',
    payload: { pin: 32 },
    assert(_response, result) {
      assertEq(result.raw, 32768, 'raw');
      assertEq(result.scale, 65535, 'scale');
    },
  },
  {
    id: '10',
    action: 'i2c.scan',
    payload: {},
    assert(_response, result) {
      assertEq(JSON.stringify(result.addresses), JSON.stringify(['0x3c']), 'addresses');
    },
  },
  {
    id: '11',
    action: 'i2c.write',
    payload: { address: 60, data: [1, 2, 255] },
    assert(_response, result) {
      assertEq(result.written, 3, 'written');
    },
  },
  {
    id: '12',
    action: 'i2c.write',
    payload: { address: 80, data: [0] },
    assert(response) {
      assertCode(response, 'BUS_ERROR');
    },
  },
  {
    id: '13',
    action: 'i2c.read',
    payload: { address: 60, length: 4 },
    assert(_response, result) {
      assertEq(JSON.stringify(result.data), JSON.stringify([1, 2, 3, 4]), 'data');
    },
  },
  {
    id: '14',
    action: 'spi.transfer',
    payload: { data: [1, 2, 3] },
    assert(_response, result) {
      assertEq(JSON.stringify(result.data), JSON.stringify([85, 85, 85]), 'data');
    },
  },
  {
    id: '15',
    action: 'i2c.write',
    payload: { address: 200, data: [1] },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    id: '16',
    action: 'i2c.read',
    payload: { address: 60, length: 0 },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    id: '17',
    action: 'spi.transfer',
    payload: { data: [] },
    assert(response) {
      assertCode(response, 'INVALID_PAYLOAD');
    },
  },
  {
    id: '18',
    action: 'pwm.write',
    payload: { pin: 7, duty: 1 },
    assert(response) {
      assertCode(response, 'INVALID_PIN');
    },
  },
  {
    id: '19',
    action: 'gpio.write',
    payload: { pin: 6, value: 0 },
    assert(_response, result) {
      assertEq(result.value, 0, 'value');
    },
  },
];

function checkMachineCalls(logPath) {
  const calls = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const has = (expected) => calls.some((call) => JSON.stringify(call) === JSON.stringify(expected));
  const expectedCalls = [
    ['pin-write', 2, 1],
    ['pwm-freq', 5, 1000],
    ['pwm-duty-u16', 5, 65535],
    ['pwm-freq', 6, 50],
    ['pwm-duty-u16', 6, 6553], // 2000 us of a 20 ms period at 16-bit duty
    ['pwm-deinit', 6],
    ['adc-read-u16', 32],
    ['i2c-scan'],
    ['i2c-write', 60, [1, 2, 255]],
    ['spi-transfer', [1, 2, 3]],
  ];
  for (const expected of expectedCalls) {
    if (!has(expected)) {
      throw new Error(`machine call log is missing ${JSON.stringify(expected)}`);
    }
  }
}

function writeReservedConfig(softDir) {
  const overrideLines = [
    '',
    '# validate.js override: reserved pins and a small watch table',
    'RESERVED_PINS = frozenset({13})',
    'MAX_WATCHES = 3',
    '',
  ];
  const configPath = join(softDir, 'config.py');
  writeFileSync(configPath, readFileSync(configPath, 'utf8') + overrideLines.join('\n'));
}

function main() {
  if (!pythonAvailable()) {
    console.log('SKIP: python3 unavailable; bridge protocol not validated');
    process.exit(0);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'pinout-micropython-'));
  try {
    const softDir = join(tempRoot, 'soft');
    const hardwareDir = join(tempRoot, 'hardware');
    mkdirSync(softDir);
    mkdirSync(hardwareDir);
    for (const dir of [softDir, hardwareDir]) {
      copyFileSync(join(bridgeDir, 'main.py'), join(dir, 'main.py'));
      copyFileSync(join(bridgeDir, 'config.py'), join(dir, 'config.py'));
    }
    writeReservedConfig(softDir);
    writeFileSync(join(hardwareDir, 'machine.py'), FAKE_MACHINE_PY);
    const machineLog = join(hardwareDir, 'machine-calls.jsonl');
    const hardwareEnv = { PINOUT_MACHINE_LOG: machineLog };
    const afterHardware = () => checkMachineCalls(machineLog);

    console.log('MicroPython bridge validation matrix (host-side only)');
    checkRun('software', bridgeDir, softwareEntries, {}, compareSysInfoRepeats);
    checkRun('reserved', softDir, reservedEntries);
    checkRun('fake-hardware', hardwareDir, hardwareEntries, hardwareEnv, afterHardware);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`FAIL: ${failures} bridge protocol check(s) failed`);
    process.exit(1);
  }
  console.log('PASS: software, reserved-pin and fake-hardware matrices match the v1 wire contract');
  process.exit(0);
}

main();
