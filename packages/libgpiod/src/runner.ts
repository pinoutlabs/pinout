/**
 * Command execution seam.
 *
 * Every libgpiod invocation in this package goes through a {@link CommandRunner}.
 * Nothing else in the package imports `node:child_process`, so the entire
 * adapter is testable with scripted runners on any host, and no code path ever
 * builds a shell string: tools are always executed with an explicit argument
 * array (`execFile`/`spawn` without `shell: true`), so line names, consumer
 * names, and chip names can never be interpreted by a shell.
 *
 * {@link NodeCommandRunner} is the production implementation:
 *
 * - `run()` wraps `child_process.execFile` in a manually written Promise so a
 *   timeout can be reported as data (`timedOut: true`) instead of an
 *   indistinguishable generic failure, and so spawn errors (ENOENT/EACCES) can
 *   be surfaced separately (they mean "tool missing", not "tool failed").
 * - `spawn()` returns a long-running {@link CommandStream} used by `gpiomon`
 *   watches and holding `gpioset` processes. Processes are intentionally left
 *   referenced: an unreferenced holder could let the runtime exit while a line
 *   is still driven.
 *
 * Timeouts kill with `SIGKILL`. The kernel releases every line a process holds
 * when that process dies, so a hard kill does not strand a driven output the
 * way a graceful-but-stuck process would; deterministic cleanup wins here.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

export interface CommandRunOptions {
  /** Kill the process after this many milliseconds. Omitted/0 means no timeout. */
  timeoutMs?: number;
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
}

/** Present when the process could not be started at all (ENOENT, EACCES, ...). */
export interface CommandSpawnError {
  code: string;
  message: string;
}

export interface CommandRunResult {
  /** Exit code, or null when the process died from a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: CommandSpawnError;
}

export interface CommandSpawnOptions {
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
}

export interface CommandExitInfo {
  /** Exit code, or null when the process died from a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Present when the child failed to start or the OS surfaced an error. */
  error?: CommandSpawnError;
}

/** A streaming handle to a long-running tool process. */
export interface CommandStream {
  readonly pid: number | undefined;
  /** Decoded stdout chunks. Chunks are NOT line-aligned; consumers must buffer. */
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** Fires once, when the process has exited and its stdio is closed. */
  onExit(handler: (info: CommandExitInfo) => void): () => void;
  kill(signal?: NodeJS.Signals): void;
}

export interface CommandRunner {
  run(file: string, args: string[], options?: CommandRunOptions): Promise<CommandRunResult>;
  spawn(file: string, args: string[], options?: CommandSpawnOptions): CommandStream;
}

const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export class NodeCommandRunner implements CommandRunner {
  run(file: string, args: string[], options: CommandRunOptions = {}): Promise<CommandRunResult> {
    const timeoutMs = options.timeoutMs ?? 0;
    return new Promise<CommandRunResult>((resolve) => {
      execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
          env: { ...process.env, ...(options.env ?? {}) },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout, stderr, timedOut: false });
            return;
          }
          const rawCode = (error as { code?: number | string }).code;
          const numericCode = typeof rawCode === 'number' ? rawCode : null;
          const spawnError: CommandSpawnError | undefined =
            typeof rawCode === 'string' && rawCode.length > 0
              ? { code: rawCode, message: error.message }
              : undefined;
          const result: CommandRunResult = {
            code: spawnError ? null : numericCode,
            stdout,
            stderr,
            timedOut: error.killed === true && spawnError === undefined,
          };
          if (spawnError) {
            result.spawnError = spawnError;
          }
          resolve(result);
        },
      );
    });
  }

  spawn(file: string, args: string[], options: CommandSpawnOptions = {}): CommandStream {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
    });
    return new NodeCommandStream(child);
  }
}

class NodeCommandStream implements CommandStream {
  private readonly child: ChildProcess;
  private readonly listeners = new Set<(info: CommandExitInfo) => void>();
  private exitInfo: CommandExitInfo | null = null;
  private spawnError: CommandSpawnError | null = null;

  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;

  constructor(child: ChildProcess) {
    this.child = child;
    this.stdout = decodeStream(child.stdout);
    this.stderr = decodeStream(child.stderr);

    child.on('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      this.spawnError = { code: typeof code === 'string' ? code : 'UNKNOWN', message: error.message };
    });

    // `close` (not `exit`) so both stdio streams are flushed before consumers
    // are told the process ended and start reading diagnostics.
    child.on('close', (code, signal) => {
      const info: CommandExitInfo = { code, signal };
      if (this.spawnError) {
        info.error = this.spawnError;
      }
      this.exitInfo = info;
      const pending = [...this.listeners];
      this.listeners.clear();
      for (const listener of pending) {
        listener(info);
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  onExit(handler: (info: CommandExitInfo) => void): () => void {
    if (this.exitInfo) {
      handler(this.exitInfo);
      return () => undefined;
    }
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    try {
      this.child.kill(signal);
    } catch {
      // The process is already gone; exit notification still arrives via `close`.
    }
  }
}

async function* decodeStream(stream: Readable | null): AsyncIterable<string> {
  if (stream === null) return;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    // Node types the stream as `AsyncIterable<any>`; the runtime value is a
    // Buffer (or string when one day an encoding is configured).
    const typed: unknown = chunk;
    if (typeof typed !== 'string' && !Buffer.isBuffer(typed)) continue;
    const text = decoder.write(typed);
    if (text.length > 0) yield text;
  }
  const tail = decoder.end();
  if (tail.length > 0) yield tail;
}
