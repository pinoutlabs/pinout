/**
 * `LibgpiodBackend` — a `DeviceBackend` over the libgpiod v2 CLI tools.
 *
 * Safety model (mirrors the ESP32 GPIO / Modbus lamp conventions):
 *
 * - Only lines declared in the device configuration can ever be touched. An
 *   undeclared offset or name is refused with `GPIO_LINE_NOT_FOUND`; there is
 *   no "any pin" escape hatch.
 * - `polarity` describes the load wiring and is validated against
 *   `safeLevel`: a configuration whose safe state would ENERGIZE the load is
 *   rejected outright (active-high + `safeLevel: 'high'`, active-low +
 *   `safeLevel: 'low'`), exactly like the Modbus lamp adapter.
 * - Inputs are read-only: writes to input lines are refused, and bias applies
 *   to inputs only.
 * - Writes are proven only as far as the tool proves them. A live `gpioset`
 *   child is an acknowledgement that the line was requested; it is never
 *   treated as an observation of the physical level. Observations come only
 *   from `gpioget` reads and `gpiomon` events, and are recorded with source
 *   `gpio-readback`.
 * - `safeState()` applies the configured safe levels (driving lines to their
 *   de-energized level first, then releasing `high-z` lines, then leaving
 *   `hold` lines untouched), cancels pending pulses, and terminates every
 *   holder. `close()` does the same and also stops watches.
 *
 * Known physical limits, stated instead of hidden: a held line is only held
 * while this process (and its `gpioset` child) is alive; a host crash releases
 * every line it requested. `safeState()` therefore cannot protect against a
 * crashed host — hardware fail-safes remain mandatory.
 */
import {
  DeviceError,
  computeFreshness,
  recordAcknowledged,
  recordCommanded,
  recordObserved,
  unknownEvidence,
  type DeviceBackend,
  type EvidenceProvenance,
  type EvidenceSource,
  type EvidenceState,
} from '@pinout/core';
import { LibgpiodError } from './errors.js';
import { normalizeChipName } from './parser.js';
import { assertLinux } from './platform.js';
import { NodeCommandRunner, type CommandRunner } from './runner.js';
import {
  GpioTools,
  type GpioWatch,
  type GpioWatchEvent,
  type HeldLines,
  type LibgpiodBiasSetting,
} from './tools.js';

export type LibgpiodDirection = 'input' | 'output';
export type LibgpiodPolarity = 'active-high' | 'active-low';
export type LibgpiodSafeLevel = 'low' | 'high' | 'high-z' | 'hold';
export type LibgpiodBias = LibgpiodBiasSetting;

export interface LibgpiodLineConfig {
  /** Line offset within the chip (GPIO number on many SBCs). Required. */
  offset: number;
  /** Logical name used by capabilities; defaults to `line<offset>`. */
  name?: string;
  /** Default `input`. */
  direction?: LibgpiodDirection;
  /** Default `active-high`. Describes the load, never the kernel line flag. */
  polarity?: LibgpiodPolarity;
  /**
   * Level applied by `gpio.safeState`. Defaults to `low` for active-high
   * outputs, `high` for active-low outputs, and `high-z` for inputs.
   */
  safeLevel?: LibgpiodSafeLevel;
  /** Bias for input lines: `pull-up`, `pull-down`, `disabled`, or `as-is`. */
  bias?: LibgpiodBias;
}

export interface LibgpiodBackendOptions {
  /** Chip name, number, or path; canonicalized to `gpiochipN`. Default `gpiochip0`. */
  chip?: string;
  /** Declarative line allowlist. */
  lines?: LibgpiodLineConfig[];
  /** Command execution seam. Defaults to {@link NodeCommandRunner}. */
  runner?: CommandRunner;
  /** Host platform override (test seam). Defaults to `process.platform`. */
  platform?: string;
  /** Default per-invocation timeout in milliseconds (default 5000). */
  toolTimeoutMs?: number;
  /** Startup grace for holder/monitor processes in milliseconds (default 50). */
  holdStartupGraceMs?: number;
  /** Hold window used by non-persistent writes before the tool exits (default 20ms). */
  writeHoldPeriodMs?: number;
  /** Age beyond which an observation is reported stale (default 5000ms). */
  observationMaxAgeMs?: number;
  /** Default watch debounce in milliseconds (default 0 = every edge). */
  watchDebounceMs?: number;
  /** Evidence provenance; defaults to `hardware` on Linux and `unknown` elsewhere. */
  provenance?: EvidenceProvenance;
}

export interface ValidatedLibgpiodLine {
  name: string;
  offset: number;
  direction: LibgpiodDirection;
  polarity: LibgpiodPolarity;
  safeLevel: LibgpiodSafeLevel;
  bias: LibgpiodBias;
}

export interface ValidatedLibgpiodConfig {
  chip: string;
  lines: ValidatedLibgpiodLine[];
  toolTimeoutMs: number;
  holdStartupGraceMs: number;
  writeHoldPeriodMs: number;
  observationMaxAgeMs: number;
  watchDebounceMs: number;
  provenance: EvidenceProvenance;
  platform: string;
}

export const libgpiodSafeStateNote =
  'Safe state drives configured safe levels, releases high-z lines, and leaves hold lines untouched. A host crash releases every line this process requested; hardware fail-safes are always required.';

const KNOWN_POLARITIES: LibgpiodPolarity[] = ['active-high', 'active-low'];
const KNOWN_SAFE_LEVELS: LibgpiodSafeLevel[] = ['low', 'high', 'high-z', 'hold'];
const KNOWN_BIASES: LibgpiodBias[] = ['pull-up', 'pull-down', 'disabled', 'as-is'];
const KNOWN_DIRECTIONS: LibgpiodDirection[] = ['input', 'output'];

/** Validate and normalize raw device configuration. Throws `LibgpiodError`. */
export function validateLibgpiodConfig(
  rawConfig: Record<string, unknown> = {},
): ValidatedLibgpiodConfig {
  const rawChip = rawConfig.chip;
  let chip = 'gpiochip0';
  if (rawChip !== undefined) {
    if (typeof rawChip !== 'string' || rawChip.trim().length === 0) {
      throw unsupportedConfiguration('GPIO configuration "chip" must be a non-empty string.');
    }
    chip = normalizeChipName(rawChip);
  }

  const rawLines = rawConfig.lines;
  if (rawLines !== undefined && !Array.isArray(rawLines)) {
    throw unsupportedConfiguration('GPIO configuration "lines" must be an array.');
  }
  const lines: ValidatedLibgpiodLine[] = [];
  const seenNames = new Set<string>();
  const seenOffsets = new Set<number>();
  for (const [index, entry] of (rawLines ?? []).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw unsupportedConfiguration(`GPIO configuration lines[${index}] must be an object.`);
    }
    const item = entry as Record<string, unknown>;

    const offset = item.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw unsupportedConfiguration(
        `GPIO configuration lines[${index}].offset must be a non-negative integer.`,
      );
    }
    if (seenOffsets.has(offset)) {
      throw unsupportedConfiguration(
        `GPIO configuration declares offset ${offset} twice; each line must appear once.`,
      );
    }
    seenOffsets.add(offset);

    let name: string;
    if (item.name === undefined) {
      name = `line${offset}`;
    } else if (typeof item.name !== 'string' || item.name.trim().length === 0) {
      throw unsupportedConfiguration(
        `GPIO configuration lines[${index}].name must be a non-empty string when provided.`,
      );
    } else {
      name = item.name.trim();
    }
    if (seenNames.has(name)) {
      throw unsupportedConfiguration(`GPIO configuration declares line name '${name}' twice.`);
    }
    seenNames.add(name);

    const rawDirection = item.direction ?? 'input';
    if (!KNOWN_DIRECTIONS.includes(rawDirection as LibgpiodDirection)) {
      throw unsupportedConfiguration(
        `GPIO line '${name}' direction must be 'input' or 'output', received '${String(rawDirection)}'.`,
      );
    }
    const direction = rawDirection as LibgpiodDirection;

    const rawPolarity = item.polarity ?? 'active-high';
    if (!KNOWN_POLARITIES.includes(rawPolarity as LibgpiodPolarity)) {
      throw unsupportedConfiguration(
        `GPIO line '${name}' polarity must be 'active-high' or 'active-low', received '${String(rawPolarity)}'.`,
      );
    }
    const polarity = rawPolarity as LibgpiodPolarity;

    const rawSafeLevel = item.safeLevel;
    let safeLevel: LibgpiodSafeLevel;
    if (rawSafeLevel === undefined) {
      if (direction === 'input') {
        safeLevel = 'high-z';
      } else {
        safeLevel = polarity === 'active-low' ? 'high' : 'low';
      }
    } else {
      if (!KNOWN_SAFE_LEVELS.includes(rawSafeLevel as LibgpiodSafeLevel)) {
        throw unsupportedConfiguration(
          `GPIO line '${name}' safeLevel must be 'low', 'high', 'high-z', or 'hold', received '${String(rawSafeLevel)}'.`,
        );
      }
      safeLevel = rawSafeLevel as LibgpiodSafeLevel;
      if (direction === 'input' && (safeLevel === 'low' || safeLevel === 'high')) {
        throw unsupportedConfiguration(
          `GPIO line '${name}' is an input; inputs cannot be driven to a safe level. Use 'high-z' or 'hold'.`,
        );
      }
      if (polarity === 'active-high' && safeLevel === 'high') {
        throw unsupportedConfiguration(
          `GPIO line '${name}' is active-high and cannot specify safeLevel 'high' because safe state would energize the load.`,
        );
      }
      if (polarity === 'active-low' && safeLevel === 'low') {
        throw unsupportedConfiguration(
          `GPIO line '${name}' is active-low and cannot specify safeLevel 'low' because safe state would energize the load.`,
        );
      }
    }

    const rawBias = item.bias;
    let bias: LibgpiodBias = 'as-is';
    if (rawBias !== undefined) {
      if (!KNOWN_BIASES.includes(rawBias as LibgpiodBias)) {
        throw unsupportedConfiguration(
          `GPIO line '${name}' bias must be 'pull-up', 'pull-down', 'disabled', or 'as-is', received '${String(rawBias)}'.`,
        );
      }
      if (direction === 'output' && rawBias !== 'as-is') {
        throw unsupportedConfiguration(
          `GPIO line '${name}' is an output; bias applies to input lines only.`,
        );
      }
      bias = rawBias as LibgpiodBias;
    }

    lines.push({ name, offset, direction, polarity, safeLevel, bias });
  }

  const platform = typeof rawConfig.platform === 'string' ? rawConfig.platform : process.platform;
  const rawProvenance = rawConfig.provenance;
  const provenance: EvidenceProvenance =
    rawProvenance === 'hardware' || rawProvenance === 'simulated' || rawProvenance === 'unknown'
      ? rawProvenance
      : platform === 'linux'
        ? 'hardware'
        : 'unknown';

  return {
    chip,
    lines,
    toolTimeoutMs: readPositive(rawConfig.toolTimeoutMs, 'toolTimeoutMs', 5000),
    holdStartupGraceMs: readNonNegative(rawConfig.holdStartupGraceMs, 'holdStartupGraceMs', 50),
    writeHoldPeriodMs: readNonNegative(rawConfig.writeHoldPeriodMs, 'writeHoldPeriodMs', 20),
    observationMaxAgeMs: readPositive(rawConfig.observationMaxAgeMs, 'observationMaxAgeMs', 5000),
    watchDebounceMs: readNonNegative(rawConfig.watchDebounceMs, 'watchDebounceMs', 0),
    provenance,
    platform,
  };
}

interface HolderRecord {
  held: HeldLines;
  expectedExit: boolean;
}

interface LineRuntimeState {
  readonly config: ValidatedLibgpiodLine;
  evidence: EvidenceState<boolean>;
  rawLevel: 0 | 1 | null;
  releasedOnExit: boolean;
  holder: HolderRecord | null;
  cancelPulse: (() => void) | null;
}

interface WatchRecord {
  watch: GpioWatch | null;
  offsets: readonly number[];
  lines: Array<{ line: string; offset: number }>;
}

export type SafeLevelAction = 'driven' | 'released' | 'kept' | 'skipped';

export interface SafeLevelOutcome {
  line: string;
  offset: number;
  safeLevel: LibgpiodSafeLevel;
  action: SafeLevelAction;
  raw: 0 | 1 | null;
  reason?: string;
}

export class LibgpiodBackend implements DeviceBackend {
  readonly kind = 'protocol' as const;
  private readonly config: ValidatedLibgpiodConfig;
  private readonly tools: GpioTools;
  private readonly linesByName = new Map<string, LineRuntimeState>();
  private readonly linesByOffset = new Map<number, LineRuntimeState>();
  private readonly listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private watch: WatchRecord | null = null;
  private closed = false;

  constructor(options: LibgpiodBackendOptions = {}) {
    this.config = validateLibgpiodConfig(options as Record<string, unknown>);
    this.tools = new GpioTools({
      runner: options.runner ?? new NodeCommandRunner(),
      platform: this.config.platform,
      timeoutMs: this.config.toolTimeoutMs,
      startupGraceMs: this.config.holdStartupGraceMs,
    });
    for (const line of this.config.lines) {
      const state: LineRuntimeState = {
        config: line,
        evidence: unknownEvidence<boolean>(this.config.provenance),
        rawLevel: null,
        releasedOnExit: false,
        holder: null,
        cancelPulse: null,
      };
      this.linesByName.set(line.name, state);
      this.linesByOffset.set(line.offset, state);
    }
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.linesByName.values()) {
      this.cancelPulse(state);
    }
    await Promise.allSettled(
      [...this.linesByName.values()].map((state) => this.releaseHolder(state)),
    );
    const watch = this.watch;
    this.watch = null;
    if (watch?.watch) {
      await watch.watch.stop().catch(() => undefined);
    }
    this.listeners.clear();
  }

  getOperationalState(): Record<string, unknown> {
    const now = Date.now();
    const lines: Record<string, unknown> = {};
    let observedAtMs: number | null = null;
    for (const state of this.linesByName.values()) {
      const fresh = computeFreshness(state.evidence, now, this.config.observationMaxAgeMs);
      const last = lastKnown(fresh);
      const observedAt = state.evidence.observed.at;
      if (observedAt !== null) {
        const parsed = new Date(observedAt).getTime();
        if (!Number.isNaN(parsed) && (observedAtMs === null || parsed > observedAtMs)) {
          observedAtMs = parsed;
        }
      }
      lines[state.config.name] = {
        offset: state.config.offset,
        direction: state.config.direction,
        polarity: state.config.polarity,
        safeLevel: state.config.safeLevel,
        bias: state.config.bias,
        value: last.value,
        raw: state.rawLevel,
        at: last.at,
        source: last.source,
        freshnessMs: fresh.freshnessMs,
        stale: fresh.stale,
        held: state.holder !== null,
        releasedOnExit: state.releasedOnExit,
        watching: this.watch !== null && this.watch.offsets.includes(state.config.offset),
      };
    }
    return {
      chip: this.config.chip,
      platform: this.config.platform,
      provenance: this.config.provenance,
      observedAt: observedAtMs,
      note: libgpiodSafeStateNote,
      lines,
    };
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    const now = Date.now();
    const evidence: Record<string, EvidenceState<unknown>> = {};
    for (const state of this.linesByName.values()) {
      evidence[`line:${state.config.name}`] = computeFreshness(
        state.evidence,
        now,
        this.config.observationMaxAgeMs,
      );
    }
    return evidence;
  }

  /** Best-effort safe state for every declared line (see {@link libgpiodSafeStateNote}). */
  async safeState(): Promise<Record<string, unknown>> {
    return this.invokeSafeState({});
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'libgpiod backend is closed.');
    }
    assertLinux(`pinout/linux-gpio '${action}'`, this.config.platform);

    if (action === 'gpio.info') return this.invokeInfo(payload);
    if (action === 'gpio.read') return this.invokeRead(payload);
    if (action === 'gpio.write') return this.invokeWrite(payload);
    if (action === 'gpio.watch') return this.invokeWatch(payload);
    if (action === 'gpio.unwatch') return this.invokeUnwatch();
    if (action === 'gpio.safeState') return this.invokeSafeState(payload);

    throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
  }

  /** Read-only chip/line listing through `gpiodetect` + `gpioinfo`. */
  private async invokeInfo(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = payload.chip;
    let chip = this.config.chip;
    if (requested !== undefined) {
      if (typeof requested !== 'string' || requested.trim().length === 0) {
        throw new DeviceError('VALIDATION_ERROR', "'chip' must be a non-empty string when provided.");
      }
      chip = normalizeChipName(requested);
    }
    const chips = await this.tools.detectChips();
    if (!chips.some((info) => info.name === chip)) {
      throw new LibgpiodError(
        'GPIOCHIP_NOT_FOUND',
        `GPIO chip '${chip}' is not present on this host.`,
        { chip, availableChips: chips.map((info) => info.name) },
      );
    }
    const info = await this.tools.infoChip(chip);
    return { chips, chip, lines: info.lines, unparsedLines: info.unparsed };
  }

  private async invokeRead(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = this.resolveLine(payload);
    const bias: LibgpiodBias = state.config.direction === 'input' ? state.config.bias : 'as-is';
    const values = await this.tools.getLines(this.config.chip, [state.config.offset], { bias });
    const raw = values[0];
    if (raw !== 0 && raw !== 1) {
      throw new LibgpiodError(
        'GPIO_OPERATION_FAILED',
        `gpioget returned an unexpected value for line '${state.config.name}'.`,
        { tool: 'gpioget', raw },
      );
    }
    const now = new Date();
    const value = rawToLogical(raw, state.config.polarity);
    state.evidence = recordObserved(
      state.evidence,
      value,
      'gpio-readback',
      now,
      this.config.provenance,
      this.config.observationMaxAgeMs,
    );
    state.rawLevel = raw;
    return {
      line: state.config.name,
      offset: state.config.offset,
      raw,
      value,
      polarity: state.config.polarity,
      at: now.toISOString(),
      source: 'gpio-readback' as const,
    };
  }

  private async invokeWrite(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = this.resolveLine(payload);
    if (state.config.direction !== 'output') {
      throw new DeviceError(
        'VALIDATION_ERROR',
        `Line '${state.config.name}' is configured as an input and cannot be driven.`,
      );
    }
    const value = payload.value;
    if (typeof value !== 'boolean') {
      throw new DeviceError(
        'VALIDATION_ERROR',
        `'value' must be a boolean for gpio.write, received ${String(value)}.`,
      );
    }
    const pulseMs = payload.pulseMs;
    if (
      pulseMs !== undefined &&
      (typeof pulseMs !== 'number' || !Number.isFinite(pulseMs) || pulseMs <= 0)
    ) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        "'pulseMs' must be a positive finite number of milliseconds when provided.",
      );
    }
    const hold = payload.hold;
    if (hold !== undefined && typeof hold !== 'boolean') {
      throw new DeviceError('VALIDATION_ERROR', "'hold' must be a boolean when provided.");
    }

    const persist = hold !== false;
    const raw = logicalToRaw(value, state.config.polarity);
    const now = new Date();
    this.cancelPulse(state);
    state.evidence = recordCommanded(state.evidence, value, now, this.config.provenance);

    if (!persist) {
      await this.tools.setLinesOnce(this.config.chip, [{ offset: state.config.offset, raw }], {
        holdPeriodMs: this.config.writeHoldPeriodMs,
      });
      state.evidence = recordAcknowledged(state.evidence, value, now, this.config.provenance);
      state.rawLevel = raw;
      state.releasedOnExit = true;
      this.emit('gpio.changed', {
        line: state.config.name,
        offset: state.config.offset,
        value,
        raw,
        mode: 'once',
        releasedOnExit: true,
        at: now.toISOString(),
      });
      return {
        line: state.config.name,
        offset: state.config.offset,
        value,
        raw,
        mode: 'once',
        holdPeriodMs: this.config.writeHoldPeriodMs,
        releasedOnExit: true,
        at: now.toISOString(),
      };
    }

    if (typeof pulseMs === 'number') {
      return this.runPulse(state, value, raw, pulseMs);
    }

    await this.drive(state, raw);
    state.evidence = recordAcknowledged(state.evidence, value, now, this.config.provenance);
    state.releasedOnExit = false;
    this.emit('gpio.changed', {
      line: state.config.name,
      offset: state.config.offset,
      value,
      raw,
      mode: 'hold',
      at: now.toISOString(),
    });
    return {
      line: state.config.name,
      offset: state.config.offset,
      value,
      raw,
      mode: 'hold',
      held: true,
      at: now.toISOString(),
    };
  }

  private async runPulse(
    state: LineRuntimeState,
    value: boolean,
    activeRaw: 0 | 1,
    pulseMs: number,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    // Arm cancellation before awaiting drive so safeState() during startup still wins.
    let cancelledBeforeWait = false;
    state.cancelPulse = () => {
      cancelledBeforeWait = true;
    };
    await this.drive(state, activeRaw);
    if (cancelledBeforeWait) {
      state.cancelPulse = null;
      // safeState() (or another canceller) already owns applying the safe level.
      return {
        line: state.config.name,
        offset: state.config.offset,
        value,
        raw: activeRaw,
        mode: 'pulse',
        pulseMs,
        cancelled: true,
        at: now.toISOString(),
      };
    }
    state.evidence = recordAcknowledged(state.evidence, value, now, this.config.provenance);
    state.releasedOnExit = false;
    this.emit('gpio.changed', {
      line: state.config.name,
      offset: state.config.offset,
      value,
      raw: activeRaw,
      mode: 'pulse',
      phase: 'active',
      at: now.toISOString(),
    });

    const outcome = await this.waitForPulse(state, pulseMs);
    if (outcome === 'cancelled') {
      return {
        line: state.config.name,
        offset: state.config.offset,
        value,
        raw: activeRaw,
        mode: 'pulse',
        pulseMs,
        cancelled: true,
        at: now.toISOString(),
      };
    }

    const safe = await this.applySafeLevel(state, 'pulse-complete');
    this.emit('gpio.changed', {
      line: state.config.name,
      offset: state.config.offset,
      value: safe.raw === null ? null : rawToLogical(safe.raw, state.config.polarity),
      raw: safe.raw,
      mode: 'pulse',
      phase: 'complete',
      safeLevel: state.config.safeLevel,
      at: new Date().toISOString(),
    });
    return {
      line: state.config.name,
      offset: state.config.offset,
      value,
      raw: activeRaw,
      mode: 'pulse',
      pulseMs,
      returnedTo: {
        safeLevel: state.config.safeLevel,
        action: safe.action,
        raw: safe.raw,
      },
      at: now.toISOString(),
    };
  }

  private async invokeWatch(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const targets = this.resolveLines(payload);
    const rawDebounce = payload.debounceMs;
    if (
      rawDebounce !== undefined &&
      (typeof rawDebounce !== 'number' || !Number.isFinite(rawDebounce) || rawDebounce < 0)
    ) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        "'debounceMs' must be a non-negative finite number of milliseconds when provided.",
      );
    }
    const debounceMs = rawDebounce ?? this.config.watchDebounceMs;

    const previous = this.watch;
    this.watch = null;
    if (previous?.watch) {
      await previous.watch.stop().catch(() => undefined);
    }

    const offsets = targets.map((state) => state.config.offset);
    const record: WatchRecord = {
      watch: null,
      offsets: [...offsets],
      lines: targets.map((state) => ({
        line: state.config.name,
        offset: state.config.offset,
      })),
    };
    const watch = await this.tools.watchLines(this.config.chip, offsets, {
      debounceMs,
      onEvent: (event) => this.handleWatchEvent(event),
      onExit: (info) => {
        if (record.watch === null || this.watch !== record) return;
        this.watch = null;
        this.emit('gpio.watchStopped', {
          chip: this.config.chip,
          lines: record.lines,
          code: info.code,
          signal: info.signal,
          stderr: record.watch.stderrText(),
        });
      },
    });
    record.watch = watch;
    this.watch = record;

    return {
      watching: true,
      chip: this.config.chip,
      lines: record.lines,
      debounceMs,
      replacedLines: previous ? previous.lines : [],
    };
  }

  private async invokeUnwatch(): Promise<Record<string, unknown>> {
    const record = this.watch;
    if (!record?.watch) {
      return { watching: false, chip: this.config.chip, lines: [], stopped: false };
    }
    this.watch = null;
    await record.watch.stop().catch(() => undefined);
    return { watching: false, chip: this.config.chip, lines: record.lines, stopped: true };
  }

  private async invokeSafeState(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'libgpiod backend is closed.');
    }
    assertLinux("pinout/linux-gpio 'gpio.safeState'", this.config.platform);

    const hasTarget = payload.line !== undefined || payload.offset !== undefined;
    const outcomes: SafeLevelOutcome[] = [];
    if (hasTarget) {
      const state = this.resolveLine(payload);
      this.cancelPulse(state);
      outcomes.push(await this.applySafeLevel(state, 'safe-state'));
    } else {
      for (const state of this.orderForSafeState()) {
        this.cancelPulse(state);
        outcomes.push(await this.applySafeLevel(state, 'safe-state'));
      }
    }
    this.emit('safe_state.applied', {
      chip: this.config.chip,
      lines: outcomes,
      note: libgpiodSafeStateNote,
    });
    return { applied: true, chip: this.config.chip, lines: outcomes, note: libgpiodSafeStateNote };
  }

  private handleWatchEvent(event: GpioWatchEvent): void {
    const state = this.linesByOffset.get(event.offset);
    if (!state) return;
    const value = rawToLogical(event.raw, state.config.polarity);
    state.evidence = recordObserved(
      state.evidence,
      value,
      'gpio-readback',
      event.receivedAt,
      this.config.provenance,
      this.config.observationMaxAgeMs,
    );
    state.rawLevel = event.raw;
    this.emit('gpio.changed', {
      line: state.config.name,
      offset: event.offset,
      value,
      raw: event.raw,
      edge: event.edge,
      polarity: state.config.polarity,
      at: event.receivedAt.toISOString(),
      deviceTimestampSeconds: event.deviceTimestampSeconds,
      source: 'gpio-readback',
    });
  }

  /**
   * Safe-state application order: lines that must be driven to a
   * de-energized level first (config declaration order), then `high-z`
   * releases, then `hold`/input lines which need no command. Driving first is
   * deliberate: de-energizing an active load is more urgent than releasing a
   * line that is already inactive.
   */
  private orderForSafeState(): LineRuntimeState[] {
    const rank = (state: LineRuntimeState): number => {
      if (state.config.direction !== 'output') return 2;
      if (state.config.safeLevel === 'low' || state.config.safeLevel === 'high') return 0;
      if (state.config.safeLevel === 'high-z') return 1;
      return 2;
    };
    return [...this.linesByName.values()]
      .map((state, index) => ({ state, index }))
      .sort((a, b) => rank(a.state) - rank(b.state) || a.index - b.index)
      .map((entry) => entry.state);
  }

  private async applySafeLevel(
    state: LineRuntimeState,
    reason: string,
  ): Promise<SafeLevelOutcome> {
    const { config } = state;
    const base = { line: config.name, offset: config.offset, safeLevel: config.safeLevel };
    if (config.direction === 'input') {
      return { ...base, action: 'skipped', raw: null, reason: 'input-line' };
    }
    if (config.safeLevel === 'high-z') {
      const wasHeld = state.holder !== null;
      await this.releaseHolder(state);
      state.rawLevel = null;
      state.releasedOnExit = false;
      if (wasHeld) {
        state.evidence = recordAcknowledged(
          state.evidence,
          null,
          new Date(),
          this.config.provenance,
        );
        return { ...base, action: 'released', raw: null };
      }
      return { ...base, action: 'released', raw: null, reason: 'not-held' };
    }
    if (config.safeLevel === 'hold') {
      if (state.holder) {
        return { ...base, action: 'kept', raw: state.rawLevel };
      }
      return { ...base, action: 'skipped', raw: null, reason: 'no-held-value' };
    }

    const raw: 0 | 1 = config.safeLevel === 'high' ? 1 : 0;
    const now = new Date();
    const logical = rawToLogical(raw, config.polarity);
    state.evidence = recordCommanded(state.evidence, logical, now, this.config.provenance);
    await this.drive(state, raw);
    state.evidence = recordAcknowledged(state.evidence, logical, now, this.config.provenance);
    state.releasedOnExit = false;
    return { ...base, action: 'driven', raw, reason };
  }

  /** Start (or replace) the holder process that keeps one line driven. */
  private async drive(state: LineRuntimeState, raw: 0 | 1): Promise<void> {
    await this.releaseHolder(state);
    const held = await this.tools.holdLines(
      this.config.chip,
      [{ offset: state.config.offset, raw }],
      { startupGraceMs: this.config.holdStartupGraceMs },
    );
    const record: HolderRecord = { held, expectedExit: false };
    state.holder = record;
    state.rawLevel = raw;
    state.releasedOnExit = false;
    void held.exited.then((info) => {
      if (record.expectedExit) return;
      if (state.holder !== record) return;
      // The line was released without a command from us: the physical level is
      // now unknown, so both the driven state and the acknowledged value are
      // cleared rather than pretending the old value still applies.
      state.holder = null;
      state.rawLevel = null;
      state.evidence = recordAcknowledged(state.evidence, null, new Date(), this.config.provenance);
      this.emit('gpio.holdLost', {
        line: state.config.name,
        offset: state.config.offset,
        code: info.code,
        signal: info.signal,
        stderr: held.stderrText(),
      });
    });
  }

  private async releaseHolder(state: LineRuntimeState): Promise<void> {
    const record = state.holder;
    if (!record) return;
    record.expectedExit = true;
    state.holder = null;
    state.rawLevel = null;
    await record.held.terminate().catch(() => undefined);
  }

  private waitForPulse(state: LineRuntimeState, pulseMs: number): Promise<'elapsed' | 'cancelled'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.cancelPulse = null;
        resolve('elapsed');
      }, pulseMs);
      unrefTimer(timer);
      state.cancelPulse = () => {
        clearTimeout(timer);
        resolve('cancelled');
      };
    });
  }

  private cancelPulse(state: LineRuntimeState): void {
    const cancel = state.cancelPulse;
    if (!cancel) return;
    state.cancelPulse = null;
    cancel();
  }

  private resolveLine(payload: Record<string, unknown>): LineRuntimeState {
    const hasName = payload.line !== undefined;
    const hasOffset = payload.offset !== undefined;
    if (hasName && hasOffset) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        "Provide either 'line' (logical name) or 'offset', not both.",
      );
    }
    if (hasName) {
      const name = payload.line;
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new DeviceError('VALIDATION_ERROR', "'line' must be a non-empty string.");
      }
      const state = this.linesByName.get(name.trim());
      if (!state) throw this.lineNotFound(`'${name.trim()}'`);
      return state;
    }
    if (hasOffset) {
      const offset = payload.offset;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        throw new DeviceError('VALIDATION_ERROR', "'offset' must be a non-negative integer.");
      }
      const state = this.linesByOffset.get(offset);
      if (!state) throw this.lineNotFound(`offset ${offset}`);
      return state;
    }
    throw new DeviceError('VALIDATION_ERROR', "Exactly one of 'line' or 'offset' is required.");
  }

  private resolveLines(payload: Record<string, unknown>): LineRuntimeState[] {
    const entries: unknown[] = [];
    if (payload.lines !== undefined) {
      if (!Array.isArray(payload.lines)) {
        throw new DeviceError('VALIDATION_ERROR', "'lines' must be an array when provided.");
      }
      entries.push(...(payload.lines as unknown[]));
    }
    if (payload.line !== undefined) entries.push(payload.line);
    if (payload.offset !== undefined) entries.push(payload.offset);
    if (entries.length === 0) {
      throw new DeviceError(
        'VALIDATION_ERROR',
        "gpio.watch requires 'line', 'offset', or a 'lines' array.",
      );
    }

    const resolved: LineRuntimeState[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      let state: LineRuntimeState;
      if (typeof entry === 'string') {
        const match = this.linesByName.get(entry.trim());
        if (!match) throw this.lineNotFound(`'${entry.trim()}'`);
        state = match;
      } else if (typeof entry === 'number') {
        const match = this.linesByOffset.get(entry);
        if (!match) throw this.lineNotFound(`offset ${entry}`);
        state = match;
      } else {
        throw new DeviceError(
          'VALIDATION_ERROR',
          "'lines' entries must be logical line names or non-negative integer offsets.",
        );
      }
      if (seen.has(state.config.name)) continue;
      seen.add(state.config.name);
      resolved.push(state);
    }
    return resolved;
  }

  private lineNotFound(what: string): LibgpiodError {
    return new LibgpiodError(
      'GPIO_LINE_NOT_FOUND',
      `Line ${what} is not declared in this device's line configuration.`,
      {
        availableLines: this.config.lines.map((line) => ({
          name: line.name,
          offset: line.offset,
          direction: line.direction,
        })),
      },
    );
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

/** Translate a logical (active) value into the raw electrical level to drive. */
export function logicalToRaw(value: boolean, polarity: LibgpiodPolarity): 0 | 1 {
  if (polarity === 'active-low') return value ? 0 : 1;
  return value ? 1 : 0;
}

/** Translate a raw electrical level into a logical (active) value. */
export function rawToLogical(raw: 0 | 1, polarity: LibgpiodPolarity): boolean {
  if (polarity === 'active-low') return raw === 0;
  return raw === 1;
}

function lastKnown(evidence: EvidenceState<boolean>): {
  value: boolean | null;
  at: string | null;
  source: EvidenceSource;
} {
  const candidates: Array<{ value: boolean | null; at: string; source: EvidenceSource }> = [];
  for (const entry of [evidence.observed, evidence.acknowledged, evidence.commanded]) {
    if (entry.at !== null) {
      candidates.push({ value: entry.value, at: entry.at, source: entry.source });
    }
  }
  const first = candidates[0];
  if (!first) return { value: null, at: null, source: 'none' };
  let latest = first;
  for (const candidate of candidates) {
    if (new Date(candidate.at).getTime() > new Date(latest.at).getTime()) {
      latest = candidate;
    }
  }
  return { value: latest.value, at: latest.at, source: latest.source };
}

function unsupportedConfiguration(message: string): LibgpiodError {
  return new LibgpiodError('UNSUPPORTED_CONFIGURATION', message);
}

function readPositive(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new LibgpiodError('VALIDATION_ERROR', `${field} must be a positive finite number.`);
  }
  return value;
}

function readNonNegative(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LibgpiodError('VALIDATION_ERROR', `${field} must be a non-negative finite number.`);
  }
  return value;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}
