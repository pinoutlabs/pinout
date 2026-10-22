import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const headers = 'firmware/uno-bridge/.pio/libdeps/uno/ArduinoJson/src';
if (!existsSync(headers))
  throw Error(
    'Run pio run -d firmware/uno-bridge first to install the pinned ArduinoJson library.',
  );
const binary = join(mkdtempSync(join(tmpdir(), 'pinout-uno-test-')), 'uno');
execFileSync(
  'c++',
  [
    '-std=c++17',
    '-Iscripts/firmware-test',
    `-I${headers}`,
    'scripts/firmware-test/uno.cpp',
    '-o',
    binary,
  ],
  { stdio: 'inherit' },
);
let seq = 0;
const cmd = (action, payload = {}) => JSON.stringify({ v: 1, id: String(++seq), action, payload });
const input =
  [
    cmd('sys.hello'),
    cmd('gpio.write', { pin: 15, value: true }),
    cmd('gpio.configSafeState', { pin: 15, safeLevel: 'high', polarity: 'active-low' }),
    cmd('sys.arm', { timeoutMs: 300 }),
    cmd('gpio.write', { pin: 15, value: false }),
    cmd('gpio.read', { pin: 15 }),
    '@advance 301',
    cmd('gpio.read', { pin: 15 }),
    cmd('gpio.write', { pin: 15, value: false }),
    cmd('sys.arm', { timeoutMs: 0 }),
    cmd('sys.arm', { timeoutMs: 300 }),
    cmd('gpio.write', { pin: 1, value: true }),
    cmd('gpio.analogRead', { pin: 15 }),
    cmd('gpio.pwm', { pin: 3, duty: 0.5 }),
    // An oversized frame must discard its valid-looking suffix, not execute it.
    'x'.repeat(256) + cmd('gpio.write', { pin: 15, value: false }),
    cmd('gpio.read', { pin: 15 }),
    cmd('sys.disarm'),
    cmd('gpio.mode', { pin: 15, mode: 'output' }),
  ].join('\n') + '\n';
const lines = execFileSync(binary, [], { input, encoding: 'utf8' })
  .trim()
  .split('\n')
  .map(JSON.parse);
const results = lines.filter((r) => r.id);
assert.equal(results.length, 16);
assert.equal(results[0].result.boardId, 'arduino-uno');
assert.equal(results[1].error.code, 'NOT_ARMED');
assert.equal(results[2].result.polarity, 'active-low');
assert.equal(results[5].result.value, false);
assert.equal(results[6].result.value, true);
assert.equal(results[7].error.code, 'WATCHDOG_TRIPPED');
assert.equal(results[8].error.code, 'INVALID_PAYLOAD');
assert.equal(results[10].error.code, 'INVALID_PIN');
assert.equal(results[11].result.value, 512);
assert.equal(results[12].error.code, 'UNSUPPORTED_CAPABILITY');
assert.equal(results[13].result.value, true);
assert.equal(results[15].error.code, 'NOT_ARMED');
assert(lines.some((r) => r.event === 'device.tripped'));
console.log(
  'Uno firmware source harness passed: protocol, A1, active-low expiry, invalid pins, arming, ADC, unsupported PWM, overflow recovery. GPIO/time are simulated; this is not physical evidence.',
);
