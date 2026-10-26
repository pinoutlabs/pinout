import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { RapAdapter, type RapAdapterOptions } from './adapter.js';
import type { RapCancelToolCall, RapCloseThread, RapInvocation } from './types.js';

export interface RapServerOptions extends Omit<RapAdapterOptions, 'publicBaseUrl'> {
  host?: string;
  port?: number;
  /** Public base URL advertised in the toolset endpoint. Defaults to http://host:port. */
  publicBaseUrl?: string;
  /** Bearer token; required when binding a non-loopback host. */
  token?: string;
  allowRemote?: boolean;
}

export interface StartedRapServer {
  host: string;
  port: number;
  baseUrl: string;
  adapter: RapAdapter;
  close: () => Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: string, contentType?: string): void {
  if (body !== undefined) {
    res.writeHead(status, {
      'content-type': contentType ?? 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  res.writeHead(status);
  res.end();
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8');
}

/**
 * RAP HTTP tool server:
 * - GET /.well-known/rap-toolset
 * - POST /invoke
 * - POST /cancel_tool_call
 * - POST /close_thread
 */
export async function startRapServer(options: RapServerOptions = {}): Promise<StartedRapServer> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 8791;
  if (!isLoopbackHost(host)) {
    if (!options.allowRemote) {
      throw new Error(
        'Refusing to bind a non-loopback host without allowRemote=true. Physical control must not be exposed casually.',
      );
    }
    if (!options.token) {
      throw new Error('Bearer token is required when binding a non-loopback RAP adapter host.');
    }
  }

  // Bind first so port:0 resolves before we advertise the toolset endpoint.
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => resolve());
  });
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : requestedPort;
  const baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`;
  const publicBaseUrl = options.publicBaseUrl ?? baseUrl;

  const adapter = new RapAdapter({
    publicBaseUrl,
    ...(options.daemonUrl !== undefined ? { daemonUrl: options.daemonUrl } : {}),
    ...(options.daemonToken !== undefined ? { daemonToken: options.daemonToken } : {}),
    ...(options.pinoutHome !== undefined ? { pinoutHome: options.pinoutHome } : {}),
    ...(options.journalDir !== undefined ? { journalDir: options.journalDir } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.maxCallbackAttempts !== undefined
      ? { maxCallbackAttempts: options.maxCallbackAttempts }
      : {}),
    ...(options.callbackBaseDelayMs !== undefined
      ? { callbackBaseDelayMs: options.callbackBaseDelayMs }
      : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.operationTimeoutMs !== undefined
      ? { operationTimeoutMs: options.operationTimeoutMs }
      : {}),
  });

  const requireAuth = Boolean(options.token) || !isLoopbackHost(host);

  const authorize = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!requireAuth) return true;
    if (!options.token) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Bearer token required.' });
      return false;
    }
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Bearer token required.' });
      return false;
    }
    const provided = header.slice('Bearer '.length);
    if (!tokensEqual(options.token, provided)) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Invalid bearer token.' });
      return false;
    }
    return true;
  };

  server.on('request', (req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', baseUrl);
    const path = url.pathname;

    try {
      if (method === 'GET' && path === '/.well-known/rap-toolset') {
        if (!authorize(req, res)) return;
        sendJson(res, 200, adapter.toolset());
        return;
      }

      if (method === 'POST' && path === '/invoke') {
        if (!authorize(req, res)) return;
        const raw = await readBody(req);
        let invocation: RapInvocation;
        try {
          invocation = JSON.parse(raw) as RapInvocation;
        } catch {
          send(res, 200, 'OK');
          return;
        }
        // Acknowledge immediately — do not await processing.
        send(res, 200, 'OK');
        if (
          typeof invocation.operation !== 'string' ||
          typeof invocation.id !== 'string' ||
          typeof invocation.callback_url !== 'string' ||
          typeof invocation.group_id !== 'string'
        ) {
          return;
        }
        if (
          invocation.arguments === undefined ||
          typeof invocation.arguments !== 'object' ||
          invocation.arguments === null ||
          Array.isArray(invocation.arguments)
        ) {
          invocation.arguments = {};
        }
        adapter.acceptInvocation(invocation);
        return;
      }

      if (method === 'POST' && path === '/cancel_tool_call') {
        if (!authorize(req, res)) return;
        const raw = await readBody(req);
        send(res, 200, 'OK');
        try {
          const body = JSON.parse(raw) as RapCancelToolCall;
          if (typeof body.thread_id === 'string' && typeof body.tool_call_id === 'string') {
            await adapter.cancelToolCall(body);
          }
        } catch {
          // best effort
        }
        return;
      }

      if (method === 'POST' && path === '/close_thread') {
        if (!authorize(req, res)) return;
        const raw = await readBody(req);
        send(res, 200, 'OK');
        try {
          const body = JSON.parse(raw) as RapCloseThread;
          if (typeof body.thread_id === 'string') {
            await adapter.closeThread(body);
          }
        } catch {
          // best effort
        }
        return;
      }

      if (method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true, service: 'pinout-rap' });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message });
    }
  }

  adapter.startRecovery();

  return {
    host,
    port: boundPort,
    baseUrl,
    adapter,
    close: async () => {
      await adapter.drain();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
