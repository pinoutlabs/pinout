import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connect,
  protocolVersion,
  simulatedEsp32,
  type Device,
  type DevicesFile,
  type Transport,
} from '@pinout/core';
import { evaluateDoctor, runDoctor } from '../src/doctor.js';
import type { DoctorDependencies, DoctorOptions } from '../src/doctor/types.js';
import type { CliOutput } from '../src/output.js';
import { runCli } from '../src/runCli.js';

const tempHomes: string[] = [];
afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function createTempHome(devicesFile?: DevicesFile): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinout-doctor-home-'));
  tempHomes.push(dir);
  if (devicesFile) {
    writeFileSync(join(dir, 'devices.json'), `${JSON.stringify(devicesFile, null, 2)}\n`, 'utf8');
  }
  return dir;
}

function createRecordingTransport(): {
  transport: Transport;
  recordedWrites: string[];
  recordedActions: string[];
} {
  const base = simulatedEsp32();
  const recordedWrites: string[] = [];
  const recordedActions: string[] = [];

  const transport: Transport = {
    kind: 'recording-transport',
    get readable() {
      return base.readable;
    },
    open: () => base.open(),
    close: () => base.close(),
    write: async (data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      recordedWrites.push(text);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed) as { action?: string };
            if (parsed.action) {
              recordedActions.push(parsed.action);
            }
          } catch {
            // ignore non-json
          }
        }
      }
      return base.write(data);
    },
  };

  return { transport, recordedWrites, recordedActions };
}

describe('doctor unit and integration tests', () => {
  it('passes all checks in all-green simulation environment', async () => {
    const home = createTempHome({
      schemaVersion: 1,
      devices: [
        {
          id: 'lab-esp',
          module: 'pinout/esp32',
          backend: { type: 'simulated' },
        },
      ],
    });

    const mockFetch = async () =>
      new Response(JSON.stringify({ ok: true, version: '0.0.1', devices: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const options: DoctorOptions = { mock: true };
    const deps: DoctorDependencies = {
      home,
      fetch: mockFetch as typeof fetch,
      nodeVersion: '20.18.0',
      listSerialPorts: async () => [],
    };

    const report = await evaluateDoctor(options, deps);
    expect(report.ok).toBe(true);
    expect(report.status).toBe('pass');
    expect(report.summary.failed).toBe(0);
    expect(report.summary.warned).toBe(0);
    expect(report.nextSteps).toHaveLength(0);

    const checkNames = report.checks.map((c) => c.name);
    expect(checkNames).toContain('node-version');
    expect(checkNames).toContain('pinout-home');
    expect(checkNames).toContain('env-vars');
    expect(checkNames).toContain('daemon-health');
    expect(checkNames).toContain('ble-scan');
    expect(checkNames).toContain('firmware-identity:simulator');
    expect(checkNames).toContain('enrolled-devices');
    expect(checkNames).toContain('device:lab-esp');
    expect(checkNames).toContain('mock-handshake');

    const bleCheck = report.checks.find((c) => c.name === 'ble-scan');
    expect(bleCheck?.status).toBe('pass');
    expect(bleCheck?.detail).toMatch(/mock mode|no radio/i);
  });

  it('reports nearby BLE candidates from an injected advertisement scanner', async () => {
    const home = createTempHome();
    const report = await evaluateDoctor(
      {},
      {
        home,
        nodeVersion: '20.18.0',
        listSerialPorts: async () => [],
        bleScanAvailable: async () => true,
        discoverBle: async () => [
          {
            endpoint: { address: 'aa:bb:cc:dd:ee:ff' },
            possibleIdentity: [{ moduleId: 'pinout/esp32' }],
          },
        ],
        fetch: (async () =>
          new Response(JSON.stringify({ ok: true, version: '0.0.1', devices: 0 }), {
            status: 200,
          })) as typeof fetch,
      },
    );
    const bleCheck = report.checks.find((c) => c.name === 'ble-scan');
    expect(bleCheck?.status).toBe('pass');
    expect(bleCheck?.detail).toContain('aa:bb:cc:dd:ee:ff');
    expect(bleCheck?.detail).toContain('never connects');
  });

  it('explains when daemon is unreachable and provides correct remedy', async () => {
    const home = createTempHome();
    const mockFetch = async () => {
      throw new Error('fetch failed (ECONNREFUSED)');
    };

    const deps: DoctorDependencies = {
      home,
      fetch: mockFetch as typeof fetch,
      nodeVersion: '20.10.0',
      listSerialPorts: async () => [],
    };

    // Default loopback URL unreachable is a WARN (direct CLI works without daemon)
    const reportWarn = await evaluateDoctor({}, deps);
    const daemonWarn = reportWarn.checks.find((c) => c.name === 'daemon-health');
    expect(daemonWarn).toBeDefined();
    expect(daemonWarn?.status).toBe('warn');
    expect(daemonWarn?.detail).toContain('Cannot reach Pinout daemon at');
    expect(daemonWarn?.nextStep).toMatch(/Start the daemon with .*pinoutd/);
    expect(reportWarn.nextSteps.some((s) => s.includes('Start the daemon'))).toBe(true);

    // Explicit custom URL unreachable is a FAIL
    const reportFail = await evaluateDoctor({ url: 'http://192.168.1.100:8787' }, deps);
    const daemonFail = reportFail.checks.find((c) => c.name === 'daemon-health');
    expect(daemonFail).toBeDefined();
    expect(daemonFail?.status).toBe('fail');
    expect(reportFail.ok).toBe(false);
  });

  it('skips daemon check when --no-daemon is requested', async () => {
    const home = createTempHome();
    const mockFetch = async () => {
      throw new Error('Should not be called');
    };

    const options: DoctorOptions = { daemon: false, mock: true };
    const deps: DoctorDependencies = {
      home,
      fetch: mockFetch as typeof fetch,
      nodeVersion: '20.10.0',
      listSerialPorts: async () => [],
    };

    const report = await evaluateDoctor(options, deps);
    const daemonCheck = report.checks.find((c) => c.name === 'daemon-health');
    expect(daemonCheck).toBeDefined();
    expect(daemonCheck?.status).toBe('skip');
    expect(daemonCheck?.detail).toContain('--no-daemon');
  });

  it('explains daemon authentication rejection when token is invalid', async () => {
    const home = createTempHome();
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
        status: 401,
      });

    const deps: DoctorDependencies = {
      home,
      fetch: mockFetch as typeof fetch,
      nodeVersion: '20.10.0',
      listSerialPorts: async () => [],
    };

    const report = await evaluateDoctor({}, deps);
    const daemonCheck = report.checks.find((c) => c.name === 'daemon-health');
    expect(daemonCheck?.status).toBe('fail');
    expect(daemonCheck?.detail).toContain('rejected authentication (HTTP 401)');
    expect(daemonCheck?.nextStep).toContain('PINOUT_TOKEN');
  });

  it('reports warning and next step when no serial ports are found', async () => {
    const home = createTempHome();
    const mockFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    const deps: DoctorDependencies = {
      home,
      fetch: mockFetch as typeof fetch,
      listSerialPorts: async () => [],
    };

    const report = await evaluateDoctor({}, deps);
    const portsCheck = report.checks.find((c) => c.name === 'serial-ports');
    expect(portsCheck?.status).toBe('warn');
    expect(portsCheck?.detail).toContain('No serial ports detected');
    expect(portsCheck?.nextStep).toContain('Connect an ESP32 board via USB data cable');
  });

  it('identifies known boards and warns on unidentified USB VID/PID without auto-flashing', async () => {
    const home = createTempHome();
    const mockFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    const deps: DoctorDependencies = {
      home,
      fetch: mockFetch as typeof fetch,
      listSerialPorts: async () => [
        {
          path: '/dev/cu.usbserial-0001',
          vendorId: '10c4',
          productId: 'ea60',
          manufacturer: 'Silicon Labs',
        },
        {
          path: '/dev/cu.unknown-9999',
          vendorId: '9999',
          productId: '8888',
          manufacturer: 'Acme Corp',
        },
      ],
    };

    const report = await evaluateDoctor({ daemon: false }, deps);
    const matchedCheck = report.checks.find((c) => c.name === 'board-match:/dev/cu.usbserial-0001');
    expect(matchedCheck?.status).toBe('pass');
    expect(matchedCheck?.detail).toContain('matched board');
    expect(matchedCheck?.detail).toContain('esp32-devkit-v1');

    const unknownCheck = report.checks.find((c) => c.name === 'board-match:/dev/cu.unknown-9999');
    expect(unknownCheck?.status).toBe('warn');
    expect(unknownCheck?.detail).toContain('unidentified board');
    expect(unknownCheck?.detail).toContain('Pinout will never auto-flash unidentified boards');
    expect(unknownCheck?.nextStep).toContain('manually flash Pinout bridge firmware');
  });

  it('handles firmware handshake timeout with clear remedy', async () => {
    const home = createTempHome();
    const deps: DoctorDependencies = {
      home,
      nodeVersion: '20.10.0',
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [{ path: '/dev/cu.usbserial-unresponsive' }],
      connect: async () => {
        throw new Error('Timed out waiting for sys.hello (3000ms)');
      },
    };

    const report = await evaluateDoctor({ port: '/dev/cu.usbserial-unresponsive' }, deps);
    const fwCheck = report.checks.find(
      (c) => c.name === 'firmware-identity:/dev/cu.usbserial-unresponsive',
    );
    expect(fwCheck?.status).toBe('fail');
    expect(fwCheck?.detail).toContain('No Pinout firmware responded');
    expect(fwCheck?.nextStep).toContain('Flash Pinout bridge firmware');
  });

  it('handles protocol version mismatch with clear explanation', async () => {
    const home = createTempHome();
    const deps: DoctorDependencies = {
      home,
      nodeVersion: '20.10.0',
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [{ path: '/dev/cu.usbserial-old' }],
      connect: async () =>
        ({
          info: {
            firmware: 'esp32-bridge',
            version: '0.0.1',
            protocol: 999, // mismatch
            capabilities: ['sys.hello'],
            features: ['watchdog', 'arming'],
          },
          close: async () => {},
        }) as unknown as Device,
    };

    const report = await evaluateDoctor({ port: '/dev/cu.usbserial-old' }, deps);
    const fwCheck = report.checks.find((c) => c.name === 'firmware-identity:/dev/cu.usbserial-old');
    expect(fwCheck?.status).toBe('fail');
    expect(fwCheck?.detail).toContain('Protocol version mismatch');
    expect(fwCheck?.detail).toContain(`host expects v${protocolVersion}`);
    expect(fwCheck?.nextStep).toContain('Flash matching firmware');
  });

  it('warns when legacy firmware does not advertise watchdog and arming features', async () => {
    const home = createTempHome();
    const deps: DoctorDependencies = {
      home,
      nodeVersion: '20.10.0',
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [{ path: '/dev/cu.usbserial-legacy' }],
      connect: async () =>
        ({
          info: {
            firmware: 'esp32-bridge',
            version: '0.1.0',
            protocol: protocolVersion,
            capabilities: ['sys.hello', 'gpio.write'],
            features: [], // missing watchdog and arming
          },
          close: async () => {},
        }) as unknown as Device,
    };

    const report = await evaluateDoctor({ port: '/dev/cu.usbserial-legacy' }, deps);
    const fwCheck = report.checks.find(
      (c) => c.name === 'firmware-identity:/dev/cu.usbserial-legacy',
    );
    expect(fwCheck?.status).toBe('warn');
    expect(fwCheck?.detail).toContain('does not advertise watchdog/arming');
    expect(fwCheck?.detail).toContain('sustained actuation not supported');
    expect(fwCheck?.nextStep).toContain('Update to modern firmware');
  });

  it('warns when no devices are configured in registry', async () => {
    const home = createTempHome({ schemaVersion: 1, devices: [] });
    const deps: DoctorDependencies = {
      home,
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [],
    };

    const report = await evaluateDoctor({ mock: true }, deps);
    const configCheck = report.checks.find((c) => c.name === 'enrolled-devices');
    expect(configCheck?.status).toBe('warn');
    expect(configCheck?.detail).toContain('No devices configured');
    expect(configCheck?.nextStep).toContain('pinout enroll');
  });

  it('warns when an enrolled device port is not present on host', async () => {
    const home = createTempHome({
      schemaVersion: 1,
      devices: [
        {
          id: 'sensor-temp',
          module: 'pinout/esp32',
          backend: {
            type: 'protocol',
            transport: { type: 'serial', path: '/dev/cu.missing-usb' },
          },
        },
      ],
    });

    const deps: DoctorDependencies = {
      home,
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [
        { path: '/dev/cu.other-port', vendorId: '10c4', productId: 'ea60' },
      ],
    };

    const report = await evaluateDoctor({ mock: true }, deps);
    const devCheck = report.checks.find((c) => c.name === 'device:sensor-temp');
    expect(devCheck?.status).toBe('warn');
    expect(devCheck?.detail).toContain(
      "expects port '/dev/cu.missing-usb' which is not currently detected",
    );
    expect(devCheck?.nextStep).toContain(
      "Connect device 'sensor-temp' to USB port '/dev/cu.missing-usb'",
    );
  });

  it('fails when Node version is below 20', async () => {
    const home = createTempHome();
    const deps: DoctorDependencies = {
      home,
      nodeVersion: '18.19.0',
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [],
    };

    const report = await evaluateDoctor({ mock: true }, deps);
    const nodeCheck = report.checks.find((c) => c.name === 'node-version');
    expect(nodeCheck?.status).toBe('fail');
    expect(nodeCheck?.detail).toContain('below required Node.js 20+');
    expect(nodeCheck?.nextStep).toContain('Upgrade Node.js');
    expect(report.ok).toBe(false);
  });

  it('fails when home directory is not writable', async () => {
    const deps: DoctorDependencies = {
      home: '/root/unwritable-pinout-test',
      isHomeWritable: () => false,
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [],
    };

    const report = await evaluateDoctor({ mock: true }, deps);
    const homeCheck = report.checks.find((c) => c.name === 'pinout-home');
    expect(homeCheck?.status).toBe('fail');
    expect(homeCheck?.detail).toContain('not writable');
    expect(homeCheck?.nextStep).toContain('Ensure write permissions');
    expect(report.ok).toBe(false);
  });

  it('emits a stable JSON schema for agents and test tooling', async () => {
    const home = createTempHome();
    const logs: unknown[] = [];
    const output: CliOutput = {
      json: true,
      log: (val) => logs.push(val),
      error: () => {},
    };

    const deps: DoctorDependencies = {
      home,
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [],
    };

    await runDoctor(output, { mock: true }, deps);
    expect(logs).toHaveLength(1);

    const json = logs[0] as {
      ok: boolean;
      status: string;
      summary: { total: number; passed: number; warned: number; failed: number; skipped: number };
      checks: Array<{
        stage: string;
        name: string;
        status: string;
        detail: string;
        nextStep?: string;
      }>;
      nextSteps: string[];
    };

    expect(typeof json.ok).toBe('boolean');
    expect(['pass', 'warn', 'fail']).toContain(json.status);
    expect(json.summary).toBeDefined();
    expect(typeof json.summary.total).toBe('number');
    expect(typeof json.summary.passed).toBe('number');
    expect(typeof json.summary.warned).toBe('number');
    expect(typeof json.summary.failed).toBe('number');
    expect(typeof json.summary.skipped).toBe('number');
    expect(Array.isArray(json.checks)).toBe(true);
    expect(Array.isArray(json.nextSteps)).toBe(true);

    for (const check of json.checks) {
      expect([
        'environment',
        'daemon',
        'discovery',
        'firmware',
        'configuration',
        'simulator',
      ]).toContain(check.stage);
      expect(typeof check.name).toBe('string');
      expect(['pass', 'warn', 'fail', 'skip']).toContain(check.status);
      expect(typeof check.detail).toBe('string');
    }
  });

  it('PROVABLY NEVER ACTUATES: records all outbound protocol lines and asserts only identity/hello commands appear', async () => {
    const home = createTempHome();
    const { transport: recordingTransport, recordedActions } = createRecordingTransport();

    const deps: DoctorDependencies = {
      home,
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      listSerialPorts: async () => [{ path: '/dev/cu.usbserial-test' }],
      createSerialTransport: () => recordingTransport,
      connect: async (options) => {
        // Connect through real connect() using our recording transport
        return connect({ transport: options.transport, timeoutMs: options.timeoutMs ?? 3000 });
      },
    };

    const report = await evaluateDoctor({ port: '/dev/cu.usbserial-test' }, deps);
    expect(report.summary.failed).toBe(0);

    // Verify all outbound actions recorded on the wire
    expect(recordedActions.length).toBeGreaterThan(0);
    for (const action of recordedActions) {
      // The only permitted action on the wire during doctor run is read-only sys.hello
      expect(action).toBe('sys.hello');
    }

    // Explicitly assert that actuation, mode configuration, arming, PWM, and write commands NEVER occurred
    const forbiddenActuationActions = [
      'gpio.write',
      'gpio.batchWrite',
      'gpio.mode',
      'gpio.pwm',
      'gpio.pulse',
      'gpio.toggle',
      'gpio.servo',
      'gpio.motor',
      'gpio.stopAll',
      'gpio.configSafeState',
      'sys.arm',
      'sys.disarm',
      'watchdog.configure',
      'watchdog.kick',
      'i2c.write',
      'spi.transfer',
    ];

    for (const forbidden of forbiddenActuationActions) {
      expect(
        recordedActions,
        `Doctor must never invoke actuation capability '${forbidden}'`,
      ).not.toContain(forbidden);
    }
  });

  it('runs through CLI with --mock --no-daemon flags', async () => {
    const home = createTempHome();
    const prevHome = process.env.PINOUT_HOME;
    process.env.PINOUT_HOME = home;

    try {
      const logs: string[] = [];
      const errors: string[] = [];
      const io = {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => errors.push(msg),
      };

      const code = await runCli(['node', 'pinout', 'doctor', '--mock', '--no-daemon'], io);
      expect(code).toBe(0);
      const combined = logs.join('\n');
      expect(combined).toContain('=== PINOUT DOCTOR DIAGNOSTIC REPORT ===');
      expect(combined).toContain('[ENVIRONMENT]');
      expect(combined).toContain('[DAEMON]');
      expect(combined).toContain('SKIP');
      expect(combined).toContain('[SIMULATOR]');
      expect(combined).toContain('PASS');
    } finally {
      if (prevHome !== undefined) {
        process.env.PINOUT_HOME = prevHome;
      } else {
        delete process.env.PINOUT_HOME;
      }
    }
  });
});
