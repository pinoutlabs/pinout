/**
 * ModuleHost: out-of-process module execution (spec v1).
 *
 * Each module runs in a child process speaking the NDJSON ModuleIPC protocol.
 * The host provides:
 *
 * - CRASH ISOLATION: a worker that segfaults, throws, or exits mid-invoke
 *   rejects only the pending invocations; the host (and pinoutd) survive.
 * - REQUEST CORRELATION: invoke ids correlate with responses; a worker that
 *   answers out of order does not corrupt other calls.
 * - HEARTBEATS: workers heartbeat ~1s; a silent worker is presumed crashed
 *   after heartbeatTimeoutMs and treated exactly like an exit.
 * - BOUNDED RESTARTS: crashed workers restart with exponential backoff up to
 *   maxRestarts; after that the process is `dead` and further invocations
 *   fail fast with MODULE_DEAD (retryable=false until re-spawn is requested).
 * - GRACEFUL SHUTDOWN: shutdown message → grace period → SIGTERM → SIGKILL.
 *
 * THIS IS NOT A SECURITY SANDBOX. See README.md.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  encodeMessage,
  decodeMessage,
  MODULE_IPC_VERSION,
  type ModuleIpcRequest,
  type ModuleIpcResponse,
} from './protocol.js';

export type ModuleProcessState = 'starting' | 'ready' | 'restarting' | 'dead';

export interface ModuleSpawnSpec {
  id: string;
  runtime: 'node' | 'python';
  /** Path to the module entry: a JS file for node, a Python file for python. */
  modulePath: string;
  /**
   * Override the default worker entry (advanced): the spawned command runs
   * this script with modulePath as argv[2]. Use for standalone protocol
   * implementations such as heartbeat-behavior test fixtures.
   */
  workerScript?: string;
  config?: Record<string, unknown>;
  heartbeatIntervalMs?: number;
  restart?: { maxRestarts: number; backoffMs: number; maxBackoffMs?: number };
}

export interface InvokeOptions {
  timeoutMs?: number;
}

export class ModuleDeadError extends Error {
  readonly code = 'MODULE_DEAD';
  constructor(moduleId: string, message: string) {
    super(`Module '${moduleId}' is dead: ${message}`);
  }
}

export class ModuleCrashedError extends Error {
  readonly code = 'MODULE_CRASHED';
  readonly retryable = true;
  constructor(moduleId: string, message: string) {
    super(`Module '${moduleId}' crashed: ${message}`);
  }
}

interface PendingInvoke {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ModuleProcess {
  readonly id: string;
  private readonly spec: ModuleSpawnSpec;
  private child: ChildProcess | undefined;
  private currentState: ModuleProcessState = 'starting';
  private readonly pending = new Map<string, PendingInvoke>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempts = 0;
  private readonly restartPolicy: Required<NonNullable<ModuleSpawnSpec['restart']>>;
  private eventListeners = new Set<(event: string, data: Record<string, unknown>) => void>();
  private stateListeners = new Set<(state: ModuleProcessState) => void>();
  private knownCapabilities: string[] = [];
  private stopping = false;
  private requestSequence = 0;

  constructor(spec: ModuleSpawnSpec) {
    this.spec = spec;
    this.id = spec.id;
    this.restartPolicy = {
      maxRestarts: spec.restart?.maxRestarts ?? 3,
      backoffMs: spec.restart?.backoffMs ?? 100,
      maxBackoffMs: spec.restart?.maxBackoffMs ?? 2000,
    };
  }

  async start(): Promise<void> {
    await this.spawnChild();
    await new Promise<void>((resolve, reject) => {
      const onState = (state: ModuleProcessState): void => {
        if (state === 'ready') {
          cleanup();
          resolve();
        } else if (state === 'dead') {
          cleanup();
          reject(new ModuleDeadError(this.id, 'worker exited before becoming ready'));
        }
      };
      const cleanup = (): void => {
        this.stateListeners.delete(onState);
      };
      this.stateListeners.add(onState);
      // The state may have settled before we subscribed.
      if (this.currentState === 'ready') {
        cleanup();
        resolve();
      } else if (this.currentState === 'dead') {
        cleanup();
        reject(new ModuleDeadError(this.id, 'worker exited before becoming ready'));
      }
    });
  }

  state(): ModuleProcessState {
    return this.currentState;
  }

  capabilities(): string[] {
    return [...this.knownCapabilities];
  }

  onEvent(listener: (event: string, data: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStateChange(listener: (state: ModuleProcessState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async invoke(
    capability: string,
    args: Record<string, unknown> = {},
    options: InvokeOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.currentState === 'dead') {
      throw new ModuleDeadError(this.id, 'all restart attempts exhausted');
    }
    if (!this.child || this.currentState === 'starting' || this.currentState === 'restarting') {
      throw new ModuleCrashedError(this.id, 'worker is not ready');
    }

    const requestId = `inv_${++this.requestSequence}`;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(`MODULE_INVOKE_TIMEOUT: '${capability}' did not answer within ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
    });

    this.send({
      v: MODULE_IPC_VERSION,
      id: requestId,
      kind: 'invoke',
      payload: { capability, args },
    });
    return promise;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.rejectAllPending(new ModuleDeadError(this.id, 'host shutting down'));

    // Grace period, then SIGTERM, then SIGKILL.
    try {
      this.send({ v: MODULE_IPC_VERSION, id: 'shutdown', kind: 'shutdown', payload: {} });
    } catch {
      // worker already gone (EPIPE on a reaped stdin); the kill chain below still applies
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    this.setState('dead');
  }

  // -------------------------------------------------------------------------

  private async spawnChild(): Promise<void> {
    const hostDir = dirname(fileURLToPath(import.meta.url));
    // Node: the bundled worker script loads the module file.
    // Python: the pinout-module SDK runner loads the module file
    // (`python3 -m pinout_module <file>`); PYTHONPATH must include the SDK
    // `src` directory (the spawner's environment is inherited).
    const workerArgs =
      this.spec.runtime === 'node'
        ? [
            this.spec.workerScript ?? join(hostDir, '..', 'workers', 'nodeModuleWorker.mjs'),
            this.spec.modulePath,
          ]
        : ['-m', 'pinout_module', this.spec.modulePath];

    const command = this.spec.runtime === 'node' ? process.execPath : 'python3';
    // Strip tooling-injected NODE_OPTIONS (vitest, coverage, debug loaders):
    // they break plain node workers spawned from test/bundler contexts.
    const { NODE_OPTIONS: _ignored, NODE_V8_COVERAGE: _ignored2, ...workerEnv } = process.env;
    // Workers are plain scripts: never inherit loader flags (tsx/vitest
    // inject execArgv that a clean child cannot resolve). execArgv is honored
    // by node's spawn at runtime even though SpawnOptions types omit it.
    const child = spawn(command, workerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      execArgv: [] as string[],
      env: { ...workerEnv, PINOUT_MODULE_ID: this.id },
    } as Parameters<typeof spawn>[2]);
    this.child = child;
    this.setState('starting');

    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 20) stderr.push(chunk.toString('utf8'));
    });

    const readline = createInterface({ input: child.stdout! });
    readline.on('line', (line) => {
      const decoded = decodeMessage(line);
      if (decoded.message) this.onWorkerMessage(decoded.message);
    });

    child.on('exit', (code, signal) => {
      readline.close();
      if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      const crashed = !this.stopping;
      this.rejectAllPending(
        new ModuleCrashedError(
          this.id,
          `exited (code ${code}, signal ${signal})${stderr.length > 0 ? `: ${stderr[stderr.length - 1]!.trim().slice(0, 200)}` : ''}`,
        ),
      );
      this.child = undefined;
      if (this.stopping) {
        this.setState('dead');
        return;
      }
      if (crashed) {
        this.scheduleRestart(`worker exit (code ${code}, signal ${signal})`);
      }
    });

    await this.sendInit();
  }

  private async sendInit(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.child?.stdin) {
        reject(new ModuleDeadError(this.id, 'worker stdin unavailable'));
        return;
      }
      this.child.stdin.write(
        encodeMessage({
          v: MODULE_IPC_VERSION,
          id: 'init',
          kind: 'init',
          payload: {
            moduleId: this.spec.id,
            ...(this.spec.modulePath !== undefined ? { modulePath: this.spec.modulePath } : {}),
            ...(this.spec.config !== undefined ? { config: this.spec.config } : {}),
            heartbeatIntervalMs: this.spec.heartbeatIntervalMs ?? 1000,
          },
        }),
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  private onWorkerMessage(message: ModuleIpcResponse | ModuleIpcRequest): void {
    if (message.kind === 'init' || message.kind === 'invoke' || message.kind === 'shutdown') {
      return; // workers never send host-side requests
    }
    switch (message.kind) {
      case 'ready': {
        this.knownCapabilities = message.payload.capabilities;
        this.resetHeartbeatWatch();
        this.setState('ready');
        break;
      }
      case 'result': {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(message.id);
          waiter.resolve(message.payload.result);
        }
        break;
      }
      case 'error': {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(message.id);
          const error = new Error(message.payload.message);
          Object.assign(error, {
            code: message.payload.code,
            category: message.payload.category,
            retryable: message.payload.retryable ?? false,
          });
          waiter.reject(error);
        }
        break;
      }
      case 'event': {
        for (const listener of this.eventListeners) {
          listener(message.payload.event, message.payload.data);
        }
        break;
      }
      case 'heartbeat': {
        // A worker that only reaches ready and immediately exits must consume
        // its restart budget. Treat the first heartbeat—not ready—as proof of
        // a stable recovery, so a crash loop cannot restart forever.
        this.restartAttempts = 0;
        this.resetHeartbeatWatch();
        break;
      }
    }
  }

  private resetHeartbeatWatch(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const timeout = (this.spec.heartbeatIntervalMs ?? 1000) * 3 + 500;
    this.heartbeatTimer = setTimeout(() => {
      if (this.stopping) return;
      // A silent worker is treated exactly like a crashed one.
      this.rejectAllPending(new ModuleCrashedError(this.id, 'heartbeat timeout'));
      this.child?.kill('SIGKILL');
    }, timeout);
    if (typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  private scheduleRestart(reason: string): void {
    if (this.stopping) return;
    if (this.restartAttempts >= this.restartPolicy.maxRestarts) {
      this.setState('dead');
      return;
    }
    this.restartAttempts += 1;
    const backoff = Math.min(
      this.restartPolicy.backoffMs * 2 ** (this.restartAttempts - 1),
      this.restartPolicy.maxBackoffMs,
    );
    this.setState('restarting');
    setTimeout(() => {
      if (this.stopping) return;
      this.spawnChild().catch(() => this.scheduleRestart(`respawn failed after ${reason}`));
    }, backoff);
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(requestId);
    }
  }

  private setState(state: ModuleProcessState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private send(message: ModuleIpcRequest): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    try {
      // Callback form: a worker that dies with input buffered reports EPIPE
      // here instead of an uncaught stream error. The exit handler owns
      // recovery; pending calls are rejected there or via invoke timeouts.
      stdin.write(encodeMessage(message), () => {});
    } catch {
      // worker already gone; exit handler owns recovery
    }
  }
}

export class ModuleHost {
  private readonly processes = new Map<string, ModuleProcess>();

  spawn(spec: ModuleSpawnSpec): ModuleProcess {
    if (this.processes.has(spec.id)) {
      throw new Error(`Module '${spec.id}' is already hosted.`);
    }
    const processHandle = new ModuleProcess(spec);
    this.processes.set(spec.id, processHandle);
    return processHandle;
  }

  get(id: string): ModuleProcess | undefined {
    return this.processes.get(id);
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(
      [...this.processes.values()].map((processHandle) => processHandle.shutdown()),
    );
    this.processes.clear();
  }
}
