import {
  addDeviceDefinition,
  createRuntimeFromConfig,
  formatConformanceReport,
  inspectDeviceDefinition,
  inspectInstalledModule,
  installModuleFromPath,
  listAvailableModules,
  readDevicesFile,
  removeDeviceDefinition,
  resolvePinoutHome,
  runModuleConformance,
  uninstallModule,
  runtimeToAgentTools,
  type DeviceDefinition,
} from '@pinout/core';
import type { CliIo } from './runCli.js';
import type { CliOutput } from './output.js';
import { scaffoldModule } from './moduleScaffold.js';
import { parseJsonObject } from './connectionArgs.js';
import type { Command } from 'commander';

export function registerModuleCommands(
  program: Command,
  outputFor: (program: Command, io: CliIo) => CliOutput,
  io: CliIo,
): void {
  const modules = program.command('module').description('Manage Pinout hardware modules.');

  modules
    .command('create')
    .description('Scaffold a new external Pinout module.')
    .argument('<name>', 'module directory name')
    .action((name: string) => {
      const output = outputFor(program, io);
      const root = scaffoldModule({ name });
      output.log(`Created module scaffold at ${root}`);
    });

  modules
    .command('test')
    .description('Run Pinout module conformance checks.')
    .argument('<path>', 'path to module directory')
    .action(async (modulePath: string) => {
      const output = outputFor(program, io);
      const result = await runModuleConformance(modulePath);
      output.log(formatConformanceReport(result));
      if (!result.passed) {
        process.exitCode = 1;
      }
    });

  modules
    .command('install')
    .description(
      'Install a module. Without --registry: copy a built module directory into the local Pinout registry (~/.pinout). With --registry: install name[@version] from a registry index.',
    )
    .argument('<path>', 'path to built module directory, or name[@version] with --registry')
    .option('--registry <source>', 'registry directory, index file, or https URL')
    .option('--out <dir>', 'install directory for registry installs (default <PINOUT_HOME>/registry-modules)')
    .option('--require-signature', 'refuse unsigned or unverifiable registry entries')
    .option(
      '--allow-publisher <spec>',
      'trusted publisher key: id=path/to/public.pem or path/to/public.pem (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--force', 'replace an existing installation')
    .option('--allow-candidate', 'install a generated candidate after reviewing it')
    .option('--downgrade', 'allow replacing an installed module with a lower version')
    .action(
      async (
        modulePath: string,
        options: {
          force?: boolean;
          allowCandidate?: boolean;
          downgrade?: boolean;
          registry?: string;
          out?: string;
          requireSignature?: boolean;
          allowPublisher?: string[];
        },
      ) => {
        const output = outputFor(program, io);
        if (options.registry !== undefined) {
          const { runRegistryInstallCommand } = await import('./registryCommands.js');
          await runRegistryInstallCommand(
            modulePath,
            {
              registry: options.registry,
              force: options.force === true,
              ...(options.out !== undefined ? { out: options.out } : {}),
              ...(options.requireSignature === true ? { requireSignature: true } : {}),
              ...(options.allowPublisher !== undefined
                ? { allowPublisher: options.allowPublisher }
                : {}),
            },
            output,
          );
          return;
        }
        const installOptions: {
          force?: boolean;
          home?: string;
          allowCandidate?: boolean;
          downgrade?: boolean;
        } = {};
        if (options.force) {
          installOptions.force = true;
        }
        if (options.allowCandidate) installOptions.allowCandidate = true;
        if (options.downgrade) installOptions.downgrade = true;
        const record = await installModuleFromPath(modulePath, installOptions);
        output.log(`Installed ${record.id}@${record.version} → ${record.installPath}`);
      },
    );

  modules
    .command('uninstall')
    .description('Remove an installed module.')
    .argument('<moduleId>', 'module id')
    .action(async (moduleId: string) => {
      const output = outputFor(program, io);
      uninstallModule(moduleId);
      output.log(`Uninstalled ${moduleId}`);
    });

  modules
    .command('list')
    .description('List built-in and installed modules.')
    .action(() => {
      const output = outputFor(program, io);
      const entries = listAvailableModules();
      if (output.json) {
        output.log({ modules: entries });
        return;
      }
      output.log(`${'MODULE'.padEnd(32)} VERSION   CLASS`);
      for (const entry of entries) {
        output.log(`${entry.id.padEnd(32)} ${entry.version.padEnd(9)} ${entry.deviceClass}`);
      }
    });

  modules
    .command('inspect')
    .description('Inspect an installed module.')
    .argument('<moduleId>', 'module id')
    .action((moduleId: string) => {
      const output = outputFor(program, io);
      try {
        const record = inspectInstalledModule(moduleId);
        output.log(record);
      } catch {
        const entries = listAvailableModules();
        const builtin = entries.find(
          (entry) => entry.id === moduleId && entry.source === 'builtin',
        );
        if (builtin) {
          output.log({ ...builtin, builtin: true });
          return;
        }
        throw new Error(`Module '${moduleId}' is not installed.`);
      }
    });
}

export function registerDeviceCommands(
  program: Command,
  outputFor: (program: Command, io: CliIo) => CliOutput,
  io: CliIo,
): void {
  const devices = program.command('device').description('Manage configured Pinout devices.');

  devices
    .command('add')
    .description('Add a device to the local registry.')
    .argument('<id>', 'stable device id')
    .requiredOption('--module <moduleId>', 'Pinout module id')
    .option('--label <label>', 'human-readable label')
    .option('--config <json>', 'backend config JSON', parseJsonObject, {})
    .option('--simulated', 'use simulated backend')
    .action(
      (
        id: string,
        options: {
          module: string;
          label?: string;
          config: Record<string, unknown>;
          simulated?: boolean;
        },
      ) => {
        const output = outputFor(program, io);
        const definition: DeviceDefinition = {
          id,
          module: resolveModuleId(options.module),
          config: options.config,
        };
        if (options.label) {
          definition.label = options.label;
        }
        if (options.simulated) {
          definition.backend = { type: 'simulated' };
        }
        addDeviceDefinition(definition);
        output.log(`Added device ${id} (${definition.module})`);
      },
    );

  devices
    .command('remove')
    .description('Remove a configured device.')
    .argument('<id>', 'device id')
    .action((id: string) => {
      const output = outputFor(program, io);
      removeDeviceDefinition(id);
      output.log(`Removed device ${id}`);
    });

  devices
    .command('list')
    .description('List configured devices from ~/.pinout/devices.json.')
    .action(() => {
      const output = outputFor(program, io);
      const file = readDevicesFile();
      if (output.json) {
        output.log(file);
        return;
      }
      if (file.devices.length === 0) {
        output.log(
          'No devices configured. Use `pinout device add` or edit ~/.pinout/devices.json.',
        );
        return;
      }
      output.log(`${'ID'.padEnd(20)} MODULE`);
      for (const device of file.devices) {
        output.log(`${device.id.padEnd(20)} ${device.module}`);
      }
    });

  devices
    .command('inspect')
    .description('Inspect a configured device.')
    .argument('<id>', 'device id')
    .action((id: string) => {
      const output = outputFor(program, io);
      output.log(inspectDeviceDefinition(id));
    });
}

export async function runConfiguredDevicesCommand(
  program: Command,
  io: CliIo,
  outputFor: (program: Command, io: CliIo) => CliOutput,
): Promise<void> {
  const output = outputFor(program, io);
  const { runtime, errors } = await createRuntimeFromConfig({
    continueOnError: true,
    includeDemoDefaults: readDevicesFile().devices.length === 0,
  });
  try {
    const devices = runtime.devices();
    if (output.json) {
      output.log({
        devices,
        errors: errors.map(({ deviceId, error }) => ({ deviceId, error: String(error) })),
      });
      return;
    }
    if (devices.length === 0) {
      output.log('No active devices. Configure devices with `pinout device add`.');
      return;
    }
    output.log(`${'ID'.padEnd(20)} ${'CLASS'.padEnd(28)} STATUS`);
    for (const device of devices) {
      output.log(`${device.id.padEnd(20)} ${device.deviceClass.padEnd(28)} ${device.lifecycle}`);
    }
    for (const failure of errors) {
      io.error(`Warning: failed to start '${failure.deviceId}': ${String(failure.error)}`);
    }
  } finally {
    await runtime.close();
  }
}

export async function runInvokeCommand(
  program: Command,
  deviceId: string,
  capability: string,
  payload: Record<string, unknown>,
  io: CliIo,
  outputFor: (program: Command, io: CliIo) => CliOutput,
): Promise<void> {
  const output = outputFor(program, io);
  const { runtime } = await createRuntimeFromConfig({
    continueOnError: true,
    includeDemoDefaults: readDevicesFile().devices.length === 0,
  });
  try {
    const result = await runtime.invoke(deviceId, capability, payload);
    output.log(result);
  } finally {
    await runtime.close();
  }
}

export async function runRuntimeStartCommand(
  program: Command,
  io: CliIo,
  outputFor: (program: Command, io: CliIo) => CliOutput,
): Promise<void> {
  const output = outputFor(program, io);
  const { runtime, errors } = await createRuntimeFromConfig({
    continueOnError: true,
    includeDemoDefaults: true,
  });
  const devices = runtime.devices();
  if (output.json) {
    output.log({
      home: resolvePinoutHome(),
      devices,
      errors: errors.map(({ deviceId, error }) => ({ deviceId, message: String(error) })),
    });
  } else {
    output.log(`Pinout home: ${resolvePinoutHome()}`);
    output.log(`Started runtime with ${devices.length} device(s).`);
    for (const device of devices) {
      output.log(`  ${device.id} (${device.deviceClass})`);
    }
    for (const failure of errors) {
      output.log(`  warning: ${failure.deviceId} failed (${String(failure.error)})`);
    }
  }
  await runtime.close();
}

function resolveModuleId(input: string): string {
  if (input.includes('/')) {
    return input;
  }
  const matches = listAvailableModules().filter(
    (entry) => entry.id.startsWith(`${input}/`) || entry.id === input,
  );
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  return `${input}/thermometer`;
}

type RuntimeSelection = Awaited<ReturnType<typeof createRuntimeFromConfig>>;

async function openConfiguredRuntime(): Promise<RuntimeSelection> {
  return createRuntimeFromConfig({
    continueOnError: true,
    includeDemoDefaults: readDevicesFile().devices.length === 0,
  });
}

function selectRuntimeDevices(runtime: RuntimeSelection['runtime'], deviceId?: string) {
  if (!deviceId) return runtime.devices().map((summary) => runtime.getDevice(summary.id));
  return [runtime.getDevice(deviceId)];
}

export async function runRuntimeInspection(
  program: Command,
  deviceId: string | undefined,
  io: CliIo,
  outputFor: (program: Command, io: CliIo) => CliOutput,
): Promise<void> {
  const output = outputFor(program, io);
  const { runtime, errors } = await openConfiguredRuntime();
  try {
    const devices = selectRuntimeDevices(runtime, deviceId).map((device) => ({
      ...device.identity,
      health: device.getHealth(),
      simulated: device.simulated,
      activeTransportKind: device.activeTransportKind,
      supportedTransportKinds: device.transportKinds,
      operationalState: device.getOperationalStateSnapshot(),
      capabilities: device.capabilities,
    }));
    if (output.json)
      output.log({
        devices,
        startupErrors: errors.map(({ deviceId: id, error }) => ({
          deviceId: id,
          error: String(error),
        })),
      });
    else {
      for (const device of devices) {
        output.log(
          `${device.id}  ${device.deviceClass}  ${device.health.lifecycle}  ${device.simulated ? 'simulated' : 'physical'}`,
        );
        output.log(`  module       ${device.moduleId}`);
        output.log(`  transport    ${device.activeTransportKind}`);
        output.log(`  supported    ${device.supportedTransportKinds.join(', ') || 'unknown'}`);
        output.log(`  capabilities ${device.capabilities.length}`);
      }
      for (const failure of errors)
        io.error(`Warning: failed to start '${failure.deviceId}': ${String(failure.error)}`);
    }
  } finally {
    await runtime.close();
  }
}

export async function runRuntimeCapabilities(
  program: Command,
  deviceId: string | undefined,
  io: CliIo,
  outputFor: (program: Command, io: CliIo) => CliOutput,
): Promise<void> {
  const output = outputFor(program, io);
  const { runtime } = await openConfiguredRuntime();
  try {
    const devices = selectRuntimeDevices(runtime, deviceId).map((device) => ({
      deviceId: device.id,
      capabilities: device.capabilities,
    }));
    if (output.json) output.log({ devices });
    else
      for (const device of devices) {
        output.log(device.deviceId);
        for (const capability of device.capabilities)
          output.log(
            `  ${capability.name}  [${capability.safety.physicalOutput ? 'physical-output' : 'read-only'}]  ${capability.description}`,
          );
      }
  } finally {
    await runtime.close();
  }
}

export async function runRuntimeTools(
  program: Command,
  deviceId: string | undefined,
  io: CliIo,
  outputFor: (program: Command, io: CliIo) => CliOutput,
): Promise<void> {
  const output = outputFor(program, io);
  const { runtime } = await openConfiguredRuntime();
  try {
    const tools = runtimeToAgentTools(runtime).filter(
      (tool) => !deviceId || tool.deviceId === deviceId,
    );
    output.log(
      output.json
        ? { tools }
        : tools.map((tool) => `${tool.mcpName}  ${tool.description}`).join('\n'),
    );
  } finally {
    await runtime.close();
  }
}

const STOP_CAPABILITIES = [
  'gpio.stopAll',
  'motor.stop',
  'motion.stop',
  'drive.stop',
  'stepper.stop',
  'pump.stop',
  'experiment.stop',
];

export async function runEmergencyStop(
  program: Command,
  deviceId: string | undefined,
  confirmed: boolean,
  io: CliIo,
  outputFor: (program: Command, io: CliIo) => CliOutput,
): Promise<void> {
  if (!confirmed)
    throw new Error(
      'Refusing emergency stop without --yes. This is best-effort and is not a certified E-stop.',
    );
  const output = outputFor(program, io);
  const { runtime } = await openConfiguredRuntime();
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const device of selectRuntimeDevices(runtime, deviceId)) {
      const actions = STOP_CAPABILITIES.filter((capability) => device.supports(capability));
      if (actions.length === 0) {
        results.push({ deviceId: device.id, status: 'unsupported', actions: [] });
        continue;
      }
      for (const action of actions) {
        try {
          results.push({
            deviceId: device.id,
            action,
            status: 'stopped',
            result: await runtime.invoke(device.id, action, {}, { owner: 'cli-estop' }),
          });
        } catch (error) {
          results.push({ deviceId: device.id, action, status: 'failed', error: String(error) });
        }
      }
    }
    output.log(
      output.json
        ? { certified: false, bestEffort: true, results }
        : results
            .map(
              (result) =>
                `${result.deviceId}  ${result.action ?? '-'}  ${result.status}${result.error ? `  ${result.error}` : ''}`,
            )
            .join('\n'),
    );
    if (results.some((result) => result.status === 'failed'))
      throw new Error(
        'Emergency stop incomplete: one or more advertised stop capabilities failed.',
      );
  } finally {
    await runtime.close();
  }
}
