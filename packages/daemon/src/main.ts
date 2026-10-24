#!/usr/bin/env node
import { BoardDiscovery } from './boardDiscovery.js';
/**
 * pinoutd CLI entry point.
 *
 * Usage:
 *   pinoutd [--port 8787] [--host 127.0.0.1] [--token <t>] [--journal <path>]
 *   pinoutd --discover [--mock-devices <file|preset>] [--network-probe host:port]
 *
 * Binds loopback only unless --host and --token are both provided explicitly.
 * `--discover` enables read-only awareness (serial/usb/ble/mdns). Network probe
 * stays opt-in. `--mock-devices` injects SIMULATED candidates (no hardware).
 */
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createRuntimeFromConfig,
  PINOUT_VERSION,
  resolvePinoutHome,
  readDevicesFile,
} from '@pinout/core';
import { startDaemon } from './start.js';
import { DEFAULT_DAEMON_PORT, type DaemonConfig } from './httpServer.js';
import { AwarenessService } from './awareness/service.js';

interface ParsedArgs {
  port: number;
  host: string | undefined;
  token: string | undefined;
  journalPath: string | undefined;
  demo: boolean;
  discover: boolean;
  allowRemote: boolean;
  mockDevices: string | undefined;
  networkProbes: Array<{ host: string; port: number }>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    port: DEFAULT_DAEMON_PORT,
    host: undefined,
    token: undefined,
    journalPath: undefined,
    demo: false,
    discover: false,
    allowRemote: false,
    mockDevices: undefined,
    networkProbes: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--port':
        args.port = Number.parseInt(next ?? '', 10);
        i += 1;
        break;
      case '--host':
        args.host = next;
        i += 1;
        break;
      case '--token':
        args.token = next;
        i += 1;
        break;
      case '--journal':
        args.journalPath = next;
        i += 1;
        break;
      case '--discover':
        args.discover = true;
        break;
      case '--mock-devices':
        args.mockDevices = next;
        args.discover = true;
        i += 1;
        break;
      case '--network-probe': {
        // Opt-in bounded probe: host:port (repeatable). Never a subnet scan.
        if (!next || !next.includes(':')) {
          throw new Error('--network-probe requires host:port');
        }
        const [host, portText] = next.split(':');
        const port = Number.parseInt(portText ?? '', 10);
        if (!host || !Number.isFinite(port)) {
          throw new Error(`Invalid --network-probe '${next}' (expected host:port)`);
        }
        args.networkProbes.push({ host, port });
        i += 1;
        break;
      }
      case '--demo':
        args.demo = true;
        break;
      case '--allow-remote':
        args.allowRemote = true;
        break;
      default:
        break;
    }
  }
  return args;
}

interface PersistedDaemonConfig {
  token?: string;
  safetyRules?: DaemonConfig['safetyRules'];
}

async function loadPersistedConfig(): Promise<{
  config: PersistedDaemonConfig;
  generated: boolean;
  path: string;
}> {
  const dir = resolvePinoutHome();
  const path = join(dir, 'pinoutd.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PersistedDaemonConfig;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed.token !== undefined && typeof parsed.token !== 'string')
    ) {
      throw new Error('pinoutd.json must contain a string token.');
    }
    return { config: parsed, generated: false, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
    return { config: { token }, generated: true, path };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const persisted = await loadPersistedConfig();
  const pinoutHome = resolvePinoutHome();
  const defaultJournalDir = join(pinoutHome, 'journal');
  await mkdir(defaultJournalDir, { recursive: true, mode: 0o700 });
  const { runtime, errors } = await createRuntimeFromConfig({
    includeDemoDefaults: args.demo,
    continueOnError: true,
  });

  const journalPath = args.journalPath ?? join(defaultJournalDir, 'pinoutd.jsonl');

  // Awareness runs whenever --discover or --mock-devices is set. Discovery is
  // read-only; BoardDiscovery (serial open/handshake) remains a separate opt-in
  // for bridge attachment and is NOT the awareness path.
  const awareness =
    args.discover || args.mockDevices
      ? new AwarenessService({
          home: pinoutHome,
          ...(args.mockDevices ? { mockDevices: args.mockDevices } : {}),
          ...(args.networkProbes.length > 0
            ? {
                network: {
                  enabled: true,
                  endpoints: args.networkProbes.map((endpoint) => ({
                    ...endpoint,
                    probe: 'pinout-daemon' as const,
                  })),
                },
              }
            : {}),
          log: (message) => process.stderr.write(`${message}\n`),
        })
      : undefined;

  const daemon = await startDaemon(runtime, {
    ...(args.host ? { host: args.host } : {}),
    port: args.port,
    ...(args.token ? { token: args.token } : {}),
    ...(!args.token ? { token: persisted.config.token } : {}),
    ...(args.allowRemote ? { allowRemote: true } : {}),
    journalPath,
    ...(persisted.config.safetyRules ? { safetyRules: persisted.config.safetyRules } : {}),
    ...(awareness ? { awareness } : {}),
  });

  for (const failure of errors)
    process.stderr.write(`Device ${failure.deviceId}: ${String(failure.error)}\n`);

  // Legacy BoardDiscovery: opens serial and attaches esp32/uno bridges. Kept
  // behind --discover for compatibility but awareness covers observation.
  // Skip when --mock-devices is the only goal (no hardware open).
  const boardDiscovery =
    args.discover && !args.mockDevices
      ? new BoardDiscovery(runtime, {
          excludedPaths: readDevicesFile().devices.flatMap((d) =>
            d.backend?.transport?.path ? [d.backend.transport.path] : [],
          ),
          log: (message) => process.stderr.write(`${message}\n`),
        })
      : undefined;
  await boardDiscovery?.start();

  const where = daemon.socketPath ?? `http://${daemon.host}:${daemon.port}`;
  process.stdout.write(
    `pinoutd v${PINOUT_VERSION} listening on ${where}${args.allowRemote ? '' : ' (loopback only)'}\n`,
  );
  if (awareness) {
    process.stdout.write(
      `Awareness enabled (read-only discovery${args.mockDevices ? `; mock=${args.mockDevices}` : ''}). GET /v1/awareness\n`,
    );
  }
  if (persisted.generated) {
    process.stdout.write(
      `Generated daemon token in ${persisted.path}; retrieve it from that 0600 file.\n`,
    );
  }

  const shutdown = async (): Promise<void> => {
    await boardDiscovery?.close();
    await daemon.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`pinoutd: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
