import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface CapturedCallback {
  at: number;
  body: Record<string, unknown>;
}

export interface MockRapRuntime {
  baseUrl: string;
  callbackUrl: string;
  callbacks: CapturedCallback[];
  waitForToolResult: (id: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitForCallbackCount: (count: number, timeoutMs?: number) => Promise<CapturedCallback[]>;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Minimal RAP runtime stand-in: serves a callback_url that records tool_result
 * / view_update POSTs so adapter tests can assert ack-then-callback behavior.
 */
export async function startMockRapRuntime(): Promise<MockRapRuntime> {
  const callbacks: CapturedCallback[] = [];
  const waiters: Array<() => void> = [];

  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'POST' && (req.url === '/callback' || req.url?.startsWith('/callback'))) {
        const raw = await readBody(req);
        try {
          callbacks.push({ at: Date.now(), body: JSON.parse(raw) as Record<string, unknown> });
        } catch {
          callbacks.push({ at: Date.now(), body: { raw } });
        }
        res.writeHead(200);
        res.end('OK');
        notify();
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const waitForCallbackCount = async (count: number, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (callbacks.length < count && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    if (callbacks.length < count) {
      throw new Error(`Timed out waiting for ${count} callbacks (got ${callbacks.length}).`);
    }
    return callbacks.slice();
  };

  const waitForToolResult = async (id: string, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = callbacks.find(
        (entry) => entry.body.type === 'tool_result' && entry.body.id === id,
      );
      if (match) return match.body;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    throw new Error(`Timed out waiting for tool_result id=${id}`);
  };

  return {
    baseUrl,
    callbackUrl: `${baseUrl}/callback`,
    callbacks,
    waitForToolResult,
    waitForCallbackCount,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, { headers });
  return { status: response.status, json: await response.json() };
}
