import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { OahlBridge } from './oahlBridge.js';
import { OahlError } from './errors.js';
import type {
  OahlDiscoverFilter,
  OahlExecuteRequest,
  OahlReleaseRequest,
  OahlRenewRequest,
  OahlReserveRequest,
  OahlServerOptions,
} from './types.js';

export class OahlHttpServer {
  readonly bridge: OahlBridge;
  private server?: Server;
  private port: number;
  private host: string;

  constructor(bridge: OahlBridge, options: OahlServerOptions = {}) {
    this.bridge = bridge;
    this.port = options.port ?? 8765;
    this.host = options.host ?? '127.0.0.1';
  }

  async listen(port = this.port, host = this.host): Promise<{ port: number; host: string }> {
    this.port = port;
    this.host = host;

    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err) {
          this.sendError(res, err);
        }
      });

      server.on('error', reject);
      server.listen(this.port, this.host, () => {
        this.server = server;
        const address = server.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          this.host = address.address;
        }
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        return resolve();
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Health check
    if (pathname === '/health' && method === 'GET') {
      this.sendJson(res, 200, { status: 'ok', server: 'oahl-pinout-bridge' });
      return;
    }

    // Phase 1: Discover
    if (pathname === '/oahl/v1/discover' && method === 'GET') {
      const filter: OahlDiscoverFilter = {};
      const devClass = url.searchParams.get('deviceClass');
      const capability = url.searchParams.get('capability');
      const availableOnly = url.searchParams.get('availableOnly');

      if (devClass) filter.deviceClass = devClass;
      if (capability) filter.capability = capability;
      if (availableOnly === 'true') filter.availableOnly = true;

      const result = await this.bridge.discover(filter);
      this.sendJson(res, 200, result);
      return;
    }

    // Phase 2: Reserve
    if (pathname === '/oahl/v1/reserve' && method === 'POST') {
      const body = (await this.readJsonBody(req)) as OahlReserveRequest;
      const result = await this.bridge.reserve(body);
      this.sendJson(res, 201, result);
      return;
    }

    // Phase 2b: Renew
    if (pathname === '/oahl/v1/renew' && method === 'POST') {
      const body = (await this.readJsonBody(req)) as OahlRenewRequest;
      const result = await this.bridge.renew(body);
      this.sendJson(res, 200, result);
      return;
    }

    // Phase 3: Execute
    if (pathname === '/oahl/v1/execute' && method === 'POST') {
      const body = (await this.readJsonBody(req)) as OahlExecuteRequest;
      const result = await this.bridge.execute(body);
      this.sendJson(res, 200, result);
      return;
    }

    // Phase 4: Release
    if (pathname === '/oahl/v1/release' && method === 'POST') {
      const body = (await this.readJsonBody(req)) as OahlReleaseRequest;
      const result = await this.bridge.release(body);
      this.sendJson(res, 200, result);
      return;
    }

    this.sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Route ${method} ${pathname} not found.` } });
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new OahlError('MALFORMED_JSON', 'Invalid JSON payload received.', 400));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (err instanceof OahlError) {
      this.sendJson(res, err.statusCode, err.toJSON());
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    this.sendJson(res, 500, {
      error: {
        code: 'INTERNAL_ERROR',
        message,
      },
    });
  }
}
