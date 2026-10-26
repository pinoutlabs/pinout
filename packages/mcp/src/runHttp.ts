/**
 * Optional Streamable HTTP transport for pinout-mcp.
 *
 * Stdio remains the default. Enable with PINOUT_MCP_HTTP=1 (or --http).
 * Binds loopback by default; non-loopback requires PINOUT_MCP_TOKEN (bearer).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePinoutHome } from '@pinout/core';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDaemonMcpServer } from './createDaemonServer.js';

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::';
}

function bearerMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const actual = Buffer.from(provided, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function resolveDaemonToken(): Promise<string | undefined> {
  let token = process.env.PINOUT_TOKEN;
  if (!token && !process.env.PINOUT_DAEMON_URL) {
    try {
      token = (
        JSON.parse(await readFile(join(resolvePinoutHome(), 'pinoutd.json'), 'utf8')) as {
          token?: string;
        }
      ).token;
    } catch {
      /* Daemon may not have started yet. */
    }
  }
  return token;
}

export interface HttpMcpListenOptions {
  host?: string;
  port?: number;
  /** Bearer token required for every request when binding non-loopback. */
  mcpToken?: string;
}

export async function runHttpServer(listen: HttpMcpListenOptions = {}): Promise<void> {
  const host = listen.host ?? process.env.PINOUT_MCP_HOST ?? '127.0.0.1';
  const port = listen.port ?? Number.parseInt(process.env.PINOUT_MCP_PORT ?? '8790', 10);
  const mcpToken = listen.mcpToken ?? process.env.PINOUT_MCP_TOKEN;

  if (!isLoopbackHost(host) && !mcpToken) {
    throw new Error(
      'pinout-mcp HTTP refuses non-loopback bind without PINOUT_MCP_TOKEN (bearer auth required).',
    );
  }

  const daemonToken = await resolveDaemonToken();
  const invokeWaitMs = process.env.PINOUT_MCP_INVOKE_WAIT_MS
    ? Number.parseInt(process.env.PINOUT_MCP_INVOKE_WAIT_MS, 10)
    : undefined;

  const mcpServer = createDaemonMcpServer({
    dynamicTools: process.env.PINOUT_MCP_DYNAMIC_TOOLS === '1',
    ...(process.env.PINOUT_DAEMON_URL ? { baseUrl: process.env.PINOUT_DAEMON_URL } : {}),
    ...(daemonToken ? { token: daemonToken } : {}),
    owner: process.env.PINOUT_OWNER ?? 'mcp-http',
    ...(invokeWaitMs !== undefined && Number.isFinite(invokeWaitMs)
      ? { invokeWaitMs }
      : {}),
  });

  // Stateless streamable HTTP with JSON responses (simpler for agent bridges).
  // Omit sessionIdGenerator for stateless mode (exactOptionalPropertyTypes-safe).
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport as Transport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (mcpToken) {
      const header = req.headers.authorization;
      const provided =
        typeof header === 'string' && header.startsWith('Bearer ')
          ? header.slice('Bearer '.length)
          : undefined;
      if (!bearerMatches(provided, mcpToken)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  process.stderr.write(
    `pinout-mcp streamable HTTP listening on http://${host}:${boundPort} (stdio remains default; SIMULATED-safe when daemon is --demo)\n`,
  );

  const shutdown = async (): Promise<void> => {
    await mcpServer.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
