/**
 * Scripted {@link CommandRunner} for tests.
 *
 * The fake replays queued run results, records every invocation in
 * chronological `log` order, and hands out {@link FakeCommandProcess}
 * instances for `spawn()` so tests can push tool stdout/stderr, watch kill
 * signals, and simulate exits (including unexpected holder death).
 *
 * Streams are single-consumer: the tools consume each stdio stream exactly
 * once, and a second `[Symbol.asyncIterator]()` call throws so accidental
 * double consumption fails loudly instead of silently stealing chunks.
 */
import type {
  CommandExitInfo,
  CommandRunOptions,
  CommandRunResult,
  CommandRunner,
  CommandSpawnOptions,
  CommandStream,
} from '../src/runner.js';

export interface FakeRunInvocation {
  file: string;
  args: string[];
  options: CommandRunOptions;
  result: CommandRunResult;
}

export interface FakeSpawnInvocation {
  file: string;
  args: string[];
  options: CommandSpawnOptions;
  process: FakeCommandProcess;
}

export type FakeLogEntry =
  | { kind: 'run'; tool: string; args: string[] }
  | { kind: 'spawn'; tool: string; args: string[] }
  | { kind: 'kill'; tool: string; args: string[]; signal: NodeJS.Signals }
  | { kind: 'exit'; tool: string; args: string[]; info: CommandExitInfo };

export interface FakeRunScript {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  spawnError?: { code: string; message: string };
}

export class FakeCommandRunner implements CommandRunner {
  readonly runs: FakeRunInvocation[] = [];
  readonly spawns: FakeSpawnInvocation[] = [];
  readonly log: FakeLogEntry[] = [];

  /** Optional hook invoked synchronously after every `spawn()`. */
  onSpawn: ((process: FakeCommandProcess) => void) | null = null;

  private readonly scripts: CommandRunResult[] = [];
  private nextPid = 10_000;

  enqueue(script: FakeRunScript = {}): this {
    const result: CommandRunResult = {
      code: script.code === undefined ? 0 : script.code,
      stdout: script.stdout ?? '',
      stderr: script.stderr ?? '',
      timedOut: script.timedOut ?? false,
    };
    if (script.spawnError) result.spawnError = { ...script.spawnError };
    this.scripts.push(result);
    return this;
  }

  /** Queue a nonzero exit with stderr text (for error-classification tests). */
  enqueueError(exitCode: number, stderr: string, stdout = ''): this {
    return this.enqueue({ code: exitCode, stdout, stderr });
  }

  /** Queue a run that hit its timeout and was killed. */
  enqueueTimeout(): this {
    return this.enqueue({ code: null, timedOut: true });
  }

  /** Queue a run whose executable could not be started (ENOENT). */
  enqueueMissingTool(tool = 'gpiodetect'): this {
    return this.enqueue({
      code: null,
      spawnError: { code: 'ENOENT', message: `spawn ${tool} ENOENT` },
    });
  }

  get pendingRunCount(): number {
    return this.scripts.length;
  }

  async run(file: string, args: string[], options: CommandRunOptions = {}): Promise<CommandRunResult> {
    const script = this.scripts.shift();
    if (!script) {
      throw new Error(
        `FakeCommandRunner: unexpected run '${file} ${args.join(' ')}' with no queued script.`,
      );
    }
    const result: CommandRunResult = { ...script };
    this.runs.push({ file, args: [...args], options, result });
    this.log.push({ kind: 'run', tool: file, args: [...args] });
    return result;
  }

  spawn(file: string, args: string[], options: CommandSpawnOptions = {}): CommandStream {
    const process = new FakeCommandProcess(file, [...args], this.nextPid++);
    process.onKill = (signal) => {
      this.log.push({ kind: 'kill', tool: file, args: [...args], signal });
    };
    process.onExitRecord = (info) => {
      this.log.push({ kind: 'exit', tool: file, args: [...args], info });
    };
    this.spawns.push({ file, args: [...args], options, process });
    this.log.push({ kind: 'spawn', tool: file, args: [...args] });
    this.onSpawn?.(process);
    return process;
  }

  /** Every tool name (run or spawn) in invocation order. */
  usedTools(): string[] {
    return this.log.filter((entry) => entry.kind === 'run' || entry.kind === 'spawn').map((entry) => entry.tool);
  }
}

export class FakeCommandProcess implements CommandStream {
  readonly file: string;
  readonly args: string[];
  readonly pid: number;
  readonly stdout: FakeChunkStream = new FakeChunkStream();
  readonly stderr: FakeChunkStream = new FakeChunkStream();

  /**
   * When true (the default), `kill()` also exits the process with the raised
   * signal, matching a cooperative tool. Set to false to model a process that
   * ignores SIGTERM so escalation to SIGKILL can be observed.
   */
  autoExitOnKill = true;

  /** Every signal received through `kill()`, in order. */
  readonly signals: NodeJS.Signals[] = [];

  onKill: ((signal: NodeJS.Signals) => void) | null = null;
  onExitRecord: ((info: CommandExitInfo) => void) | null = null;

  private readonly listeners = new Set<(info: CommandExitInfo) => void>();
  private exitInfo: CommandExitInfo | null = null;

  constructor(file: string, args: string[], pid: number) {
    this.file = file;
    this.args = args;
    this.pid = pid;
  }

  get info(): CommandExitInfo | null {
    return this.exitInfo;
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  pushStdout(chunk: string): void {
    this.stdout.push(chunk);
  }

  pushStderr(chunk: string): void {
    this.stderr.push(chunk);
  }

  /** Close stdout without exiting; models a quiet-but-alive tool. */
  closeStdout(): void {
    this.stdout.end();
  }

  exit(info: Partial<CommandExitInfo> = {}): void {
    if (this.exitInfo) return;
    const resolved: CommandExitInfo = {
      code: info.code === undefined ? 0 : info.code,
      signal: info.signal === undefined ? null : info.signal,
    };
    if (info.error) resolved.error = { ...info.error };
    this.exitInfo = resolved;
    this.stdout.end();
    this.stderr.end();
    this.onExitRecord?.(resolved);
    const pending = [...this.listeners];
    this.listeners.clear();
    for (const listener of pending) {
      listener(resolved);
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exitInfo) return;
    this.signals.push(signal);
    this.onKill?.(signal);
    if (this.autoExitOnKill) {
      this.exit({ code: null, signal });
    }
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

  waitForExit(): Promise<CommandExitInfo> {
    return new Promise((resolve) => {
      this.onExit((info) => resolve(info));
    });
  }
}

class FakeChunkStream implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];
  private ended = false;
  private consumerTaken = false;

  push(chunk: string): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
      return;
    }
    this.queue.push(chunk);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    if (this.consumerTaken) {
      throw new Error('FakeChunkStream is single-consumer; it was already iterated.');
    }
    this.consumerTaken = true;
    return {
      next: () => {
        const chunk = this.queue.shift();
        if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<string>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
