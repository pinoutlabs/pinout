import type { DaemonConfig } from './httpServer.js';
import { DaemonContext, DaemonHttpServer } from './httpServer.js';
import type { PinoutRuntime } from '@pinout/core';
import type { AwarenessService } from './awareness/service.js';

export interface RunningDaemon {
  host: string;
  port: number;
  socketPath?: string;
  context: DaemonContext;
  server: DaemonHttpServer;
  awareness?: AwarenessService;
  close(): Promise<void>;
}

/**
 * Start a daemon around an existing runtime. This is the programmatic entry
 * point used by tests, the CLI (`pinout daemon start`), and the `pinoutd` bin.
 */
export async function startDaemon(
  runtime: PinoutRuntime,
  config: DaemonConfig = {},
): Promise<RunningDaemon> {
  const context = new DaemonContext(runtime, config);
  await context.ready;
  if (config.awareness) {
    config.awareness.attachJournal(context.journal);
    await config.awareness.start();
  }
  const server = new DaemonHttpServer(context);
  const address = await server.listen(config);

  context.startFailSafeMonitor();

  return {
    ...address,
    context,
    server,
    ...(config.awareness ? { awareness: config.awareness } : {}),
    close: async () => {
      context.stopFailSafeMonitor();
      await config.awareness?.stop();
      await server.close();
      await runtime.close();
    },
  };
}
