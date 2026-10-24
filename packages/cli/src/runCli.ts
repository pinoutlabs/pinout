import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import type { Device } from '@pinout/core';
import {
  DeviceInstance,
  esp32DefaultLedPin,
  listSerialPorts,
  PinoutRuntime,
  ProtocolDeviceBackend,
} from '@pinout/core';
import {
  registerDeviceCommands,
  registerModuleCommands,
  runConfiguredDevicesCommand,
  runInvokeCommand,
  runRuntimeStartCommand,
  runRuntimeInspection,
  runRuntimeCapabilities,
  runRuntimeTools,
  runEmergencyStop,
} from './pinoutHomeCommands.js';
import { registerGenerateCommands } from './generateCommands.js';
import {
  addConnectionOptions,
  openDevice,
  parseGpioMode,
  parseJsonObject,
  parseLevel,
  parsePin,
  parsePositiveInt,
  resolveConnectionOptions,
  type ConnectionFlags,
} from './connectionArgs.js';
import { runDoctor } from './doctor.js';
import { registerDaemonCommands } from './daemonCommands.js';
import { registerConnectorCommands } from './connectorCommands.js';
import { registerRecordCommands } from './recordCommands.js';
import { registerModuleIntegrityCommands } from './moduleIntegrityCommands.js';
import { registerRegistryCommands } from './registryCommands.js';
import { createOutput, type CliOutput } from './output.js';
import { esp32PinGroups } from './pinsTable.js';
import { readScriptFile, readScriptSteps, runScript } from './runScript.js';
import { registerDiscoverCommand } from './discoverCommand.js';
import { registerEnrollCommand } from './enrollCommand.js';

export interface CliIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

const defaultIo: CliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const packageVersion = readPackageVersion();

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const program = new Command();
  program
    .name('pinout')
    .description('Control hardware through the Pinout SDK.')
    .helpCommand(false)
    .option('--json', 'emit structured JSON output', false)
    .version(packageVersion, '-V, --version', 'print CLI version');

  program.exitOverride();
  program.configureOutput({
    writeOut: (str: string) => io.log(str.replace(/\n$/, '')),
    writeErr: (str: string) => io.error(str.replace(/\n$/, '')),
  });

  program
    .command('devices')
    .description('List configured/active Pinout runtime devices.')
    .action(async () => {
      await runConfiguredDevicesCommand(program, io, outputFor);
    });

  program
    .command('ports')
    .description('List discoverable serial ports on this machine.')
    .action(async () => {
      const output = outputFor(program, io);
      const ports = await listSerialPorts();
      if (output.json) {
        output.log({ ports });
        return;
      }
      if (ports.length === 0) {
        output.log('No serial ports found.');
        return;
      }
      for (const port of ports) {
        const extra = [port.manufacturer, port.serialNumber].filter(Boolean).join(', ');
        output.log(extra ? `${port.path}  (${extra})` : port.path);
      }
    });

  program
    .command('invoke')
    .description('Invoke a capability on a configured runtime device.')
    .argument('<deviceId>', 'device id')
    .argument('<capability>', 'capability name')
    .option('--payload <json>', 'JSON payload object', parseJsonObject, {})
    .action(
      async (
        deviceId: string,
        capability: string,
        options: { payload: Record<string, unknown> },
      ) => {
        await runInvokeCommand(program, deviceId, capability, options.payload, io, outputFor);
      },
    );

  registerModuleCommands(program, outputFor, io);
  registerDeviceCommands(program, outputFor, io);
  registerGenerateCommands(program, outputFor, io);
  registerDiscoverCommand(program, () => outputFor(program, io));
  registerEnrollCommand(program, outputFor, io);

  const runtime = program.command('runtime').description('Multi-device Pinout runtime commands.');

  runtime
    .command('start')
    .description('Bootstrap the runtime from ~/.pinout/devices.json and list active devices.')
    .action(async () => {
      await runRuntimeStartCommand(program, io, outputFor);
    });

  runtime
    .command('devices')
    .description('List registered devices (alias for pinout devices).')
    .action(async () => {
      await runConfiguredDevicesCommand(program, io, outputFor);
    });

  runtime
    .command('invoke')
    .description('Invoke a capability on a registered runtime device (alias for pinout invoke).')
    .argument('<deviceId>', 'registered device id')
    .argument('<capability>', 'capability name')
    .option('--payload <json>', 'JSON payload object', parseJsonObject, {})
    .action(
      async (
        deviceId: string,
        capability: string,
        options: { payload: Record<string, unknown> },
      ) => {
        await runInvokeCommand(program, deviceId, capability, options.payload, io, outputFor);
      },
    );

  runtime
    .command('inspect [deviceId]')
    .description('Inspect active runtime device identity, health, state, and capabilities.')
    .action(async (deviceId?: string) => runRuntimeInspection(program, deviceId, io, outputFor));
  runtime
    .command('capabilities [deviceId]')
    .description('List capabilities advertised by active runtime devices.')
    .action(async (deviceId?: string) => runRuntimeCapabilities(program, deviceId, io, outputFor));
  runtime
    .command('tools [deviceId]')
    .description('List agent-tool projections for active runtime devices.')
    .action(async (deviceId?: string) => runRuntimeTools(program, deviceId, io, outputFor));
  runtime
    .command('emergency-stop [deviceId]')
    .description(
      'Best-effort stop using only advertised stop capabilities (not a certified E-stop).',
    )
    .option('--yes', 'confirm the physical-output action')
    .action(async (deviceId: string | undefined, options: { yes?: boolean }) =>
      runEmergencyStop(program, deviceId, options.yes === true, io, outputFor),
    );

  registerDaemonCommands(program, () => outputFor(program, io));
  registerConnectorCommands(program, () => outputFor(program, io));
  registerRecordCommands(program, () => outputFor(program, io));
  registerModuleIntegrityCommands(findExistingCommand(program, 'module'), () =>
    outputFor(program, io),
  );
  registerRegistryCommands(findExistingCommand(program, 'module'), () => outputFor(program, io));

  program
    .command('doctor')
    .description(
      'Staged diagnostic: environment, daemon, serial discovery, firmware identity, and registry checks.',
    )
    .option('-p, --port <path>', 'serial port path to probe firmware identity')
    .option('-d, --device <id>', 'enrolled device id to probe firmware identity')
    .option('--mock', 'probe simulated ESP32 instead of serial hardware')
    .option('--no-daemon', 'skip daemon reachability check')
    .option('--url <url>', 'daemon base URL (overrides PINOUT_DAEMON_URL)')
    .option('--timeout <ms>', 'handshake and discovery timeout in ms', parsePositiveInt)
    .action(
      async (options: {
        port?: string;
        device?: string;
        mock?: boolean;
        daemon?: boolean;
        url?: string;
        timeout?: number;
      }) => {
        const output = outputFor(program, io);
        const code = await runDoctor(output, {
          port: options.port,
          device: options.device,
          mock: options.mock,
          daemon: options.daemon,
          url: options.url,
          timeoutMs: options.timeout,
          json: program.opts<{ json?: boolean }>().json ?? false,
        });
        if (code !== 0) {
          throw new DoctorFailedError();
        }
      },
    );

  program
    .command('pins')
    .description('Show ESP32 pin safety groups.')
    .action(() => {
      const output = outputFor(program, io);
      if (output.json) {
        output.log({ groups: esp32PinGroups });
        return;
      }
      for (const group of esp32PinGroups) {
        output.log(`${group.label}: ${group.pins.join(', ')}`);
        output.log(`  ${group.note}`);
      }
    });

  addDeviceCommand(
    program.command('hello').description('Connect, handshake, and print device capabilities.'),
  ).action(async (options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      await printHello(device, output);
    });
  });

  addDeviceCommand(
    program
      .command('exec <action>')
      .description('Invoke an action on a directly connected device (single-device mode).')
      .option('--payload <json>', 'action payload object', parseJsonObject, {}),
  ).action(
    async (action: string, options: ConnectionFlags & { payload: Record<string, unknown> }) => {
      const output = outputFor(program, io);
      await withDevice(options, async (device) => {
        const result = await governedInvoke(device, action, options.payload);
        if (output.json) {
          output.log({ action, result });
          return;
        }
        output.log(JSON.stringify(result, null, 2));
      });
    },
  );

  addDeviceCommand(
    program
      .command('run [file]')
      .description('Run a JSON or NDJSON action script on one persistent connection.')
      .option('--script <text>', 'inline script text instead of a file'),
  ).action(async (file: string | undefined, options: ConnectionFlags & { script?: string }) => {
    const output = outputFor(program, io);
    const steps = file
      ? await readScriptFile(file)
      : options.script
        ? await readScriptSteps(options.script)
        : await readScriptFromStdin();

    await withDevice(options, async (device) => {
      const results = await runScript(
        { invoke: (action, payload) => governedInvoke(device, action, payload) },
        steps,
      );
      if (output.json) {
        output.log({ results });
        return;
      }
      for (const entry of results) {
        output.log(`${entry.action}: ${JSON.stringify(entry.result)}`);
      }
    });
  });

  addDeviceCommand(
    program
      .command('blink')
      .description('Blink a GPIO pin using one persistent connection.')
      .option('--pin <number>', 'GPIO pin to blink', parsePin, esp32DefaultLedPin)
      .option('--count <n>', 'number of blinks', parsePositiveInt, 1)
      .option('--delay <ms>', 'milliseconds per half-cycle', parsePositiveInt, 500),
  ).action(async (options: ConnectionFlags & { pin: number; count: number; delay: number }) => {
    const output = outputFor(program, io);
    const connection = resolveConnectionOptions(options);
    const halfDelay = connection.mock ? Math.min(options.delay, 50) : options.delay;
    await withDevice(options, async (device) => {
      if (device.supports('sys.arm')) {
        await governedInvoke(device, 'sys.arm', {});
      }
      for (let index = 0; index < options.count; index += 1) {
        await governedInvoke(device, 'gpio.write', { pin: options.pin, value: true });
        await delay(halfDelay);
        await governedInvoke(device, 'gpio.write', { pin: options.pin, value: false });
        if (index < options.count - 1) {
          await delay(halfDelay);
        }
      }
      if (output.json) {
        output.log({ pin: options.pin, count: options.count, delayMs: options.delay });
        return;
      }
      output.log(`blinked gpio ${options.pin} ${options.count} time(s)`);
    });
  });

  const gpio = program.command('gpio').description('GPIO operations.');

  addDeviceCommand(
    gpio
      .command('write')
      .description('Drive a pin high or low.')
      .argument('<pin>', 'GPIO pin number', parsePin)
      .argument('<value>', 'high|low|true|false|1|0', parseLevel),
  ).action(async (pin: number, value: boolean, options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      const result = await governedInvoke(device, 'gpio.write', { pin, value });
      printInvokeResult(output, 'gpio.write', result, `gpio ${pin} -> ${value ? 'high' : 'low'}`);
    });
  });

  addDeviceCommand(
    gpio
      .command('read')
      .description('Read a pin level.')
      .argument('<pin>', 'GPIO pin number', parsePin),
  ).action(async (pin: number, options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      const result = await governedInvoke(device, 'gpio.read', { pin });
      const value = result.value === true;
      printInvokeResult(output, 'gpio.read', result, value ? 'high' : 'low');
    });
  });

  addDeviceCommand(
    gpio
      .command('mode')
      .description('Set pin mode (input, output, pullup, pulldown).')
      .argument('<pin>', 'GPIO pin number', parsePin)
      .argument('<mode>', 'input|output|pullup|pulldown', parseGpioMode),
  ).action(async (pin: number, mode: string, options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      const result = await governedInvoke(device, 'gpio.mode', { pin, mode });
      printInvokeResult(output, 'gpio.mode', result, `gpio ${pin} mode -> ${mode}`);
    });
  });

  addDeviceCommand(
    gpio
      .command('toggle')
      .description('Toggle a pin level.')
      .argument('<pin>', 'GPIO pin number', parsePin),
  ).action(async (pin: number, options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      const result = await governedInvoke(device, 'gpio.toggle', { pin });
      printInvokeResult(output, 'gpio.toggle', result, `gpio ${pin} toggled`);
    });
  });

  addDeviceCommand(
    gpio
      .command('pulse')
      .description('Drive a pin to a level for a duration, then restore the previous level.')
      .argument('<pin>', 'GPIO pin number', parsePin)
      .argument('<value>', 'high|low|true|false|1|0', parseLevel)
      .option('--duration <ms>', 'milliseconds at the driven level', parsePositiveInt, 500),
  ).action(async (pin: number, value: boolean, options: ConnectionFlags & { duration: number }) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      if (!output.json) {
        output.log(`pulsing gpio ${pin} ${value ? 'high' : 'low'} for ${options.duration}ms`);
      }
      const result = await governedInvoke(device, 'gpio.pulse', {
        pin,
        value,
        durationMs: options.duration,
      });
      printInvokeResult(
        output,
        'gpio.pulse',
        result,
        `gpio ${pin} pulsed ${value ? 'high' : 'low'} for ${options.duration}ms`,
      );
    });
  });

  addDeviceCommand(
    gpio
      .command('pwm')
      .description('Start or update PWM on a pin.')
      .requiredOption('--pin <number>', 'GPIO pin number', parsePin)
      .requiredOption('--duty <ratio>', 'duty cycle 0..1', parseDuty)
      .option('--channel <n>', 'PWM channel', parsePin, 0)
      .option('--frequency <hz>', 'PWM frequency in Hz', parsePositiveInt, 1000),
  ).action(
    async (
      options: ConnectionFlags & { pin: number; duty: number; channel: number; frequency: number },
    ) => {
      const output = outputFor(program, io);
      await withDevice(options, async (device) => {
        const result = await governedInvoke(device, 'gpio.pwm', {
          pin: options.pin,
          duty: options.duty,
          channel: options.channel,
          frequency: options.frequency,
        });
        printInvokeResult(
          output,
          'gpio.pwm',
          result,
          `gpio ${options.pin} pwm duty ${options.duty}`,
        );
      });
    },
  );

  addDeviceCommand(
    gpio
      .command('analog')
      .description('Read an ADC pin.')
      .argument('<pin>', 'ADC-capable GPIO pin number', parsePin),
  ).action(async (pin: number, options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      const result = await governedInvoke(device, 'gpio.analogRead', { pin });
      printInvokeResult(
        output,
        'gpio.analogRead',
        result,
        `gpio ${pin} analog ${String(result.value)}`,
      );
    });
  });

  addDeviceCommand(
    gpio
      .command('watch')
      .description('Watch a pin for changes.')
      .argument('<pin>', 'GPIO pin number', parsePin),
  ).action(async (pin: number, options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      const result = await governedInvoke(device, 'gpio.watch', { pin });
      printInvokeResult(output, 'gpio.watch', result, `watching gpio ${pin}`);
    });
  });

  addDeviceCommand(
    gpio
      .command('unwatch')
      .description('Stop watching a pin.')
      .argument('<pin>', 'GPIO pin number', parsePin),
  ).action(async (pin: number, options: ConnectionFlags) => {
    const output = outputFor(program, io);
    await withDevice(options, async (device) => {
      const result = await governedInvoke(device, 'gpio.unwatch', { pin });
      printInvokeResult(output, 'gpio.unwatch', result, `stopped watching gpio ${pin}`);
    });
  });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (isCommanderHelp(error)) {
      return 0;
    }
    io.error(formatError(error));
    return 1;
  }
}

function addDeviceCommand(command: Command): Command {
  return addConnectionOptions(command);
}

function outputFor(program: Command, io: CliIo): CliOutput {
  return createOutput(io, program.opts<{ json?: boolean }>().json ?? false);
}

async function withDevice(
  flags: ConnectionFlags,
  task: (device: Device) => Promise<void>,
): Promise<void> {
  const options = resolveConnectionOptions(flags);
  const device = await openDevice(options);
  const runtime = new PinoutRuntime();
  const instance = new DeviceInstance({
    identity: {
      id: 'direct-device',
      moduleId: 'pinout/esp32',
      deviceClass: 'microcontroller',
      vendor: 'Espressif',
      model: device.info.firmware,
    },
    backend: new ProtocolDeviceBackend(device),
    capabilities: device.capabilities,
    policies: [],
    simulated: options.mock === true,
    activeTransportKind: options.mock ? 'simulated-esp32' : 'serial',
    transportKinds: [options.mock ? 'simulated-esp32' : 'serial'],
    getOperationalState: () => ({
      firmware: device.info.firmware,
      version: device.info.version,
      protocol: device.info.protocol,
    }),
  });
  await runtime.register(instance);
  directRuntimes.set(device, runtime);
  try {
    await task(device);
  } finally {
    directRuntimes.delete(device);
    await runtime.close();
  }
}

const directRuntimes = new WeakMap<Device, PinoutRuntime>();

async function governedInvoke(
  device: Device,
  capability: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const runtime = directRuntimes.get(device);
  if (!runtime) throw new Error('Direct device is not attached to a governed runtime.');
  return runtime.invoke('direct-device', capability, payload, { owner: 'cli-direct' });
}

async function printHello(device: Device, output: CliOutput): Promise<void> {
  const info = device.supports('sys.info') ? await governedInvoke(device, 'sys.info') : {};
  if (output.json) {
    output.log({
      firmware: device.info.firmware,
      version: device.info.version,
      protocol: device.info.protocol,
      capabilities: device.capabilities,
      info,
    });
    return;
  }

  output.log(`firmware    ${device.info.firmware} ${device.info.version}`);
  output.log(`protocol    v${device.info.protocol}`);
  if (typeof info.uptimeMs === 'number') {
    output.log(`uptime      ${info.uptimeMs}ms`);
  }
  if (typeof info.freeHeap === 'number') {
    output.log(`free heap   ${info.freeHeap}`);
  }
  output.log('capabilities');
  for (const capability of device.capabilities) {
    const safety = capability.safety.physicalOutput ? 'physical-output' : 'read-only';
    output.log(`  ${capability.name}  (${safety})  ${capability.description}`);
  }
}

function printInvokeResult(
  output: CliOutput,
  action: string,
  result: Record<string, unknown>,
  summary: string,
): void {
  if (output.json) {
    output.log({ action, result });
    return;
  }
  output.log(summary);
}

function parseDuty(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('Duty must be a number between 0 and 1.');
  }
  return parsed;
}

async function readScriptFromStdin(): Promise<Awaited<ReturnType<typeof readScriptSteps>>> {
  if (process.stdin.isTTY) {
    throw new Error('Provide a script file, --script text, or pipe NDJSON on stdin.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return readScriptSteps(Buffer.concat(chunks).toString('utf8'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findExistingCommand(program: Command, name: string): Command {
  const found = program.commands.find((command) => command.name() === name);
  if (!found) {
    throw new Error(`Internal error: command '${name}' is not registered yet.`);
  }
  return found;
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packagePath = join(here, '..', 'package.json');
  const raw = readFileSync(packagePath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '0.0.0';
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isCommanderHelp(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'commander.helpDisplayed' ||
      error.code === 'commander.help' ||
      error.code === 'commander.version')
  );
}

class DoctorFailedError extends Error {
  constructor() {
    super('Doctor checks failed.');
    this.name = 'DoctorFailedError';
  }
}
