import { boardForInfo, validateBoardAction } from '../boards/builtin.js';
import type { Device } from '../device.js';
import { DeviceError } from '../errors.js';
import {
  assertGpioPin,
  assertEsp32WritePin,
  assertSafeLevel,
  assertPolarity,
  type GpioPolarity,
  type GpioSafeLevel,
} from '../drivers/esp32/pins.js';
import {
  computeFreshness,
  formatIsoTimestamp,
  recordAcknowledged,
  recordCommanded,
  recordObserved,
  unknownEvidence,
  type EvidenceProvenance,
  type EvidenceState,
} from '../spec/evidence.js';
import type { BackendInvocationContext, DeviceBackend } from './types.js';

export interface OutputSafeConfig {
  pin: number;
  safeLevel?: GpioSafeLevel | undefined;
  polarity?: GpioPolarity | undefined;
}

export interface ProtocolDeviceBackendOptions {
  autoHeartbeat?: boolean | undefined;
  heartbeatIntervalMs?: number | undefined;
  watchdogTimeoutMs?: number | undefined;
  requireWatchdog?: boolean | undefined;
  outputs?: OutputSafeConfig[] | undefined;
  /**
   * @deprecated Demo/test-only. Explicit arming via arm() is required for governed operation.
   */
  autoArm?: boolean | undefined;
}

export class ProtocolDeviceBackend implements DeviceBackend {
  readonly kind = 'protocol' as const;
  private state: 'disarmed' | 'armed' | 'tripped' = 'disarmed';
  private tripReason: string | undefined = undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private readonly watchdogConfig = { enabled: true, timeoutMs: 1000 };
  private readonly configuredOutputs = new Map<
    number,
    { safeLevel: GpioSafeLevel; polarity: GpioPolarity }
  >();
  private readonly evidenceMap = new Map<string, EvidenceState<unknown>>();
  private readonly cleanupListener: (() => void) | undefined;

  constructor(
    private readonly device: Device,
    private readonly options: ProtocolDeviceBackendOptions = {},
  ) {
    if (typeof options.watchdogTimeoutMs === 'number') {
      this.watchdogConfig.timeoutMs = options.watchdogTimeoutMs;
    }
    if (options.outputs) {
      for (const out of options.outputs) {
        const pin = assertGpioPin(out.pin);
        const board = boardForInfo(this.device.info);
        if (board) validateBoardAction(board, 'gpio.write', { pin });
        else assertEsp32WritePin(pin);
        const safeLevel = out.safeLevel !== undefined ? assertSafeLevel(out.safeLevel) : 'low';
        const polarity = out.polarity !== undefined ? assertPolarity(out.polarity) : 'active-high';
        this.configuredOutputs.set(pin, { safeLevel, polarity });
      }
    }

    this.recordAcknowledgedState('armed', 'disarmed');

    const tripHandler = (payload: Record<string, unknown>): void => {
      this.state = 'tripped';
      this.tripReason = typeof payload.reason === 'string' ? payload.reason : 'WATCHDOG_EXPIRED';
      this.stopHeartbeat();
      const nowIso = formatIsoTimestamp();
      this.recordAcknowledgedState('armed', 'tripped', nowIso);
    };

    const gpioChangedHandler = (payload: Record<string, unknown>): void => {
      if (typeof payload.pin === 'number' && payload.value !== undefined) {
        const nowIso = formatIsoTimestamp();
        this.recordObservedState(`gpio.${payload.pin}`, payload.value, 'gpio-readback', nowIso);
      }
    };

    this.device.on('device.tripped', tripHandler);
    this.device.on('gpio.changed', gpioChangedHandler);
    this.cleanupListener = () => {
      this.device.off('device.tripped', tripHandler);
      this.device.off('gpio.changed', gpioChangedHandler);
    };
  }

  private get provenance(): EvidenceProvenance {
    const transportKind = (
      this.device as unknown as { session?: { transport?: { kind?: string } } }
    ).session?.transport?.kind;
    if (transportKind?.startsWith('simulated') || transportKind === 'loopback') {
      return 'simulated';
    }
    if (transportKind) {
      return 'hardware';
    }
    return 'unknown';
  }

  private recordCommandedState<T = unknown>(
    key: string,
    value: T | null,
    at?: string | number | Date | null,
  ): EvidenceState<T> {
    const existing =
      (this.evidenceMap.get(key) as EvidenceState<T> | undefined) ??
      unknownEvidence<T>(this.provenance);
    const updated = recordCommanded(existing, value, at, this.provenance);
    this.evidenceMap.set(key, updated as EvidenceState<unknown>);
    return updated;
  }

  private recordAcknowledgedState<T = unknown>(
    key: string,
    value: T | null,
    at?: string | number | Date | null,
  ): EvidenceState<T> {
    const existing =
      (this.evidenceMap.get(key) as EvidenceState<T> | undefined) ??
      unknownEvidence<T>(this.provenance);
    const updated = recordAcknowledged(existing, value, at, this.provenance);
    this.evidenceMap.set(key, updated as EvidenceState<unknown>);
    return updated;
  }

  private recordObservedState<T = unknown>(
    key: string,
    value: T | null,
    source: 'gpio-readback' | 'sensor' | 'simulated' = 'gpio-readback',
    at?: string | number | Date | null,
  ): EvidenceState<T> {
    const existing =
      (this.evidenceMap.get(key) as EvidenceState<T> | undefined) ??
      unknownEvidence<T>(this.provenance);
    const updated = recordObserved(existing, value, source, at, this.provenance);
    this.evidenceMap.set(key, updated as EvidenceState<unknown>);
    return updated;
  }

  subscribe(_handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    return () => undefined;
  }

  async initializeOutputs(): Promise<void> {
    if (!this.device.supports('gpio.configSafeState')) {
      return;
    }
    for (const [pin, config] of this.configuredOutputs) {
      await this.device.configSafeState(pin, config.safeLevel, config.polarity);
    }
  }

  async arm(options?: {
    timeoutMs?: number | undefined;
    heartbeatIntervalMs?: number | undefined;
    requireWatchdog?: boolean | undefined;
  }): Promise<Record<string, unknown>> {
    const requireWatchdog = options?.requireWatchdog ?? this.options.requireWatchdog ?? false;
    const supportsWatchdog =
      this.device.supports('sys.arm') ||
      this.device.hasFeature('watchdog') ||
      this.device.hasFeature('arming');

    if (requireWatchdog && !supportsWatchdog) {
      throw new DeviceError(
        'WATCHDOG_NOT_SUPPORTED',
        'Device firmware does not advertise watchdog/arming support.',
      );
    }

    const requestedTimeout = options?.timeoutMs ?? this.options.watchdogTimeoutMs ?? 1000;
    if (
      requireWatchdog &&
      this.device.info.boardId &&
      (!Number.isInteger(requestedTimeout) || requestedTimeout < 250 || requestedTimeout > 10000)
    ) {
      throw new DeviceError('INVALID_PAYLOAD', 'Watchdog timeout must be 250–10000 ms.');
    }
    await this.initializeOutputs();

    const nowIso = formatIsoTimestamp();
    this.recordCommandedState('armed', 'armed', nowIso);

    if (this.device.supports('sys.arm')) {
      const armPayload: { timeoutMs?: number } = {};
      const timeoutMs = options?.timeoutMs ?? this.options.watchdogTimeoutMs;
      if (timeoutMs !== undefined) {
        armPayload.timeoutMs = timeoutMs;
      }
      const result = await this.device.arm(armPayload);
      this.state = 'armed';
      this.tripReason = undefined;
      this.recordAcknowledgedState('armed', 'armed', formatIsoTimestamp());
      if (typeof result.timeoutMs === 'number') {
        this.watchdogConfig.timeoutMs = result.timeoutMs;
      }
      this.startHeartbeat(options?.heartbeatIntervalMs);
      return result;
    }

    this.state = 'armed';
    this.tripReason = undefined;
    this.recordAcknowledgedState('armed', 'armed', formatIsoTimestamp());
    return { armed: true, state: 'armed', legacy: true };
  }

  async disarm(): Promise<Record<string, unknown>> {
    this.stopHeartbeat();
    const nowIso = formatIsoTimestamp();
    this.recordCommandedState('armed', 'disarmed', nowIso);

    if (this.device.supports('sys.disarm')) {
      const result = await this.device.disarm();
      this.state = 'disarmed';
      this.tripReason = undefined;
      this.recordAcknowledgedState('armed', 'disarmed', formatIsoTimestamp());
      return result;
    }
    if (this.device.supports('gpio.stopAll')) {
      const stoppedPins = await this.device.gpio.stopAll();
      this.state = 'disarmed';
      this.tripReason = undefined;
      this.recordAcknowledgedState('armed', 'disarmed', formatIsoTimestamp());
      return { armed: false, state: 'disarmed', stoppedPins };
    }
    this.state = 'disarmed';
    this.tripReason = undefined;
    this.recordAcknowledgedState('armed', 'disarmed', formatIsoTimestamp());
    return { armed: false, state: 'disarmed' };
  }

  async configSafeState(
    pin: number,
    safeLevel: GpioSafeLevel = 'low',
    polarity: GpioPolarity = 'active-high',
  ): Promise<Record<string, unknown>> {
    const board = boardForInfo(this.device.info);
    if (board) validateBoardAction(board, 'gpio.write', { pin });
    else assertEsp32WritePin(pin);
    this.configuredOutputs.set(pin, { safeLevel, polarity });
    if (this.device.supports('gpio.configSafeState')) {
      return this.device.configSafeState(pin, safeLevel, polarity);
    }
    return { pin, safeLevel, polarity };
  }

  async invoke(
    action: string,
    payload: Record<string, unknown>,
    context?: BackendInvocationContext,
  ): Promise<Record<string, unknown>> {
    if (
      action === 'watchdog.configure' &&
      this.options.requireWatchdog &&
      (typeof payload.timeoutMs !== 'number' ||
        payload.timeoutMs < 250 ||
        payload.timeoutMs > 10000)
    )
      throw new DeviceError('INVALID_PAYLOAD', 'Watchdog timeout must be 250–10000 ms.');
    if (action === 'sys.arm') return this.arm(payload as { timeoutMs?: number });
    if (action === 'sys.disarm') return this.disarm();
    const cmdIso = formatIsoTimestamp();

    if (action === 'gpio.write' && typeof payload.pin === 'number') {
      this.recordCommandedState(`gpio.${payload.pin}`, payload.value ?? null, cmdIso);
    } else if (action === 'gpio.batchWrite' && Array.isArray(payload.writes)) {
      for (const w of payload.writes) {
        if (w && typeof w === 'object' && typeof (w as { pin?: unknown }).pin === 'number') {
          const writeEntry = w as { pin: number; value?: unknown };
          this.recordCommandedState(`gpio.${writeEntry.pin}`, writeEntry.value ?? null, cmdIso);
        }
      }
    } else if (action === 'gpio.toggle' && typeof payload.pin === 'number') {
      this.recordCommandedState(`gpio.${payload.pin}`, payload.value ?? null, cmdIso);
    } else if (action === 'gpio.pwm' && typeof payload.pin === 'number') {
      this.recordCommandedState(`gpio.${payload.pin}`, payload.duty ?? null, cmdIso);
    } else if (action === 'gpio.servo' && typeof payload.pin === 'number') {
      this.recordCommandedState(`gpio.${payload.pin}`, payload.angle ?? null, cmdIso);
    } else if (action === 'gpio.motor' && typeof payload.pin === 'number') {
      this.recordCommandedState(`gpio.${payload.pin}`, payload.speed ?? null, cmdIso);
    } else if (action === 'sys.arm') {
      this.recordCommandedState('armed', 'armed', cmdIso);
    } else if (action === 'sys.disarm') {
      this.recordCommandedState('armed', 'disarmed', cmdIso);
    }

    const result = await this.device.invoke(
      action,
      payload,
      context?.signal ? { signal: context.signal } : {},
    );

    const ackIso = formatIsoTimestamp();

    if (action === 'gpio.write' && typeof payload.pin === 'number') {
      this.recordAcknowledgedState(
        `gpio.${payload.pin}`,
        result.value !== undefined ? result.value : (payload.value ?? null),
        ackIso,
      );
    } else if (action === 'gpio.batchWrite' && Array.isArray(payload.writes)) {
      for (const w of payload.writes) {
        if (w && typeof w === 'object' && typeof (w as { pin?: unknown }).pin === 'number') {
          const writeEntry = w as { pin: number; value?: unknown };
          this.recordAcknowledgedState(`gpio.${writeEntry.pin}`, writeEntry.value ?? null, ackIso);
        }
      }
    } else if (action === 'gpio.toggle' && typeof payload.pin === 'number') {
      this.recordAcknowledgedState(`gpio.${payload.pin}`, result.value ?? null, ackIso);
    } else if (action === 'gpio.pwm' && typeof payload.pin === 'number') {
      this.recordAcknowledgedState(
        `gpio.${payload.pin}`,
        result.duty !== undefined ? result.duty : (payload.duty ?? null),
        ackIso,
      );
    } else if (action === 'gpio.servo' && typeof payload.pin === 'number') {
      this.recordAcknowledgedState(
        `gpio.${payload.pin}`,
        result.angle !== undefined ? result.angle : (payload.angle ?? null),
        ackIso,
      );
    } else if (action === 'gpio.motor' && typeof payload.pin === 'number') {
      this.recordAcknowledgedState(
        `gpio.${payload.pin}`,
        result.speed !== undefined ? result.speed : (payload.speed ?? null),
        ackIso,
      );
    } else if (action === 'sys.arm') {
      this.state = 'armed';
      this.tripReason = undefined;
      this.recordAcknowledgedState('armed', 'armed', ackIso);
    } else if (action === 'sys.disarm') {
      this.state = 'disarmed';
      this.tripReason = undefined;
      this.recordAcknowledgedState('armed', 'disarmed', ackIso);
    } else if (
      (action === 'gpio.read' || action === 'gpio.analogRead') &&
      typeof payload.pin === 'number' &&
      result.value !== undefined
    ) {
      this.recordObservedState(`gpio.${payload.pin}`, result.value, 'gpio-readback', ackIso);
    } else if (action === 'sys.info' || action === 'sys.hello') {
      if (typeof result.state === 'string') {
        this.recordObservedState('armed', result.state, 'sensor', ackIso);
      }
    }

    return result;
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    this.cleanupListener?.();
    try {
      if (this.state === 'armed') await this.disarm();
    } catch {
      /* Link loss: firmware watchdog owns expiry. */
    } finally {
      await this.device.close();
    }
  }

  getDevice(): Device {
    return this.device;
  }

  getOperationalStateEvidence(): Record<string, EvidenceState<unknown>> {
    const snapshot: Record<string, EvidenceState<unknown>> = {};
    const now = Date.now();
    for (const [key, state] of this.evidenceMap.entries()) {
      snapshot[key] = computeFreshness(state, now);
    }
    return snapshot;
  }

  getOperationalState(): Record<string, unknown> {
    return {
      board: boardForInfo(this.device.info),
      firmware: this.device.info.firmware,
      version: this.device.info.version,
      protocol: this.device.info.protocol,
      features: this.device.info.features ?? [],
      state: this.state,
      armed: this.state === 'armed',
      disarmed: this.state === 'disarmed',
      tripped: this.state === 'tripped',
      ...(this.tripReason ? { tripReason: this.tripReason } : {}),
      watchdog: {
        enabled: this.watchdogConfig.enabled,
        timeoutMs: this.watchdogConfig.timeoutMs,
      },
    };
  }

  async safeState(): Promise<Record<string, unknown>> {
    this.stopHeartbeat();
    if (this.device.supports('sys.disarm')) {
      await this.device.disarm().catch(() => undefined);
    }
    if (!this.device.supports('gpio.stopAll')) {
      this.state = 'disarmed';
      return { applied: false, reason: 'safe-state-not-supported' };
    }
    const stoppedPins = await this.device.gpio.stopAll();
    this.state = 'disarmed';
    return { applied: true, stoppedPins };
  }

  private startHeartbeat(intervalMs?: number): void {
    if (this.options.autoHeartbeat === false) {
      return;
    }
    if (!this.device.supports('watchdog.kick')) {
      return;
    }
    this.stopHeartbeat();
    const interval =
      intervalMs ??
      this.options.heartbeatIntervalMs ??
      Math.max(50, Math.floor(this.watchdogConfig.timeoutMs / 2));

    this.heartbeatTimer = setInterval(async () => {
      if (this.state !== 'armed') {
        this.stopHeartbeat();
        return;
      }
      try {
        await this.device.kickWatchdog();
      } catch (error) {
        if (error instanceof DeviceError) {
          if (error.code === 'WATCHDOG_TRIPPED') {
            this.state = 'tripped';
            this.tripReason = 'WATCHDOG_EXPIRED';
            this.stopHeartbeat();
            this.recordAcknowledgedState('armed', 'tripped', formatIsoTimestamp());
          } else if (error.code === 'NOT_ARMED') {
            this.state = 'disarmed';
            this.stopHeartbeat();
            this.recordAcknowledgedState('armed', 'disarmed', formatIsoTimestamp());
          }
        }
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
