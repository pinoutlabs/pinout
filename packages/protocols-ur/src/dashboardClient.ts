/**
 * Universal Robots dashboard-server client (port 29999 by convention).
 *
 * Line protocol: one command per line (`\n`-terminated), one reply line.
 * Commands are serialized strictly; a reply timeout closes the transport
 * because a late reply can no longer be matched to its command safely.
 *
 * VERIFIED REPLY WORDING (checked against the official UR client library
 * `dashboard_client_implementation_g5.cpp` command list):
 * - `play` → `Starting program`
 * - `stop` → `Stopped`
 * - `pause` → `Pausing program`
 * - `power on` → `Powering on`
 * - `power off` → `Powering off`
 * - `brake release` → `Brake releasing`
 * - `robotmode` → `Robotmode: <mode>` (mode name on modern firmware; numeric
 *   RTDE robot-mode value on older firmware — both are parsed)
 * - `safetymode` → `Safetymode: <mode>`
 * - `safetystatus` → `Safetystatus: <status>`
 * - `running` → `Program running: true|false`
 * - `programState` → `<STOPPED|PLAYING|PAUSED> <program name>`
 * - `get robot model` → model string starting with `UR` (e.g. `UR5e`)
 * - `get serial number` → serial string starting with `20`
 * - `PolyscopeVersion` → `URSoftware <version> (<build>)`
 * - `load` → `Loading program: ...`
 *
 * The `load` reply wording beyond its prefix is not fully verified; only the
 * prefix is treated as contractual. Version-dependent accept strings such as
 * `Robot is already powered on` are accepted when they occur because they
 * describe a successful idempotent outcome.
 *
 * On connect the official client consumes a welcome line before sending any
 * command. This client does the same when `expectWelcome` is not disabled; a
 * missing greeting is a non-fatal diagnostic, not an error.
 */
import type { Transport } from '@pinout/core';
import { UrDashboardError } from './errors.js';

export type UrRobotMode =
  | 'NO_CONTROLLER'
  | 'DISCONNECTED'
  | 'CONFIRM_SAFETY'
  | 'BOOTING'
  | 'POWER_OFF'
  | 'POWER_ON'
  | 'IDLE'
  | 'BACKDRIVE'
  | 'RUNNING'
  | 'UPDATING_FIRMWARE'
  | 'UNKNOWN';

export type UrSafetyMode =
  | 'NORMAL'
  | 'REDUCED'
  | 'PROTECTIVE_STOP'
  | 'RECOVERY'
  | 'SAFEGUARD_STOP'
  | 'SYSTEM_EMERGENCY_STOP'
  | 'ROBOT_EMERGENCY_STOP'
  | 'VIOLATION'
  | 'FAULT'
  | 'VALIDATE_JOINT_ID'
  | 'UNDEFINED_SAFETY_MODE'
  | 'UNKNOWN';

export type UrProgramState = 'STOPPED' | 'PLAYING' | 'PAUSED' | 'UNKNOWN';

/** RTDE robot-mode values as reported by `robotmode` on older firmware. */
export const UR_ROBOT_MODE_BY_NUMBER: Record<number, UrRobotMode> = {
  [-1]: 'NO_CONTROLLER',
  0: 'DISCONNECTED',
  1: 'CONFIRM_SAFETY',
  2: 'BOOTING',
  3: 'POWER_OFF',
  4: 'POWER_ON',
  5: 'IDLE',
  6: 'BACKDRIVE',
  7: 'RUNNING',
  8: 'UPDATING_FIRMWARE',
};

/** RTDE safety-mode values as reported by `safetymode` on older firmware. */
export const UR_SAFETY_MODE_BY_NUMBER: Record<number, UrSafetyMode> = {
  1: 'NORMAL',
  2: 'REDUCED',
  3: 'PROTECTIVE_STOP',
  4: 'RECOVERY',
  5: 'SAFEGUARD_STOP',
  6: 'SYSTEM_EMERGENCY_STOP',
  7: 'ROBOT_EMERGENCY_STOP',
  8: 'VIOLATION',
  9: 'FAULT',
  10: 'VALIDATE_JOINT_ID',
  11: 'UNDEFINED_SAFETY_MODE',
};

export interface UrDashboardDiagnostic {
  code: string;
  message: string;
  at: number;
}

export interface UrDashboardClientOptions {
  transport: Transport;
  /** Per-command reply timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Consume the server's welcome line on connect. Default true. */
  expectWelcome?: boolean;
  /** Bound on waiting for the welcome line; absence is only a diagnostic. Default 2000. */
  welcomeTimeoutMs?: number;
  /**
   * When true, action commands succeed on any reply that is not a recognized
   * failure (older firmware may word replies differently). Default false:
   * only the verified success wordings (or `acceptedReplies` overrides) count
   * as success, so a failure is never silently treated as a success.
   */
  lenientReplies?: boolean;
  /** Per-command accepted success replies; replaces the built-in table for the listed commands. */
  acceptedReplies?: Record<string, readonly string[]>;
  onDiagnostic?: (diagnostic: UrDashboardDiagnostic) => void;
}

const ACTION_ACCEPTED_REPLIES: Record<string, readonly string[]> = {
  'power on': ['Powering on', 'Robot is already powered on'],
  'power off': ['Powering off', 'Robot is already powered off'],
  'brake release': ['Brake releasing'],
  play: ['Starting program'],
  stop: ['Stopped'],
  pause: ['Pausing program'],
};

const FAILURE_PATTERNS: readonly RegExp[] = [
  /^error\b/i,
  /unknown command/i,
  /\bfailed\b/i,
  /\bcould not\b/i,
  /not allowed/i,
];

/** True when a dashboard reply indicates an error rather than the expected success wording. */
export function isDashboardFailure(reply: string): boolean {
  const trimmed = reply.trim();
  return FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export interface ParsedModeReply {
  raw: string;
  /** Numeric RTDE value when the firmware reported one. */
  numeric: number | undefined;
  /** Name when the firmware reported one, uppercased. */
  name: string | undefined;
}

/** Parse `Prefix: <value>` replies (`Robotmode:`, `Safetymode:`, ...). */
export function parseModeReply(reply: string): ParsedModeReply {
  const raw = reply.trim();
  const colon = raw.indexOf(':');
  const value = (colon >= 0 ? raw.slice(colon + 1) : raw).trim();
  if (/^-?\d+$/.test(value)) {
    return { raw, numeric: Number.parseInt(value, 10), name: undefined };
  }
  return {
    raw,
    numeric: undefined,
    name: value.length > 0 ? value.replace(/\s+/g, '_').toUpperCase() : undefined,
  };
}

export interface ParsedRobotMode {
  raw: string;
  mode: UrRobotMode;
  numeric: number | undefined;
}

export function parseRobotModeReply(reply: string): ParsedRobotMode {
  const parsed = parseModeReply(reply);
  if (parsed.numeric !== undefined) {
    return {
      raw: parsed.raw,
      mode: UR_ROBOT_MODE_BY_NUMBER[parsed.numeric] ?? 'UNKNOWN',
      numeric: parsed.numeric,
    };
  }
  return {
    raw: parsed.raw,
    mode: knownName(parsed.name, UR_ROBOT_MODE_BY_NUMBER),
    numeric: undefined,
  };
}

export interface ParsedSafetyMode {
  raw: string;
  mode: UrSafetyMode;
  numeric: number | undefined;
}

export function parseSafetyModeReply(reply: string): ParsedSafetyMode {
  const parsed = parseModeReply(reply);
  if (parsed.numeric !== undefined) {
    return {
      raw: parsed.raw,
      mode: UR_SAFETY_MODE_BY_NUMBER[parsed.numeric] ?? 'UNKNOWN',
      numeric: parsed.numeric,
    };
  }
  return {
    raw: parsed.raw,
    mode: knownName(parsed.name, UR_SAFETY_MODE_BY_NUMBER),
    numeric: undefined,
  };
}

export interface ParsedProgramState {
  raw: string;
  state: UrProgramState;
  programName: string | undefined;
}

export function parseProgramStateReply(reply: string): ParsedProgramState {
  const raw = reply.trim();
  const space = raw.indexOf(' ');
  const token = (space >= 0 ? raw.slice(0, space) : raw).toUpperCase();
  const name = space >= 0 ? raw.slice(space + 1).trim() : '';
  const state: UrProgramState =
    token === 'STOPPED' || token === 'PLAYING' || token === 'PAUSED' ? token : 'UNKNOWN';
  return { raw, state, programName: name.length > 0 ? name : undefined };
}

export function parseRunningReply(reply: string): boolean {
  const parsed = parseModeReply(reply);
  const token = (parsed.name ?? '').toLowerCase();
  if (token === 'true') return true;
  if (token === 'false') return false;
  throw new UrDashboardError(
    'UR_DASHBOARD_UNEXPECTED_REPLY',
    `Could not parse 'running' reply '${reply.trim()}'; expected 'Program running: true|false'.`,
    reply.trim(),
  );
}

export interface ParsedPolyscopeVersion {
  raw: string;
  version: string;
  build: string | undefined;
}

/** Parse `URSoftware <version> (<build>)`. */
export function parsePolyscopeVersionReply(reply: string): ParsedPolyscopeVersion {
  const raw = reply.trim();
  const match = /^URSoftware\s+(\S+)(?:\s+\(([^)]*)\))?/.exec(raw);
  if (!match) {
    throw new UrDashboardError(
      'UR_DASHBOARD_UNEXPECTED_REPLY',
      `Could not parse PolyscopeVersion reply '${raw}'; expected 'URSoftware <version> (<build>)'.`,
      raw,
    );
  }
  return { raw, version: match[1]!, build: match[2] };
}

export class UrDashboardClient {
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly lenientReplies: boolean;
  private readonly onDiagnostic: ((diagnostic: UrDashboardDiagnostic) => void) | undefined;
  private readonly acceptedReplies: Record<string, readonly string[]>;
  private readonly expectWelcome: boolean;
  private readonly welcomeTimeoutMs: number;

  private started = false;
  private closed = false;
  private lineBuffer: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private welcome: string | undefined;

  constructor(options: UrDashboardClientOptions) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.lenientReplies = options.lenientReplies ?? false;
    this.onDiagnostic = options.onDiagnostic;
    this.expectWelcome = options.expectWelcome !== false;
    this.welcomeTimeoutMs = options.welcomeTimeoutMs ?? 2000;
    this.acceptedReplies = { ...ACTION_ACCEPTED_REPLIES, ...(options.acceptedReplies ?? {}) };
  }

  /** Welcome line received on connect, when the server sent one. */
  get welcomeMessage(): string | undefined {
    return this.welcome;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.transport.open();
    void this.consume();
    if (this.expectWelcome) {
      const welcome = await this.nextLine(this.welcomeTimeoutMs);
      if (welcome === undefined) {
        this.diagnostic(
          'UR_DASHBOARD_NO_WELCOME',
          'No dashboard welcome line arrived before the welcome timeout; continuing.',
        );
      } else {
        this.welcome = welcome;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close().catch(() => undefined);
  }

  /** Send a raw dashboard command and return its reply line. */
  command(text: string): Promise<string> {
    return this.serialize(() => this.sendAndReceive(text));
  }

  async powerOn(): Promise<string> {
    return this.action('power on');
  }

  async powerOff(): Promise<string> {
    return this.action('power off');
  }

  async brakeRelease(): Promise<string> {
    return this.action('brake release');
  }

  async play(): Promise<string> {
    return this.action('play');
  }

  async stop(): Promise<string> {
    return this.action('stop');
  }

  async pause(): Promise<string> {
    return this.action('pause');
  }

  robotMode(): Promise<ParsedRobotMode> {
    return this.serialize(async () => parseRobotModeReply(await this.sendAndReceive('robotmode')));
  }

  safetyMode(): Promise<ParsedSafetyMode> {
    return this.serialize(async () =>
      parseSafetyModeReply(await this.sendAndReceive('safetymode')),
    );
  }

  async safetyStatus(): Promise<{ raw: string; status: string }> {
    return this.serialize(async () => {
      const raw = await this.sendAndReceive('safetystatus');
      const parsed = parseModeReply(raw);
      return { raw, status: parsed.name ?? String(parsed.numeric ?? 'UNKNOWN') };
    });
  }

  programState(): Promise<ParsedProgramState> {
    return this.serialize(async () =>
      parseProgramStateReply(await this.sendAndReceive('programState')),
    );
  }

  running(): Promise<boolean> {
    return this.serialize(async () => parseRunningReply(await this.sendAndReceive('running')));
  }

  async loadProgram(path: string): Promise<string> {
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new UrDashboardError(
        'UR_DASHBOARD_INVALID_PROGRAM',
        'Program path must be a non-empty string.',
      );
    }
    return this.serialize(async () => {
      const reply = await this.sendAndReceive(`load ${path.trim()}`);
      if (!/^loading program/i.test(reply)) {
        throw new UrDashboardError(
          'UR_DASHBOARD_UNEXPECTED_REPLY',
          `Unexpected 'load' reply '${reply}'; expected it to start with 'Loading program'.`,
          reply,
        );
      }
      return reply;
    });
  }

  async robotModel(): Promise<string> {
    return this.serialize(async () => {
      const reply = await this.sendAndReceive('get robot model');
      if (!/^UR/i.test(reply)) {
        throw new UrDashboardError(
          'UR_DASHBOARD_UNEXPECTED_REPLY',
          `Unexpected 'get robot model' reply '${reply}'; expected it to start with 'UR'.`,
          reply,
        );
      }
      return reply;
    });
  }

  async serialNumber(): Promise<string> {
    return this.serialize(async () => {
      const reply = await this.sendAndReceive('get serial number');
      if (!reply.startsWith('20')) {
        throw new UrDashboardError(
          'UR_DASHBOARD_UNEXPECTED_REPLY',
          `Unexpected 'get serial number' reply '${reply}'; expected it to start with '20'.`,
          reply,
        );
      }
      return reply;
    });
  }

  polyscopeVersion(): Promise<ParsedPolyscopeVersion> {
    return this.serialize(async () =>
      parsePolyscopeVersionReply(await this.sendAndReceive('PolyscopeVersion')),
    );
  }

  // -------------------------------------------------------------------------

  private action(command: string): Promise<string> {
    return this.serialize(async () => {
      const reply = await this.sendAndReceive(command);
      if (isDashboardFailure(reply)) {
        throw new UrDashboardError(
          'UR_DASHBOARD_COMMAND_FAILED',
          `Dashboard command '${command}' failed: ${reply}`,
          reply,
        );
      }
      if (!this.lenientReplies) {
        const accepted = this.acceptedReplies[command] ?? [];
        if (!accepted.includes(reply)) {
          throw new UrDashboardError(
            'UR_DASHBOARD_UNEXPECTED_REPLY',
            `Dashboard command '${command}' returned '${reply}', which is not an accepted success reply (${accepted.join(' | ') || 'none configured'}).`,
            reply,
          );
        }
      }
      return reply;
    });
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) {
        throw new UrDashboardError('UR_DASHBOARD_CLOSED', 'Dashboard transport is closed.');
      }
      return run();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async sendAndReceive(command: string): Promise<string> {
    if (!this.started) {
      throw new UrDashboardError(
        'UR_DASHBOARD_NOT_STARTED',
        'Dashboard client is not started; call start() first.',
      );
    }
    await this.transport.write(new TextEncoder().encode(`${command}\n`));
    const reply = await this.nextLine(this.timeoutMs);
    if (reply === undefined) {
      // A late reply can no longer be matched to this command; the session is
      // unrecoverable and is closed so later commands cannot read a stale line.
      await this.close();
      throw new UrDashboardError(
        'UR_DASHBOARD_TIMEOUT',
        `No dashboard reply to '${command}' within ${this.timeoutMs}ms; the connection was closed.`,
      );
    }
    return reply;
  }

  /** Resolve the next complete line, or `undefined` on timeout. */
  private async nextLine(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.shiftLine();
      if (line !== undefined) return Promise.resolve(line);
      if (this.closed) {
        return Promise.reject(
          new UrDashboardError(
            'UR_DASHBOARD_CLOSED',
            'Dashboard transport closed while waiting for a reply.',
          ),
        );
      }
      if (Date.now() > deadline) return Promise.resolve(undefined);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  private shiftLine(): string | undefined {
    const newlineIndex = this.lineBuffer.indexOf(0x0a);
    if (newlineIndex === -1) return undefined;
    const bytes = this.lineBuffer.splice(0, newlineIndex + 1);
    const line = new TextDecoder()
      .decode(Uint8Array.from(bytes))
      .replace(/[\r\n]+$/, '')
      .trim();
    return line;
  }

  private async consume(): Promise<void> {
    try {
      for await (const chunk of this.transport.readable) {
        this.lineBuffer.push(...chunk);
        if (this.lineBuffer.length > 1_048_576) {
          this.diagnostic(
            'UR_DASHBOARD_LINE_OVERFLOW',
            'Dashboard line buffer exceeded 1 MiB; closing.',
          );
          await this.close();
          break;
        }
      }
    } catch {
      // Waiting requests observe the closed state.
    } finally {
      this.closed = true;
    }
  }

  private diagnostic(code: string, message: string): void {
    this.onDiagnostic?.({ code, message, at: Date.now() });
  }
}

export function createUrDashboardClient(options: UrDashboardClientOptions): UrDashboardClient {
  return new UrDashboardClient(options);
}

function knownName<T extends string>(
  name: string | undefined,
  table: Record<number, T>,
  fallback: T = 'UNKNOWN' as T,
): T {
  if (!name) return fallback;
  for (const value of Object.values(table)) {
    if (value === name) return value;
  }
  return fallback;
}
