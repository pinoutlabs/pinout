import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import {
  addDeviceDefinition,
  connect,
  listSerialPorts,
  serialPort,
  simulatedEsp32,
  resolvePinoutHome,
} from '@pinout/core';
import { runDiscovery, serialDiscoveryPlugin, type DiscoveredCandidate } from '@pinout/discovery';
import type { CliIo } from './runCli.js';
import type { CliOutput } from './output.js';

export function registerEnrollCommand(
  program: Command,
  outputFor: (program: Command, io: CliIo) => CliOutput,
  io: CliIo,
): void {
  program
    .command('enroll')
    .description('Capture and confirm a device identity, then add it to the local registry.')
    .argument('[candidate]', 'discovery candidate id (or serial path)')
    .requiredOption('--id <name>', 'stable local device id')
    .option('--port <path>', 'serial port path (bypasses discovery)')
    .option('--mock', 'enroll the deterministic simulator')
    .option('--baud <rate>', 'serial baud rate', '115200')
    .option('--timeout <ms>', 'handshake timeout', '5000')
    .option('--yes', 'confirm enrollment without prompting')
    .option('--re-enroll', 'replace an existing device with the same id')
    .action(async (candidateArg: string | undefined, options: EnrollOptions) => {
      const output = outputFor(program, io);
      const port = await resolvePort(candidateArg, options);
      const device = options.mock
        ? await connect({ transport: simulatedEsp32(), timeoutMs: Number(options.timeout) })
        : await connect({
            transport: serialPort({ path: port as string, baudRate: Number(options.baud) }),
            timeoutMs: Number(options.timeout),
          });
      try {
        const portInfo = options.mock
          ? undefined
          : (await listSerialPorts()).find((entry) => entry.path === port);
        const identity = {
          firmware: device.info.firmware,
          version: device.info.version,
          protocol: device.info.protocol,
          capabilities: [...device.info.capabilities],
          ...(portInfo?.serialNumber ? { usbSerial: portInfo.serialNumber } : {}),
          ...(portInfo?.vendorId ? { vid: portInfo.vendorId } : {}),
          ...(portInfo?.productId ? { pid: portInfo.productId } : {}),
        };
        const summary = { id: options.id, port: port ?? 'simulated', identity };
        if (!options.yes) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error('Enrollment requires --yes when stdin/stdout is non-interactive.');
          }
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await prompt.question(`Enroll ${options.id} with this identity? [y/N] `);
            if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('Enrollment cancelled.');
          } finally {
            prompt.close();
          }
        }
        const definition = {
          id: options.id,
          module: device.info.boardId ? 'pinout/board' : 'pinout/esp32',
          backend: options.mock
            ? ({ type: 'protocol', transport: { type: 'simulated-esp32' as const } } as const)
            : ({
                type: 'protocol',
                transport: {
                  type: 'serial' as const,
                  path: port as string,
                  baud: Number(options.baud),
                },
              } as const),
          identity,
          enrolledAt: new Date().toISOString(),
        };
        // Re-enrollment is explicit and only replaces the named id.
        if (options.reEnroll) {
          const { readDevicesFile, writeDevicesFile } = await import('@pinout/core');
          const file = readDevicesFile(undefined, resolvePinoutHome());
          const existing = file.devices.findIndex((entry) => entry.id === options.id);
          if (existing < 0) throw new Error(`Cannot re-enroll unknown device '${options.id}'.`);
          file.devices[existing] = definition;
          writeDevicesFile(file, undefined, resolvePinoutHome());
        } else {
          addDeviceDefinition(definition, { home: resolvePinoutHome() });
        }
        output.log(
          output.json
            ? { enrolled: true, device: summary }
            : `Enrolled ${options.id} (${identity.firmware} ${identity.version}).`,
        );
      } finally {
        await device.close();
      }
    });
}

interface EnrollOptions {
  id: string;
  port?: string;
  mock?: boolean;
  baud: string;
  timeout: string;
  yes?: boolean;
  reEnroll?: boolean;
}

async function resolvePort(
  candidateArg: string | undefined,
  options: EnrollOptions,
): Promise<string | undefined> {
  if (options.mock) return undefined;
  if (options.port) return options.port;
  if (!candidateArg) throw new Error('Provide a discovery candidate, --port, or --mock.');
  const ports = await listSerialPorts();
  if (ports.some((port) => port.path === candidateArg)) return candidateArg;
  const run = await runDiscovery({ plugins: [serialDiscoveryPlugin()] });
  const candidate: DiscoveredCandidate | undefined = run.candidates.find(
    (entry) => entry.id === candidateArg,
  );
  if (!candidate) throw new Error(`Discovery candidate '${candidateArg}' was not found.`);
  if (candidate.endpoint.kind !== 'serial')
    throw new Error('Only serial candidates can be enrolled by this command.');
  return candidate.endpoint.address;
}
