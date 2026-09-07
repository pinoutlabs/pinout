/**
 * Daemon-aware CLI commands: talk to a running `pinoutd` over its local HTTP
 * API. These never connect to hardware directly — execution belongs to the
 * daemon process. Failures throw so runCli's error path prints them and
 * returns a non-zero exit code.
 */
import type { Command } from 'commander';
import type { CliOutput } from './output.js';

type OutputFactory = () => CliOutput;

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8787';

function daemonUrl(program: Command): string {
  const opts = program.opts<{ url?: string }>();
  return opts.url ?? process.env.PINOUT_DAEMON_URL ?? process.env.PINOUT_URL ?? DEFAULT_DAEMON_URL;
}

interface DaemonHttpResponse {
  status: number;
  ok: boolean;
  payload: Record<string, unknown>;
}

async function requestDaemon(
  program: Command,
  method: string,
  path: string,
  body?: unknown,
): Promise<DaemonHttpResponse> {
  const url = `${daemonUrl(program)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(process.env.PINOUT_TOKEN
          ? { authorization: `Bearer ${process.env.PINOUT_TOKEN}` }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(
      `Cannot reach the Pinout daemon at ${daemonUrl(program)}. Start it with: pinoutd (or node packages/daemon/dist/main.js --demo)`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, ok: response.ok, payload };
}

function throwIfDaemonError(response: DaemonHttpResponse): Record<string, unknown> {
  if (response.ok) {
    return response.payload;
  }
  const error = response.payload.error as { code?: string; message?: string } | undefined;
  throw new Error(
    `Daemon error ${response.status} [${error?.code ?? 'UNKNOWN'}]: ${error?.message ?? 'request failed'}`,
  );
}

async function call(
  program: Command,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return throwIfDaemonError(await requestDaemon(program, method, path, body));
}

async function fetchDaemonStatus(program: Command): Promise<unknown> {
  const snapshot = await requestDaemon(program, 'GET', '/v1/snapshot');
  if (snapshot.ok) {
    return snapshot.payload;
  }
  if (snapshot.status === 404) {
    return call(program, 'GET', '/v1/health');
  }
  return throwIfDaemonError(snapshot);
}

export function registerDaemonCommands(program: Command, outputFor: OutputFactory): void {
  program.option(
    '--url <url>',
    'Pinout daemon base URL (default PINOUT_DAEMON_URL, PINOUT_URL, or http://127.0.0.1:8787)',
  );

  const out = (): CliOutput => outputFor();

  const daemon = program.command('daemon').description('pinoutd daemon status and lifecycle.');

  daemon
    .command('status')
    .description('Show daemon health, safety state, and device count.')
    .action(async () => {
      out().log(await fetchDaemonStatus(program));
    });

  program
    .command('halt <reason>')
    .description('Halt the daemon: reject new physical invocations.')
    .action(async (reason: string) => {
      out().log(await call(program, 'POST', '/v1/halt', { reason }));
    });

  program
    .command('resume')
    .description('Resume a halted daemon.')
    .action(async () => {
      out().log(await call(program, 'POST', '/v1/resume', { reason: 'resumed via CLI' }));
    });

  program
    .command('estop <reason>')
    .description('Request a software emergency stop (sticky; NOT a certified e-stop).')
    .action(async (reason: string) => {
      out().log(await call(program, 'POST', '/v1/estop', { reason }));
    });

  program
    .command('estop-clear')
    .description('Clear a software estop (runtime stays halted until resume).')
    .action(async () => {
      out().log(await call(program, 'POST', '/v1/estop/clear', {}));
    });

  program
    .command('arm <deviceId>')
    .description('Arm a registered device for actuation (daemon-routed).')
    .option('--owner <owner>', 'operation owner (default PINOUT_OWNER or "cli-arm")')
    .option('--timeout <ms>', 'watchdog timeout in milliseconds')
    .action(async (deviceId: string, options: { owner?: string; timeout?: string }) => {
      const owner = options.owner ?? process.env.PINOUT_OWNER ?? 'cli-arm';
      const args: Record<string, unknown> = {};
      if (options.timeout !== undefined) {
        args.timeoutMs = Number.parseInt(options.timeout, 10);
      }
      out().log(
        await call(program, 'POST', `/v1/devices/${encodeURIComponent(deviceId)}/invoke`, {
          capability: 'sys.arm',
          args,
          owner,
          waitFor: 'result',
        }),
      );
    });

  program
    .command('disarm <deviceId>')
    .description('Disarm a registered device (daemon-routed).')
    .option('--owner <owner>', 'operation owner (default PINOUT_OWNER or "cli-disarm")')
    .action(async (deviceId: string, options: { owner?: string }) => {
      const owner = options.owner ?? process.env.PINOUT_OWNER ?? 'cli-disarm';
      out().log(
        await call(program, 'POST', `/v1/devices/${encodeURIComponent(deviceId)}/invoke`, {
          capability: 'sys.disarm',
          args: {},
          owner,
          waitFor: 'result',
        }),
      );
    });

  const lease = program.command('lease').description('Device leases on the daemon.');

  lease
    .command('list')
    .description('List active leases.')
    .action(async () => {
      out().log(await call(program, 'GET', '/v1/leases'));
    });

  lease
    .command('acquire <deviceId>')
    .option('--owner <owner>', 'lease owner (default PINOUT_OWNER or "cli-lease")')
    .option('--ttl <ms>', 'TTL in milliseconds', '60000')
    .option('--shared', 'acquire a shared-read lease instead of exclusive')
    .action(
      async (deviceId: string, options: { owner?: string; ttl: string; shared?: boolean }) => {
        const owner = options.owner ?? process.env.PINOUT_OWNER ?? 'cli-lease';
        out().log(
          await call(program, 'POST', '/v1/leases', {
            owner,
            scope: { kind: 'device', deviceId },
            ttlMs: Number.parseInt(options.ttl, 10),
            mode: options.shared ? 'shared-read' : 'exclusive',
          }),
        );
      },
    );

  lease
    .command('release <leaseId>')
    .option('--owner <owner>', 'lease owner (default PINOUT_OWNER or "cli-lease")')
    .action(async (leaseId: string, options: { owner?: string }) => {
      const owner = options.owner ?? process.env.PINOUT_OWNER ?? 'cli-lease';
      out().log(
        await call(
          program,
          'DELETE',
          `/v1/leases/${encodeURIComponent(leaseId)}?owner=${encodeURIComponent(owner)}`,
        ),
      );
    });

  program
    .command('operations')
    .description('List operations tracked by the daemon.')
    .option('--device <deviceId>')
    .action(async (options: { device?: string }) => {
      const query = options.device ? `?deviceId=${encodeURIComponent(options.device)}` : '';
      out().log(await call(program, 'GET', `/v1/operations${query}`));
    });

  program
    .command('logs')
    .description('Read the daemon control journal.')
    .option('--device <deviceId>')
    .option('--limit <n>', 'maximum entries', '50')
    .action(async (options: { device?: string; limit: string }) => {
      const params = new URLSearchParams({ limit: options.limit });
      if (options.device) params.set('deviceId', options.device);
      out().log(await call(program, 'GET', `/v1/journal?${params.toString()}`));
    });
}
