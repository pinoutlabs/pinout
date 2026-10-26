import type { CommandRunner } from './commandRunner.js';
import { getProfile, type BoardProfile } from './profiles.js';
import type {
  ColdWarmRecord,
  DeviceJournalEntry,
  DeviceMode,
  DeviceSnapshot,
  ProfileId,
} from '../types.js';

/**
 * Real-board session state shared by both arms for journal/checkers.
 * UNTESTED on physical hardware until a dated hardware record exists.
 *
 * Journal entries come from serial/Pinout acknowledgements the harness observes,
 * not from the model claim.
 */
export class RealBoardSession {
  readonly profile: BoardProfile;
  readonly mode: DeviceMode = 'real';
  readonly journal: DeviceJournalEntry[] = [];
  readonly port: string;
  readonly baudRate: number;
  readonly levels = new Map<number, boolean>();
  readonly servos = new Map<number, number>();
  readonly analogLevels = new Map<number, number>();
  deviceState = 'unknown';
  private readonly startedAt = Date.now();
  private flashedOnce = false;
  firstFlashDurationMs: number | undefined;
  lastResetMs: number | undefined;
  pinoutdAlreadyRunning: boolean | null;

  constructor(options: {
    profileId: ProfileId;
    port: string;
    baudRate: number;
    pinoutdAlreadyRunning: boolean | null;
  }) {
    this.profile = getProfile(options.profileId);
    this.port = options.port;
    this.baudRate = options.baudRate;
    this.pinoutdAlreadyRunning = options.pinoutdAlreadyRunning;
    this.analogLevels.set(this.profile.adcPin, this.profile.seededAnalogValue);
  }

  recordLevel(pin: number, value: boolean, detail: Record<string, unknown> = {}): void {
    this.levels.set(pin, value);
    this.journal.push({
      atMs: Date.now() - this.startedAt,
      kind: 'gpio.level',
      pin,
      value,
      detail,
    });
  }

  recordServo(pin: number, angle: number, detail: Record<string, unknown> = {}): void {
    this.servos.set(pin, angle);
    this.journal.push({
      atMs: Date.now() - this.startedAt,
      kind: 'gpio.servo',
      pin,
      value: angle,
      detail,
    });
  }

  recordAnalogRead(pin: number, value: number, detail: Record<string, unknown> = {}): void {
    this.analogLevels.set(pin, value);
    this.journal.push({
      atMs: Date.now() - this.startedAt,
      kind: 'gpio.analogRead',
      pin,
      value,
      detail,
    });
  }

  recordState(state: string, detail: Record<string, unknown> = {}): void {
    this.deviceState = state;
    this.journal.push({
      atMs: Date.now() - this.startedAt,
      kind: 'device.state',
      value: state,
      detail,
    });
  }

  markFlash(durationMs: number): void {
    if (!this.flashedOnce) {
      this.flashedOnce = true;
      this.firstFlashDurationMs = durationMs;
    }
  }

  get isFirstFlash(): boolean {
    return !this.flashedOnce;
  }

  snapshot(): DeviceSnapshot {
    const levels: Record<string, boolean> = {};
    for (const [pin, value] of this.levels) levels[String(pin)] = value;
    const servos: Record<string, number> = {};
    for (const [pin, angle] of this.servos) servos[String(pin)] = angle;
    const analogLevels: Record<string, number> = {};
    for (const [pin, value] of this.analogLevels) analogLevels[String(pin)] = value;
    return {
      profileId: this.profile.id,
      mode: 'real',
      levels,
      servos,
      analogLevels,
      deviceState: this.deviceState,
      journal: [...this.journal],
    };
  }

  coldWarmNote(arm: 'raw' | 'pinout'): ColdWarmRecord {
    const noteParts = [
      `Arm=${arm}.`,
      this.pinoutdAlreadyRunning === true
        ? 'pinoutd was already running (warm daemon path possible for Arm B).'
        : this.pinoutdAlreadyRunning === false
          ? 'pinoutd was not detected as already running at preflight.'
          : 'pinoutd warm/cold state unknown.',
      this.firstFlashDurationMs !== undefined
        ? `First flash in this session took ${this.firstFlashDurationMs.toFixed(0)} ms (recorded separately from steady-state).`
        : 'No flash recorded yet in this session.',
    ];
    const record: ColdWarmRecord = {
      pinoutdAlreadyRunning: this.pinoutdAlreadyRunning,
      firstFlashInSuite: this.firstFlashDurationMs !== undefined && this.isFirstFlash === false,
      note: noteParts.join(' '),
    };
    if (this.firstFlashDurationMs !== undefined) {
      record.flashDurationMs = this.firstFlashDurationMs;
    }
    if (this.lastResetMs !== undefined) record.boardResetMs = this.lastResetMs;
    return record;
  }
}

export interface BoardResetDeps {
  commandRunner: CommandRunner;
}

/**
 * Best-effort board reset to a common baseline between interleaved runs.
 * Uses profile-appropriate tools when present; always records timing.
 */
export async function resetBoardBetweenRuns(
  session: RealBoardSession,
  deps: BoardResetDeps,
): Promise<{ ok: boolean; detail: string; durationMs: number }> {
  const started = performance.now();
  const profileId = session.profile.id;
  let detail = '';
  let ok = false;

  if (profileId === 'esp32') {
    const esptool =
      (await deps.commandRunner.which('esptool.py')) ??
      (await deps.commandRunner.which('esptool'));
    if (esptool) {
      const result = await deps.commandRunner.run(
        esptool.endsWith('.py') ? 'esptool.py' : 'esptool',
        ['--port', session.port, 'run'],
        { timeoutMs: 30_000 },
      );
      ok = result.exitCode === 0;
      detail = ok ? 'esptool run' : `esptool reset failed: ${result.stderr.slice(0, 200)}`;
    } else {
      detail = 'esptool not found; reset skipped (journal cleared locally only).';
      ok = true;
    }
  } else if (profileId === 'pico') {
    const mpremote = await deps.commandRunner.which('mpremote');
    if (mpremote) {
      const result = await deps.commandRunner.run(
        'mpremote',
        ['connect', session.port, 'reset'],
        { timeoutMs: 30_000 },
      );
      ok = result.exitCode === 0;
      detail = ok ? 'mpremote reset' : `mpremote reset failed: ${result.stderr.slice(0, 200)}`;
    } else {
      detail = 'mpremote not found; reset skipped (journal cleared locally only).';
      ok = true;
    }
  } else {
    // Uno: rely on serial open/close DTR pulse via arduino-cli if available.
    const arduino = await deps.commandRunner.which('arduino-cli');
    if (arduino) {
      const result = await deps.commandRunner.run(
        'arduino-cli',
        ['board', 'attach', '-p', session.port],
        { timeoutMs: 15_000 },
      );
      ok = result.exitCode === 0;
      detail = ok
        ? 'arduino-cli board attach (DTR pulse best-effort)'
        : `arduino-cli attach failed: ${result.stderr.slice(0, 200)}`;
    } else {
      detail = 'arduino-cli not found; reset skipped (journal cleared locally only).';
      ok = true;
    }
  }

  // Clear local observed state so checkers only see this run.
  session.levels.clear();
  session.servos.clear();
  session.journal.length = 0;
  session.deviceState = 'reset';
  session.analogLevels.set(session.profile.adcPin, session.profile.seededAnalogValue);
  const durationMs = performance.now() - started;
  session.lastResetMs = durationMs;
  session.recordState('reset', { detail, durationMs });
  return { ok, detail, durationMs };
}
