/**
 * Single HTTP front-door for createDaemonMcpServer until PR4 merges connectors
 * into pinoutd: proxy /v1/awareness* (and other daemon routes) to real pinoutd,
 * serve /v1/connectors* from the PR3/PR5 lifecycle stub.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export interface DemoFacadeOptions {
  awarenessBaseUrl: string;
  connectorsBaseUrl: string;
  token: string;
  host?: string;
  port?: number;
}

export interface RunningDemoFacade {
  baseUrl: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

function isConnectorPath(pathname: string): boolean {
  return pathname === '/v1/connectors' || pathname.startsWith('/v1/connectors/');
}

async function proxyRequest(
  targetBase: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', targetBase);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key === 'host' || key === 'content-length') continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (!headers.authorization) {
    headers.authorization = `Bearer ${token}`;
  }

  const method = req.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await new Promise<Buffer>((resolveBody, reject) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          req.on('end', () => resolveBody(Buffer.concat(chunks)));
          req.on('error', reject);
        });

  const upstream = await fetch(url, {
    method,
    headers,
    ...(body && body.length > 0 ? { body } : {}),
  });

  const responseHeaders: Record<string, string> = {
    'x-pinout-demo-facade': 'SIMULATED',
  };
  upstream.headers.forEach((value, key) => {
    if (key === 'transfer-encoding' || key === 'content-encoding') return;
    responseHeaders[key] = value;
  });

  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as never), res);
}

export async function startDemoFacade(options: DemoFacadeOptions): Promise<RunningDemoFacade> {
  const awarenessBase = options.awarenessBaseUrl.replace(/\/$/, '');
  const connectorsBase = options.connectorsBaseUrl.replace(/\/$/, '');
  const host = options.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        const target = isConnectorPath(pathname) ? connectorsBase : awarenessBase;
        await proxyRequest(target, req, res, options.token);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        res.end(
          JSON.stringify({
            error: {
              code: 'FACADE_PROXY_ERROR',
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            },
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind demo facade');
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    port: address.port,
    token: options.token,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}
