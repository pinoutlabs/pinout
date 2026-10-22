import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePinoutHome } from '@pinout/core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createHeterogeneousRuntime,
  esp32Module,
  loadPinoutConfig,
  PinoutRuntime,
} from '@pinout/core';
import { createMcpTransport } from './connectDevice.js';
import { createRuntimeMcpServer } from './createRuntimeServer.js';
import { createDaemonMcpServer } from './createDaemonServer.js';

export async function runStdioServer(): Promise<void> {
  if (process.env.PINOUT_DEMO === 'heterogeneous') {
    await runHeterogeneousRuntimeServer();
    return;
  }

  if (process.env.PINOUT_MCP_EMBEDDED !== '1') {
    await runDaemonServer();
    return;
  }

  await runEmbeddedServer();
}

async function runDaemonServer(): Promise<void> {
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
  const server = createDaemonMcpServer({
    dynamicTools: process.env.PINOUT_MCP_DYNAMIC_TOOLS === '1',
    ...(process.env.PINOUT_DAEMON_URL ? { baseUrl: process.env.PINOUT_DAEMON_URL } : {}),
    ...(token ? { token } : {}),
    owner: process.env.PINOUT_OWNER ?? 'mcp-stdio',
  });
  await runStdioSession(server);
}

async function runEmbeddedServer(): Promise<void> {
  const runtime = new PinoutRuntime();
  await runtime.registerModuleDevice(esp32Module, {
    id: 'esp32-01',
    transport: await createMcpTransport(),
  });
  const server = createRuntimeMcpServer(runtime, { owner: 'mcp-stdio' });
  await runStdioSession(server, runtime);
}

async function runHeterogeneousRuntimeServer(): Promise<void> {
  const config = loadPinoutConfig();
  const runtime = await createHeterogeneousRuntime({
    useHardwareEsp32: Boolean(config.port),
  });
  const server = createRuntimeMcpServer(runtime, { owner: 'mcp-stdio' });
  await runStdioSession(server, runtime);
}

async function runStdioSession(server: Server, runtime?: PinoutRuntime): Promise<void> {
  const transport = new StdioServerTransport();

  await new Promise<void>((resolve, reject) => {
    let isClosing = false;

    const cleanup = async (error?: Error): Promise<void> => {
      if (isClosing) {
        return;
      }
      isClosing = true;

      process.off('SIGINT', handleSigInt);
      process.off('SIGTERM', handleSigTerm);
      process.stdin.off('end', handleStdinEnd);
      process.stdin.off('close', handleStdinClose);
      process.stdin.off('error', handleStdinError);

      try {
        await server.close().catch(() => undefined);
      } catch {
        // ignore server close error
      }

      if (runtime) {
        try {
          await runtime.close().catch(() => undefined);
        } catch {
          // ignore runtime close error
        }
      }

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const handleSigInt = () => {
      void cleanup().finally(() => process.exit(0));
    };

    const handleSigTerm = () => {
      void cleanup().finally(() => process.exit(0));
    };

    const handleStdinEnd = () => {
      void cleanup();
    };

    const handleStdinClose = () => {
      void cleanup();
    };

    const handleStdinError = (error: Error) => {
      void cleanup(error);
    };

    process.on('SIGINT', handleSigInt);
    process.on('SIGTERM', handleSigTerm);
    process.stdin.on('end', handleStdinEnd);
    process.stdin.on('close', handleStdinClose);
    process.stdin.on('error', handleStdinError);

    server.onclose = () => {
      void cleanup();
    };

    transport.onclose = () => {
      void cleanup();
    };

    transport.onerror = (error: Error) => {
      void cleanup(error);
    };

    if (process.stdin.readableEnded || process.stdin.destroyed) {
      void cleanup();
      return;
    }

    server.connect(transport).catch((connectError) => {
      void cleanup(connectError instanceof Error ? connectError : new Error(String(connectError)));
    });
  });
}
