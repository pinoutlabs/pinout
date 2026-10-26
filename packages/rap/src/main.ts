#!/usr/bin/env node
/**
 * pinout-rap — RAP (Reactive Agent Protocol) HTTP adapter for pinoutd.
 *
 * Environment:
 *   PINOUT_DAEMON_URL / PINOUT_URL  daemon base URL (default http://127.0.0.1:8787)
 *   PINOUT_TOKEN                   bearer for pinoutd (and for this adapter when set as RAP token)
 *   PINOUT_RAP_HOST                bind host (default 127.0.0.1)
 *   PINOUT_RAP_PORT                bind port (default 8791)
 *   PINOUT_RAP_TOKEN               bearer required for non-loopback / when set
 *   PINOUT_RAP_PUBLIC_URL          advertised toolset endpoint base
 *   PINOUT_RAP_ALLOW_REMOTE=1      allow non-loopback bind (still requires token)
 *   PINOUT_HOME                    durable pending journal root (~/.pinout)
 */
import { startRapServer } from './server.js';

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true' || value === 'yes';
}

async function main(): Promise<void> {
  const host = process.env.PINOUT_RAP_HOST ?? '127.0.0.1';
  const port = Number(process.env.PINOUT_RAP_PORT ?? '8791');
  const token = process.env.PINOUT_RAP_TOKEN ?? process.env.PINOUT_TOKEN;
  const daemonUrl = process.env.PINOUT_DAEMON_URL ?? process.env.PINOUT_URL;
  const daemonToken = process.env.PINOUT_TOKEN;
  const publicBaseUrl = process.env.PINOUT_RAP_PUBLIC_URL;
  const allowRemote = envFlag('PINOUT_RAP_ALLOW_REMOTE');

  const server = await startRapServer({
    host,
    port: Number.isFinite(port) ? port : 8791,
    ...(token ? { token } : {}),
    ...(daemonUrl ? { daemonUrl } : {}),
    ...(daemonToken ? { daemonToken } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(allowRemote ? { allowRemote: true } : {}),
  });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  console.error(
    `[pinout-rap] listening on ${server.baseUrl} (toolset ${server.baseUrl}/.well-known/rap-toolset)`,
  );
}

main().catch((error) => {
  console.error('[pinout-rap] failed to start:', error);
  process.exit(1);
});
