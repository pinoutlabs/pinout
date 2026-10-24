import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePinoutHome } from '@pinout/core';
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
  let token = process.env.PINOUT_TOKEN;
  if (!token && daemonUrl(program) === DEFAULT_DAEMON_URL) {
    try {
      token = (
        JSON.parse(readFileSync(join(resolvePinoutHome(), 'pinoutd.json'), 'utf8')) as {
          token?: string;
        }
      ).token;
    } catch {
      /* Daemon can be started separately. */
    }
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(
      `Cannot reach the Pinout daemon at ${daemonUrl(program)}. Start it with: pinoutd`,
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
): Promise<Record<string, unknown>> {
  return throwIfDaemonError(await requestDaemon(program, method, path, body));
}

function parseRangesJson(value: string): Record<string, Record<string, { min: number; max: number }>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--ranges must be a JSON object of capability → param → {min,max}.');
  }
  return parsed as Record<string, Record<string, { min: number; max: number }>>;
}

/**
 * Human-gated connector pipeline commands (daemon-routed).
 * Never auto-installs, auto-approves, or auto-actuates.
 */
export function registerConnectorCommands(program: Command, outputFor: OutputFactory): void {
  const out = (): CliOutput => outputFor();
  const connector = program
    .command('connector')
    .description(
      'Generated connector pipeline: list, show, generate, approve, install, reject (daemon-routed).',
    );

  connector
    .command('list')
    .description('List connectors in ~/.pinout/connectors.')
    .action(async () => {
      out().log(await call(program, 'GET', '/v1/connectors'));
    });

  connector
    .command('show <id>')
    .description('Show connector status, capabilities, safety flags, and conformance report.')
    .action(async (id: string) => {
      out().log(await call(program, 'GET', `/v1/connectors/${encodeURIComponent(id)}`));
    });

  connector
    .command('generate')
    .description('Generate a connector from an awareness record (quarantine after conformance).')
    .requiredOption('--awareness <id>', 'awareness record id')
    .action(async (options: { awareness: string }) => {
      out().log(
        await call(program, 'POST', '/v1/connectors/generate', {
          awarenessId: options.awareness,
        }),
      );
    });

  connector
    .command('approve <id>')
    .description(
      'Human approval: enable named capabilities and bind numeric policy ranges (required before install).',
    )
    .requiredOption(
      '--capabilities <csv>',
      'comma-separated capability names to enable (physical outputs need ranges)',
    )
    .requiredOption(
      '--ranges <json>',
      'JSON object: { "cap.name": { "param": { "min": 0, "max": 1 } } }',
      parseRangesJson,
    )
    .option('--by <principal>', 'approver identity recorded in the journal', 'cli-operator')
    .action(
      async (
        id: string,
        options: {
          capabilities: string;
          ranges: Record<string, Record<string, { min: number; max: number }>>;
          by: string;
        },
      ) => {
        const capabilities = options.capabilities
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        out().log(
          await call(program, 'POST', `/v1/connectors/${encodeURIComponent(id)}/approve`, {
            capabilities,
            ranges: options.ranges,
            approvedBy: options.by,
          }),
        );
      },
    );

  connector
    .command('install <id>')
    .description(
      'Install an APPROVED connector into ~/.pinout/modules and hot-register it (never auto).',
    )
    .action(async (id: string) => {
      out().log(await call(program, 'POST', `/v1/connectors/${encodeURIComponent(id)}/install`, {}));
    });

  connector
    .command('reject <id>')
    .description('Reject a connector; uninstalls if previously installed.')
    .option('--reason <text>', 'optional rejection reason')
    .option('--by <principal>', 'rejector identity recorded in the journal', 'cli-operator')
    .action(async (id: string, options: { reason?: string; by: string }) => {
      out().log(
        await call(program, 'POST', `/v1/connectors/${encodeURIComponent(id)}/reject`, {
          ...(options.reason ? { reason: options.reason } : {}),
          rejectedBy: options.by,
        }),
      );
    });
}
