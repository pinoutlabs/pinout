/**
 * Typed wrappers around the libgpiod v2 command-line tools.
 *
 * Flags used (verified against the libgpiod v2.2/v2.3 tool documentation):
 *
 * | tool        | flags                                                          |
 * | ----------- | -------------------------------------------------------------- |
 * | `gpiodetect`| none; prints `gpiochipN [label] (N lines)`                     |
 * | `gpioinfo`  | `--chip <chip>`                                                 |
 * | `gpioget`   | `--chip`, `--numeric`, `--as-is`, `--bias <pull-up|pull-down|   |
 * |             | disabled>`, `--consumer <name>`                                 |
 * | `gpioset`   | `--chip`, `--consumer`; holds lines until killed               |
 * | `gpiomon`   | `--chip`, `--consumer`, `--edges both`, `--format=%o %e %S`     |
 *
 * Documented consequences that shape the API:
 *
 * - `gpioset` holds requested lines until the process exits, and the kernel
 *   releases every line a process requested when that process dies. Holding a
 *   line therefore means owning a live `gpioset` child ({@link holdLines}),
 *   and releasing a line means terminating it.
 * - Setting a line once and exiting is the documented
 *   `gpioset --hold-period <period> -t0 <lines>` pattern ({@link setLinesOnce});
 *   after exit the line is released and its level is no longer guaranteed.
 *   Verified against the libgpiod v2.2.4 `gpioset.c` source: a single toggle
 *   period of 0 makes the toggle sequence return immediately (no toggle), the
 *   hold period is then slept out, and `gpioset` exits instead of waiting.
 * - Bias values are `pull-up`, `pull-down`, `disabled`; `as-is` (leave bias
 *   unchanged) is expressed by omitting `--bias` entirely.
 * - `gpiomon` event timestamps default to CLOCK_MONOTONIC; this adapter adds
 *   its own wall-clock receipt time to every event.
 * - Only libgpiod v2 syntax is supported. On libgpiod v1 the tools reject
 *   these flags with a nonzero exit, which surfaces as a loud
 *   `GPIO_OPERATION_FAILED` — never a silent misbehavior.
 *
 * No shell is ever involved: every invocation is an argument array handed to
 * a {@link CommandRunner}.
 *
 * Debounce is implemented in software (per-line event filtering) rather than
 * through `gpiomon --debounce-period` so the produced event stream is
 * identical across libgpiod v2 releases and is unit-testable without a kernel
 * GPIO simulator. See INTEGRATION_NOTES.md for the flag alternative.
 */
import type { CommandExitInfo, CommandRunner, CommandStream } from './runner.js';
import {
  LibgpiodError,
  commandTimeoutError,
  toolFailureError,
  toolMissingError,
} from './errors.js';
import { assertLinux } from './platform.js';
import {
  parseGpiodetectOutput,
  parseGpioinfoOutput,
  parseGpiogetValues,
  parseGpiomonLine,
  type GpioChipInfo,
  type GpioinfoResult,
} from './parser.js';

export const libgpiodToolNames = {
  detect: 'gpiodetect',
  info: 'gpioinfo',
  get: 'gpioget',
  set: 'gpioset',
  mon: 'gpiomon',
} as const;

/** Bias setting vocabulary shared by `gpioget`/`gpioset`; `as-is` omits the flag. */
export type LibgpiodBiasSetting = 'pull-up' | 'pull-down' | 'disabled' | 'as-is';

/** Consumer name libgpiod records for lines requested by Pinout. */
export const libgpiodConsumerName = 'pinout';

/** Locale pinned so tool output is byte-stable for the parsers. */
const TOOL_ENV: Record<string, string> = { LC_ALL: 'C', LANG: 'C' };

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_GRACE_MS = 50;
const DEFAULT_HOLD_PERIOD_MS = 20;
const DEFAULT_TERMINATE_TIMEOUT_MS = 1000;
const STDERR_CAPTURE_LIMIT = 4096;

export interface GpioToolsOptions {
  runner: CommandRunner;
  /** Host platform override (test seam). Defaults to `process.platform`. */
  platform?: string;
  /** Default per-invocation timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** How long a holding/monitoring process must survive before it is trusted (default 50). */
  startupGraceMs?: number;
}

export interface GpioLineRawValue {
  offset: number;
  /** Raw electrical level: 0 or 1. Logical/active-low translation is the caller's job. */
  raw: 0 | 1;
}

export interface GpioGetOptions {
  bias?: LibgpiodBiasSetting;
  /** Never force the line direction to input while reading (default true). */
  asIs?: boolean;
  timeoutMs?: number;
}

export interface GpioSetOptions {
  /** How long the set-then-exit process holds the value before releasing (default 20ms). */
  holdPeriodMs?: number;
  timeoutMs?: number;
}

export interface HoldLinesOptions {
  startupGraceMs?: number;
}

export interface GpioWatchEvent {
  offset: number;
  /** Raw electrical level implied by the edge: rising -> 1, falling -> 0. */
  raw: 0 | 1;
  edge: 'rising' | 'falling';
  /** Device-monotonic timestamp printed by gpiomon (not wall clock). */
  deviceTimestampSeconds: number | null;
  /** Wall-clock time this adapter received/parsed the event. */
  receivedAt: Date;
}

export interface GpioWatchStats {
  events: number;
  debounced: number;
  unrecognizedLines: number;
  lastEventReceivedAt: string | null;
}

export interface GpioWatchOptions {
  /** Drop events arriving less than this long after the previous accepted event on a line. */
  debounceMs?: number;
  startupGraceMs?: number;
  onEvent: (event: GpioWatchEvent) => void;
  onExit?: (info: CommandExitInfo) => void;
}

/** A live `gpioset` child that keeps its lines driven until terminated. */
export interface HeldLines {
  readonly chip: string;
  readonly values: readonly GpioLineRawValue[];
  readonly pid: number | undefined;
  /** Resolves once the holder exits. Never rejects. */
  readonly exited: Promise<CommandExitInfo>;
  /** SIGTERM, then SIGKILL after `timeoutMs`; resolves with the exit info. */
  terminate(timeoutMs?: number): Promise<CommandExitInfo>;
  /** Best-effort stderr captured so far. */
  stderrText(): string;
}

/** A live `gpiomon` child translating edges into callback events. */
export interface GpioWatch {
  readonly chip: string;
  readonly offsets: readonly number[];
  readonly pid: number | undefined;
  readonly exited: Promise<CommandExitInfo>;
  readonly stats: GpioWatchStats;
  stop(timeoutMs?: number): Promise<CommandExitInfo>;
  stderrText(): string;
}

export class GpioTools {
  private readonly runner: CommandRunner;
  private readonly platform: string;
  private readonly timeoutMs: number;
  private readonly startupGraceMs: number;

  constructor(options: GpioToolsOptions) {
    this.runner = options.runner;
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  }

  /** `gpiodetect` — list every GPIO chip on the host. Read-only. */
  async detectChips(options: { timeoutMs?: number } = {}): Promise<GpioChipInfo[]> {
    assertLinux(libgpiodToolNames.detect, this.platform);
    const result = await this.run(libgpiodToolNames.detect, [], options.timeoutMs);
    return parseGpiodetectOutput(result.stdout);
  }

  /** `gpioinfo --chip <chip>` — list every line of one chip. Read-only. */
  async infoChip(chip: string, options: { timeoutMs?: number } = {}): Promise<GpioinfoResult> {
    assertLinux(libgpiodToolNames.info, this.platform);
    const result = await this.run(libgpiodToolNames.info, ['--chip', chip], options.timeoutMs);
    return parseGpioinfoOutput(result.stdout);
  }

  /**
   * `gpioget --numeric` — read raw levels for the given offsets, in order.
   *
   * `--as-is` is passed by default so a read never forces a configured output
   * back to input direction. Reading a line currently requested by another
   * process (including a holder owned by this backend) fails with the tool's
   * EBUSY error; that is reported honestly rather than faked from cache.
   */
  async getLines(
    chip: string,
    offsets: readonly number[],
    options: GpioGetOptions = {},
  ): Promise<number[]> {
    assertLinux(libgpiodToolNames.get, this.platform);
    if (offsets.length === 0) {
      throw new LibgpiodError('VALIDATION_ERROR', 'gpioget requires at least one line offset.');
    }
    for (const offset of offsets) assertOffset(offset, libgpiodToolNames.get);

    const args = ['--chip', chip, '--consumer', libgpiodConsumerName, '--numeric'];
    if (options.asIs !== false) args.push('--as-is');
    if (options.bias !== undefined && options.bias !== 'as-is') args.push('--bias', options.bias);
    for (const offset of offsets) args.push(String(offset));

    const result = await this.run(libgpiodToolNames.get, args, options.timeoutMs);
    const values = parseGpiogetValues(result.stdout);
    if (values.length !== offsets.length) {
      throw new LibgpiodError(
        'GPIO_OPERATION_FAILED',
        `gpioget printed ${values.length} values for ${offsets.length} requested lines; refusing to guess the mapping.`,
        {
          phase: 'parse',
          tool: libgpiodToolNames.get,
          args,
          stdout: result.stdout,
          requestedOffsets: [...offsets],
        },
      );
    }
    return values;
  }

  /**
   * `gpioset --hold-period <period> -t0` — set lines, hold briefly, release.
   *
   * The documented v2 pattern for "set and exit": `-t0` makes gpioset exit
   * instead of holding, `--hold-period` keeps the value driven for at least
   * that long before the exit. After exit the kernel releases the lines, so
   * the level is not guaranteed afterwards — callers must treat this as a
   * momentary write, which is exactly how the backend reports it.
   */
  async setLinesOnce(
    chip: string,
    values: readonly GpioLineRawValue[],
    options: GpioSetOptions = {},
  ): Promise<void> {
    assertLinux(libgpiodToolNames.set, this.platform);
    assertRawValues(values, libgpiodToolNames.set);
    const holdPeriodMs = options.holdPeriodMs ?? DEFAULT_HOLD_PERIOD_MS;
    if (!Number.isInteger(holdPeriodMs) || holdPeriodMs < 0) {
      throw new LibgpiodError(
        'VALIDATION_ERROR',
        `holdPeriodMs must be a non-negative integer, received ${String(holdPeriodMs)}.`,
      );
    }
    const args = [
      '--chip',
      chip,
      '--consumer',
      libgpiodConsumerName,
      '--hold-period',
      `${holdPeriodMs}ms`,
      '-t0',
      ...values.map((value) => `${value.offset}=${value.raw}`),
    ];
    await this.run(libgpiodToolNames.set, args, options.timeoutMs);
  }

  /**
   * Spawn a `gpioset` child that holds the requested values until terminated.
   *
   * Resolves only after the child has survived a startup grace window; a child
   * that exits inside that window means the lines could not be requested
   * (missing chip, busy line, wrong libgpiod version) and is reported as an
   * error instead of a phantom acknowledgement.
   */
  async holdLines(
    chip: string,
    values: readonly GpioLineRawValue[],
    options: HoldLinesOptions = {},
  ): Promise<HeldLines> {
    assertLinux(libgpiodToolNames.set, this.platform);
    assertRawValues(values, libgpiodToolNames.set);
    const args = [
      '--chip',
      chip,
      '--consumer',
      libgpiodConsumerName,
      ...values.map((value) => `${value.offset}=${value.raw}`),
    ];
    const stream = this.runner.spawn(libgpiodToolNames.set, args, { env: TOOL_ENV });
    const stderr = collectStream(stream.stderr);
    await this.confirmRunning(
      stream,
      options.startupGraceMs ?? this.startupGraceMs,
      () => stderr.text(),
      libgpiodToolNames.set,
      args,
    );
    return new HeldGpioLines(chip, values, stream, stderr);
  }

  /**
   * Spawn `gpiomon --format=%o %e %S` and translate parsed edges into events.
   *
   * Unrecognized output lines (banners, notices, future formats) are counted
   * in `stats.unrecognizedLines`, never guessed into events. `onExit` fires
   * after establishment if the monitor dies unexpectedly.
   */
  async watchLines(
    chip: string,
    offsets: readonly number[],
    options: GpioWatchOptions,
  ): Promise<GpioWatch> {
    assertLinux(libgpiodToolNames.mon, this.platform);
    if (offsets.length === 0) {
      throw new LibgpiodError('VALIDATION_ERROR', 'gpiomon requires at least one line offset.');
    }
    for (const offset of offsets) assertOffset(offset, libgpiodToolNames.mon);

    const args = [
      '--chip',
      chip,
      '--consumer',
      libgpiodConsumerName,
      '--format=%o %e %S',
      '--edges',
      'both',
      ...offsets.map(String),
    ];
    const stream = this.runner.spawn(libgpiodToolNames.mon, args, { env: TOOL_ENV });
    const stderr = collectStream(stream.stderr);
    await this.confirmRunning(
      stream,
      options.startupGraceMs ?? this.startupGraceMs,
      () => stderr.text(),
      libgpiodToolNames.mon,
      args,
    );
    return new GpioLineWatch(chip, offsets, stream, stderr, options);
  }

  private async run(
    tool: string,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string }> {
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    const result = await this.runner.run(tool, [...args], {
      timeoutMs: effectiveTimeout,
      env: TOOL_ENV,
    });
    if (result.spawnError) {
      if (result.spawnError.code === 'ENOENT') {
        throw toolMissingError(tool, result.spawnError);
      }
      throw new LibgpiodError(
        'GPIO_OPERATION_FAILED',
        `'${tool}' could not be executed (${result.spawnError.code}).`,
        {
          phase: 'spawn',
          tool,
          args: [...args],
          spawnErrorCode: result.spawnError.code,
          spawnErrorMessage: result.spawnError.message,
        },
      );
    }
    if (result.timedOut) {
      throw commandTimeoutError(tool, [...args], effectiveTimeout);
    }
    if (result.code !== 0) {
      throw toolFailureError({
        tool,
        args: [...args],
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return { stdout: result.stdout };
  }

  /**
   * Wait out the startup grace window. Two `setImmediate` turns let the
   * background stderr collectors drain what the kernel already delivered, so
   * failure messages are as complete as the run loop can make them.
   */
  private async confirmRunning(
    stream: CommandStream,
    graceMs: number,
    stderrText: () => string,
    tool: string,
    args: readonly string[],
  ): Promise<void> {
    const exited = exitPromise(stream);
    const timeoutSentinel = { timedOut: true as const };
    const outcome = await Promise.race([exited, sleep(graceMs).then(() => timeoutSentinel)]);
    if ('timedOut' in outcome) return;
    await flushMicrotasks();
    await flushMicrotasks();
    if (outcome.error) {
      if (outcome.error.code === 'ENOENT') {
        throw toolMissingError(tool, outcome.error);
      }
      throw new LibgpiodError(
        'GPIO_OPERATION_FAILED',
        `'${tool}' could not be executed (${outcome.error.code}): ${outcome.error.message}`,
        { phase: 'spawn', tool, args: [...args], spawnErrorCode: outcome.error.code },
      );
    }
    throw toolFailureError({
      tool,
      args: [...args],
      exitCode: outcome.code,
      stdout: '',
      stderr: stderrText(),
    });
  }
}

class HeldGpioLines implements HeldLines {
  readonly chip: string;
  readonly values: readonly GpioLineRawValue[];
  private readonly stream: CommandStream;
  private readonly stderr: StreamCollector;
  private readonly exit: Promise<CommandExitInfo>;

  constructor(
    chip: string,
    values: readonly GpioLineRawValue[],
    stream: CommandStream,
    stderr: StreamCollector,
  ) {
    this.chip = chip;
    this.values = values.map((value) => ({ ...value }));
    this.stream = stream;
    this.stderr = stderr;
    this.exit = exitPromise(stream);
  }

  get pid(): number | undefined {
    return this.stream.pid;
  }

  get exited(): Promise<CommandExitInfo> {
    return this.exit;
  }

  terminate(timeoutMs: number = DEFAULT_TERMINATE_TIMEOUT_MS): Promise<CommandExitInfo> {
    return terminateStream(this.stream, this.exit, timeoutMs);
  }

  stderrText(): string {
    return this.stderr.text();
  }
}

class GpioLineWatch implements GpioWatch {
  readonly chip: string;
  readonly offsets: readonly number[];
  private readonly stream: CommandStream;
  private readonly stderr: StreamCollector;
  private readonly exit: Promise<CommandExitInfo>;
  private readonly debounceMs: number;
  private readonly onEvent: (event: GpioWatchEvent) => void;
  private readonly lastAcceptedMs = new Map<number, number>();
  private eventCount = 0;
  private debouncedCount = 0;
  private unrecognizedCount = 0;
  private lastEventAt: string | null = null;

  constructor(
    chip: string,
    offsets: readonly number[],
    stream: CommandStream,
    stderr: StreamCollector,
    options: GpioWatchOptions,
  ) {
    this.chip = chip;
    this.offsets = [...offsets];
    this.stream = stream;
    this.stderr = stderr;
    this.debounceMs = Math.max(0, options.debounceMs ?? 0);
    this.onEvent = options.onEvent;
    this.exit = exitPromise(stream);
    if (options.onExit) {
      const onExit = options.onExit;
      this.exit.then((info) => {
        onExit(info);
      });
    }
    void this.consume();
  }

  get pid(): number | undefined {
    return this.stream.pid;
  }

  get exited(): Promise<CommandExitInfo> {
    return this.exit;
  }

  get stats(): GpioWatchStats {
    return {
      events: this.eventCount,
      debounced: this.debouncedCount,
      unrecognizedLines: this.unrecognizedCount,
      lastEventReceivedAt: this.lastEventAt,
    };
  }

  stop(timeoutMs: number = DEFAULT_TERMINATE_TIMEOUT_MS): Promise<CommandExitInfo> {
    return terminateStream(this.stream, this.exit, timeoutMs);
  }

  stderrText(): string {
    return this.stderr.text();
  }

  private async consume(): Promise<void> {
    let buffer = '';
    try {
      for await (const chunk of this.stream.stdout) {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline === -1) break;
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          this.handleLine(line);
        }
      }
      const remainder = buffer.trim();
      if (remainder.length > 0) this.handleLine(remainder);
    } catch {
      // Stream torn down by stop(); pending bytes are intentionally discarded.
    }
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    const parsed = parseGpiomonLine(line);
    if (!parsed || parsed.offset === null || !this.offsets.includes(parsed.offset)) {
      this.unrecognizedCount += 1;
      return;
    }
    const raw: 0 | 1 = parsed.edge === 'rising' ? 1 : 0;
    const now = Date.now();
    const last = this.lastAcceptedMs.get(parsed.offset);
    if (this.debounceMs > 0 && last !== undefined && now - last < this.debounceMs) {
      this.debouncedCount += 1;
      return;
    }
    this.lastAcceptedMs.set(parsed.offset, now);
    this.eventCount += 1;
    this.lastEventAt = new Date(now).toISOString();
    this.onEvent({
      offset: parsed.offset,
      raw,
      edge: parsed.edge,
      deviceTimestampSeconds: parsed.deviceTimestampSeconds,
      receivedAt: new Date(now),
    });
  }
}

interface StreamCollector {
  text(): string;
}

function collectStream(
  stream: AsyncIterable<string>,
  limit = STDERR_CAPTURE_LIMIT,
): StreamCollector {
  const chunks: string[] = [];
  let total = 0;
  const consume = async (): Promise<void> => {
    try {
      for await (const chunk of stream) {
        if (total >= limit) continue;
        chunks.push(chunk);
        total += chunk.length;
      }
    } catch {
      // Stream closed mid-read; captured text so far is still useful.
    }
  };
  void consume();
  return {
    text: () => chunks.join('').slice(0, limit),
  };
}

function exitPromise(stream: CommandStream): Promise<CommandExitInfo> {
  return new Promise<CommandExitInfo>((resolve) => {
    stream.onExit((info) => {
      resolve(info);
    });
  });
}

async function terminateStream(
  stream: CommandStream,
  exited: Promise<CommandExitInfo>,
  timeoutMs: number,
): Promise<CommandExitInfo> {
  const timeoutSentinel = { timedOut: true as const };
  stream.kill('SIGTERM');
  const outcome = await Promise.race([exited, sleep(timeoutMs).then(() => timeoutSentinel)]);
  if (!('timedOut' in outcome)) return outcome;
  stream.kill('SIGKILL');
  return exited;
}

function assertOffset(offset: number, tool: string): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new LibgpiodError(
      'VALIDATION_ERROR',
      `${tool} line offset must be a non-negative integer, received ${String(offset)}.`,
    );
  }
}

function assertRawValues(values: readonly GpioLineRawValue[], tool: string): void {
  if (values.length === 0) {
    throw new LibgpiodError('VALIDATION_ERROR', `${tool} requires at least one line value.`);
  }
  const seen = new Set<number>();
  for (const value of values) {
    assertOffset(value.offset, tool);
    if (value.raw !== 0 && value.raw !== 1) {
      throw new LibgpiodError(
        'VALIDATION_ERROR',
        `${tool} raw value must be 0 or 1, received ${String(value.raw)}.`,
      );
    }
    if (seen.has(value.offset)) {
      throw new LibgpiodError(
        'VALIDATION_ERROR',
        `${tool} received duplicate offset ${value.offset} in one invocation.`,
      );
    }
    seen.add(value.offset);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    unrefTimer(timer);
  });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}
