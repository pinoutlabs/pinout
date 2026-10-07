import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/runCli.js';

const enrollmentHomes: string[] = [];
afterEach(() => {
  for (const home of enrollmentHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env.PINOUT_HOME;
});

describe('cli', () => {
  it('prints help for gpio and top-level commands', async () => {
    const io = captureIo();
    expect(await runCli(['node', 'pinout', '--help'], io)).toBe(0);
    expect(io.logs.join('\n')).toMatch(/doctor|gpio|invoke|blink/);

    const gpioHelp = captureIo();
    expect(await runCli(['node', 'pinout', 'gpio', '--help'], gpioHelp)).toBe(0);
    expect(gpioHelp.logs.join('\n')).toMatch(/mode|toggle|pulse|pwm|analog|watch/);
  });

  it('registers discover and enrolls the simulator with a 0600 identity registry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pinout-enroll-'));
    enrollmentHomes.push(home);
    process.env.PINOUT_HOME = home;
    const help = captureIo();
    expect(await runCli(['node', 'pinout', 'discover', '--help'], help)).toBe(0);
    expect(help.logs.join('\n')).toContain('candidate devices');

    const io = captureIo();
    expect(
      await runCli(
        ['node', 'pinout', '--json', 'enroll', '--mock', '--id', 'lab-esp', '--yes'],
        io,
      ),
    ).toBe(0);
    const file = join(home, 'devices.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      devices: Array<{ identity: { firmware: string } }>;
    };
    expect(parsed.devices[0]?.identity.firmware).toBe('esp32-bridge');
    // Windows reports writable mode bits, not POSIX owner/group permissions.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('prints version', async () => {
    const io = captureIo();
    const code = await runCli(['node', 'pinout', '--version'], io);
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('0.0.1-alpha.1');
  });

  it('handshakes with the simulator', async () => {
    const io = captureIo();
    const code = await runCli(['node', 'pinout', 'hello', '--mock'], io);
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('esp32-bridge');
    expect(io.logs.join('\n')).toContain('gpio.write');
    expect(io.logs.join('\n')).toContain('uptime');
  });

  it('handshakes with json output', async () => {
    const io = captureIo();
    const code = await runCli(['node', 'pinout', '--json', 'hello', '--mock'], io);
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0] ?? '{}') as { firmware: string };
    expect(payload.firmware).toBe('esp32-bridge');
  });

  it('writes and reads GPIO through invoke on one connection', async () => {
    const io = captureIo();
    expect(
      await runCli(
        [
          'node',
          'pinout',
          'run',
          '--mock',
          '--script',
          '{"action":"sys.arm","payload":{}}\n{"action":"gpio.write","payload":{"pin":2,"value":true}}\n{"action":"gpio.read","payload":{"pin":2}}',
        ],
        io,
      ),
    ).toBe(0);
    expect(io.logs.join('\n')).toContain('"value":true');
  });

  it('writes and reads GPIO through gpio subcommands via run script', async () => {
    const io = captureIo();
    expect(
      await runCli(
        [
          'node',
          'pinout',
          'run',
          '--mock',
          '--script',
          '{"action":"sys.arm","payload":{}}\n{"action":"gpio.write","payload":{"pin":2,"value":true}}\n{"action":"gpio.read","payload":{"pin":2}}',
        ],
        io,
      ),
    ).toBe(0);
    expect(io.logs.join('\n')).toContain('true');
  });

  it('runs an inline action script', async () => {
    const io = captureIo();
    const code = await runCli(
      [
        'node',
        'pinout',
        'run',
        '--mock',
        '--script',
        '{"action":"sys.arm","payload":{}}\n{"action":"gpio.write","payload":{"pin":2,"value":true}}\n{"action":"gpio.read","payload":{"pin":2}}',
      ],
      io,
    );
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('gpio.read');
    expect(io.logs.join('\n')).toContain('true');
  });

  it('blinks on the simulator', async () => {
    const io = captureIo();
    const code = await runCli(
      ['node', 'pinout', 'blink', '--mock', '--count', '2', '--delay', '10'],
      io,
    );
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('blinked gpio 2 2 time(s)');
  });

  it('passes doctor checks', async () => {
    const io = captureIo();
    const home = mkdtempSync(join(tmpdir(), 'pinout-doctor-'));
    enrollmentHomes.push(home);
    process.env.PINOUT_HOME = home;
    const code = await runCli(['node', 'pinout', 'doctor', '--mock', '--no-daemon'], io);
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('mock');
  });

  it('prints pin groups', async () => {
    const io = captureIo();
    const code = await runCli(['node', 'pinout', 'pins'], io);
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('SPI flash');
  });

  it('uses PINOUT_PORT when set', async () => {
    const previous = process.env.PINOUT_PORT;
    process.env.PINOUT_PORT = '/dev/test-port';
    try {
      const io = captureIo();
      const code = await runCli(['node', 'pinout', 'hello'], io);
      expect(code).toBe(1);
      expect(io.errors.join('\n')).toMatch(/serial|port|open/i);
    } finally {
      if (previous === undefined) {
        delete process.env.PINOUT_PORT;
      } else {
        process.env.PINOUT_PORT = previous;
      }
    }
  });

  it('fails clearly without --port or --mock', async () => {
    const previous = process.env.PINOUT_PORT;
    delete process.env.PINOUT_PORT;
    try {
      const io = captureIo();
      const code = await runCli(['node', 'pinout', 'hello'], io);
      expect(code).toBe(1);
      expect(io.errors.join('\n')).toMatch(/--port|--mock|PINOUT_PORT/);
    } finally {
      if (previous !== undefined) {
        process.env.PINOUT_PORT = previous;
      }
    }
  });

  it('rejects an invalid ESP32 pin', async () => {
    const io = captureIo();
    const code = await runCli(['node', 'pinout', 'gpio', 'write', '34', 'high', '--mock'], io);
    expect(code).toBe(1);
    expect(io.errors.join('\n')).toMatch(/input-only/);
  });

  it('sets gpio mode and invokes sys.ping', async () => {
    const mode = captureIo();
    expect(await runCli(['node', 'pinout', 'gpio', 'mode', '4', 'pullup', '--mock'], mode)).toBe(0);
    expect(mode.logs.join('\n')).toContain('mode');

    const ping = captureIo();
    expect(
      await runCli(['node', 'pinout', 'exec', 'sys.ping', '--payload', '{}', '--mock'], ping),
    ).toBe(0);
    expect(ping.logs.join('\n')).toContain('pong');
  });

  it('discovers active runtime devices, capabilities, and tools as JSON', async () => {
    const inspect = captureIo();
    expect(await runCli(['node', 'pinout', '--json', 'runtime', 'inspect'], inspect)).toBe(0);
    const inspected = JSON.parse(inspect.logs[0] ?? '{}') as {
      devices: Array<{
        id: string;
        activeTransportKind: string;
        supportedTransportKinds: string[];
      }>;
    };
    expect(inspected.devices.map((device) => device.id)).toContain('esp32-01');
    expect(inspected.devices.find((device) => device.id === 'esp32-01')).toMatchObject({
      activeTransportKind: 'simulated-esp32',
      supportedTransportKinds: expect.arrayContaining(['serial']),
    });

    const capabilities = captureIo();
    expect(
      await runCli(
        ['node', 'pinout', '--json', 'runtime', 'capabilities', 'esp32-01'],
        capabilities,
      ),
    ).toBe(0);
    expect(JSON.parse(capabilities.logs[0] ?? '{}')).toMatchObject({
      devices: [{ deviceId: 'esp32-01' }],
    });

    const tools = captureIo();
    expect(await runCli(['node', 'pinout', '--json', 'runtime', 'tools', 'esp32-01'], tools)).toBe(
      0,
    );
    expect(
      JSON.parse(tools.logs[0] ?? '{}').tools.some((tool: { mcpName: string }) =>
        tool.mcpName.includes('gpio_write'),
      ),
    ).toBe(true);
  });

  it('requires explicit confirmation and reports best-effort emergency stop', async () => {
    const refused = captureIo();
    expect(await runCli(['node', 'pinout', 'runtime', 'emergency-stop'], refused)).toBe(1);
    expect(refused.errors.join('\n')).toMatch(/--yes|certified/i);

    const stopped = captureIo();
    expect(
      await runCli(
        ['node', 'pinout', '--json', 'runtime', 'emergency-stop', 'esp32-01', '--yes'],
        stopped,
      ),
    ).toBe(0);
    expect(JSON.parse(stopped.logs[0] ?? '{}')).toMatchObject({
      certified: false,
      bestEffort: true,
    });
  });
});

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (message: string) => {
      logs.push(message);
    },
    error: (message: string) => {
      errors.push(message);
    },
  };
}
