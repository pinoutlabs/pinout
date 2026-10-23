#!/usr/bin/env node
/**
 * Host-side validation for the MicroPython bridge.
 *
 * Drives the bridge's stdin/stdout mode with NDJSON requests and asserts the
 * responses match the wire contract in packages/core/src/protocol.ts:
 *   success: {"v":1,"id","ok":true,"result":{...}}
 *   failure: {"v":1,"id","ok":false,"error":{"code","message"}}
 *
 * Exits 0 on success, 1 on mismatch, and prints SKIP (exit 0) when python3 is
 * unavailable. This validates protocol shape only — hardware behavior still
 * needs real-device verification. Evidence: SIMULATED.
 */
import { spawnSync } from 'node:child_process';

const python = process.platform === 'win32' ? 'python' : 'python3';

function pythonAvailable() {
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function toResponseLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((message) => message.id !== undefined);
}

function request(id, action, payload = {}) {
  return JSON.stringify({ v: 1, id, action, payload });
}

const expectations = [
  {
    action: 'sys.hello',
    payload: {},
    assert(response, result) {
      if (result.firmware !== 'micropython-bridge') throw new Error('firmware name mismatch');
      if (result.protocol !== 1) throw new Error('protocol version must be 1');
      if (!Array.isArray(result.capabilities) || result.capabilities.length < 10) {
        throw new Error('capabilities array missing');
      }
      if (typeof result.version !== 'string') throw new Error('version missing');
    },
  },
  {
    action: 'sys.ping',
    payload: {},
    assert(_response, result) {
      if (result.pong !== true) throw new Error('expected pong');
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 2, value: 1 },
    assert(_response, result) {
      if (result.pin !== 2 || result.value !== 1) throw new Error('gpio.write echo mismatch');
    },
  },
  {
    action: 'gpio.read',
    payload: { pin: 2 },
    assert(_response, result) {
      if (result.value !== 1) throw new Error('gpio.read should return written value');
    },
  },
  {
    action: 'gpio.toggle',
    payload: { pin: 2 },
    assert(_response, result) {
      if (result.value !== 0) throw new Error('gpio.toggle should flip to 0');
    },
  },
  {
    action: 'gpio.mode',
    payload: { pin: 4, mode: 'input-pullup' },
    assert(_response, result) {
      if (result.mode !== 'input-pullup') throw new Error('gpio.mode echo mismatch');
    },
  },
  {
    action: 'gpio.write',
    payload: { pin: 4, value: 1 },
    assert(response) {
      if (response.ok !== false) throw new Error('writing an input pin must fail');
      if (typeof response.error.code !== 'string' || typeof response.error.message !== 'string') {
        throw new Error('failure envelope needs error.code and error.message');
      }
    },
  },
  {
    // The bridge is board-agnostic without ALLOWED_PINS: any non-negative pin
    // is trackable in software mode. Deployment-specific reservations live in
    // config.py's RESERVED_PINS (per-board edit), so pin 99 writing cleanly is
    // correct for the generic profile. Pico validation is validate-pico.js.
    action: 'gpio.write',
    payload: { pin: 99, value: 0 },
    assert(_response, result) {
      if (result.pin !== 99 || result.value !== 0) throw new Error('pin 99 write echo mismatch');
    },
  },
  {
    action: 'adc.read',
    payload: { pin: 32 },
    assert(response) {
      if (response.ok !== false) throw new Error('adc.read must fail cleanly in software mode');
    },
  },
  {
    action: 'vendor.custom',
    payload: {},
    assert(response) {
      if (response.ok !== false) throw new Error('unknown actions must fail');
      if (response.error.code !== 'UNSUPPORTED_ACTION')
        throw new Error('expected UNSUPPORTED_ACTION');
    },
  },
];

function main() {
  if (!pythonAvailable()) {
    console.log('SKIP: python3 unavailable; bridge protocol not validated');
    process.exit(0);
  }

  const input =
    expectations
      .map((item, index) => request(String(index + 1), item.action, item.payload))
      .join('\n') + '\n';
  const run = spawnSync(python, ['-u', 'main.py'], {
    input,
    encoding: 'utf8',
    cwd: new URL('.', import.meta.url).pathname,
    timeout: 20000,
  });

  if (run.error) {
    console.error(`FAIL: could not spawn python: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0 && run.stderr) {
    console.error(`FAIL: bridge exited with ${run.status}\n${run.stderr}`);
    process.exit(1);
  }

  const messages = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const ready = messages.find((message) => message.event === 'ready');
  if (!ready || ready.v !== 1 || ready.payload?.firmware !== 'micropython-bridge') {
    console.error('FAIL: missing ready event on boot\nstdout:\n' + run.stdout);
    process.exit(1);
  }

  const lines = toResponseLines(run.stdout);
  if (lines.length !== expectations.length) {
    console.error(
      `FAIL: expected ${expectations.length} responses, got ${lines.length}\nstdout:\n${run.stdout}`,
    );
    process.exit(1);
  }

  let failures = 0;
  expectations.forEach((item, index) => {
    const response = lines[index];
    const label = `${item.action} (#${index + 1})`;
    try {
      if (response.v !== 1) throw new Error('missing v=1');
      if (response.id !== String(index + 1)) throw new Error(`id mismatch: ${response.id}`);
      if (response.ok !== true && response.ok !== false) throw new Error('ok must be boolean');
      if (response.ok === true && typeof response.result !== 'object')
        throw new Error('success needs result object');
      item.assert(response, response.ok ? response.result : undefined);
      console.log(`  ok  ${label}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${label}: ${error.message}`);
    }
  });

  if (failures > 0) {
    console.error(`${failures}/${expectations.length} bridge protocol checks failed`);
    process.exit(1);
  }
  console.log(
    `PASS: ${expectations.length}/${expectations.length} bridge protocol checks match the v1 wire contract (SIMULATED)`,
  );
  process.exit(0);
}

main();
