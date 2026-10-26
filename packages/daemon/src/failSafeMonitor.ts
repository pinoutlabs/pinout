/**
 * Proactive fail-safe for leased / armed devices.
 *
 * When a lease expires or a deadman heartbeat goes stale, the daemon disarms
 * (when the device supports it) and applies backend safeState — without going
 * through the lease-gated invoke path. This complements the firmware watchdog:
 * host-side cleanup runs even if the agent runtime is paused (e.g. Infinity
 * waiting on a tool call); the firmware watchdog remains the last line of
 * defense if the host itself is frozen or the link is severed.
 */
import type { Journal, LeaseManager, PinoutRuntime, SafetyEngine } from '@pinout/core';

export interface FailSafeMonitorOptions {
  runtime: PinoutRuntime;
  leases: LeaseManager;
  safety: SafetyEngine;
  journal: Journal;
  /**
   * When true (default), lease expiry and deadman stale trigger disarm + safeState.
   * Safe default for armed physical capabilities.
   */
  failSafeOnAuthorityLoss?: boolean;
  /** How often to reap leases / check deadman. Default 1000ms. */
  intervalMs?: number;
  /** Default deadman max age when a device is armed but no deadman rule exists. */
  defaultDeadmanMaxAgeMs?: number;
  publishEvent?: (kind: 'lease' | 'safety', data: Record<string, unknown>) => void;
  now?: () => number;
}

export interface ArmedDeviceRecord {
  deviceId: string;
  armedAt: number;
  /** Watchdog / deadman timeout negotiated at arm time. */
  timeoutMs: number;
  owner?: string;
}

const DEFAULT_INTERVAL_MS = 1000;
/**
 * Host-side deadman grace period after arm / last heartbeat.
 * Intentionally coarser than firmware watchdog timeouts (often hundreds of ms):
 * the firmware watchdog remains the fast path; this catches a paused/crashed
 * agent that stops calling pinout__heartbeat while the daemon is still alive.
 */
const DEFAULT_DEADMAN_MAX_AGE_MS = 30_000;

export class FailSafeMonitor {
  private readonly runtime: PinoutRuntime;
  private readonly leases: LeaseManager;
  private readonly safety: SafetyEngine;
  private readonly journal: Journal;
  private readonly failSafeOnAuthorityLoss: boolean;
  private readonly intervalMs: number;
  private readonly defaultDeadmanMaxAgeMs: number;
  private readonly publishEvent:
    | ((kind: 'lease' | 'safety', data: Record<string, unknown>) => void)
    | undefined;
  private readonly nowFn: () => number;
  private readonly armed = new Map<string, ArmedDeviceRecord>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: FailSafeMonitorOptions) {
    this.runtime = options.runtime;
    this.leases = options.leases;
    this.safety = options.safety;
    this.journal = options.journal;
    this.failSafeOnAuthorityLoss = options.failSafeOnAuthorityLoss !== false;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.defaultDeadmanMaxAgeMs = options.defaultDeadmanMaxAgeMs ?? DEFAULT_DEADMAN_MAX_AGE_MS;
    this.publishEvent = options.publishEvent;
    this.nowFn = options.now ?? Date.now;
  }

  start(): void {
    if (!this.failSafeOnAuthorityLoss || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Unref so the timer alone does not keep the process alive in tests/CLI exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Record that a device was armed (call after successful sys.arm). */
  markArmed(deviceId: string, _firmwareWatchdogMs?: number, owner?: string): void {
    const now = this.nowFn();
    // Do not bind host fail-safe to the firmware watchdog timeout — that timer
    // is enforced on-device. Host deadman uses defaultDeadmanMaxAgeMs / rules.
    this.armed.set(deviceId, {
      deviceId,
      armedAt: now,
      timeoutMs: this.defaultDeadmanMaxAgeMs,
      ...(owner !== undefined ? { owner } : {}),
    });
    this.safety.heartbeatDeadman(deviceId);
  }

  markDisarmed(deviceId: string): void {
    this.armed.delete(deviceId);
    this.safety.clearDeadman(deviceId);
  }

  isArmed(deviceId: string): boolean {
    return this.armed.has(deviceId);
  }

  /** Run one reap + deadman pass (also used by tests). */
  async tick(): Promise<void> {
    if (this.running || !this.failSafeOnAuthorityLoss) return;
    this.running = true;
    try {
      await this.reapLeases();
      await this.checkDeadman();
    } finally {
      this.running = false;
    }
  }

  private async reapLeases(): Promise<void> {
    const expired = this.leases.drainExpired();
    for (const lease of expired) {
      this.journal.append(
        'lease.expired',
        { deviceId: lease.scope.deviceId },
        {
          leaseId: lease.id,
          owner: lease.owner,
          mode: lease.mode,
          scope: lease.scope,
          expiresAt: lease.expiresAt,
        },
      );
      this.publishEvent?.('lease', {
        event: 'lease.expired',
        leaseId: lease.id,
        owner: lease.owner,
        deviceId: lease.scope.deviceId,
        expiresAt: lease.expiresAt,
      });
      await this.applyFailSafe(lease.scope.deviceId, 'lease.expired', {
        leaseId: lease.id,
        owner: lease.owner,
      });
    }
  }

  private async checkDeadman(): Promise<void> {
    const now = this.nowFn();
    const ruleMaxAges = new Map<string, number>();
    for (const rule of this.safety.listDeadmanRules()) {
      // Deadman rules are capability-scoped; treat maxAge as device-wide for monitoring.
      const maxAge = rule.maxAgeMs ?? this.defaultDeadmanMaxAgeMs;
      // Use the strictest (smallest) max age configured.
      const existing = ruleMaxAges.get('*');
      if (existing === undefined || maxAge < existing) {
        ruleMaxAges.set('*', maxAge);
      }
    }

    const deviceIds = new Set<string>([
      ...this.armed.keys(),
      ...this.runtime.devices().map((d) => d.id),
    ]);

    for (const deviceId of deviceIds) {
      const armed = this.armed.get(deviceId);
      const lastAlive = this.safety.getDeadmanLastAlive(deviceId);
      if (!armed && lastAlive === undefined && ruleMaxAges.size === 0) continue;

      const maxAge =
        armed?.timeoutMs ?? ruleMaxAges.get('*') ?? this.defaultDeadmanMaxAgeMs;
      // Only fail-safe when we have evidence the device was under host authority
      // (armed or has received at least one heartbeat while a deadman rule exists).
      if (!armed && lastAlive === undefined) continue;
      if (!armed && ruleMaxAges.size === 0) continue;

      const reference = lastAlive ?? armed?.armedAt;
      if (reference === undefined) continue;
      if (now - reference <= maxAge) continue;

      await this.applyFailSafe(deviceId, 'deadman.stale', {
        maxAgeMs: maxAge,
        lastAlive: lastAlive ?? null,
        armedAt: armed?.armedAt ?? null,
      });
    }
  }

  async applyFailSafe(
    deviceId: string,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    let device;
    try {
      device = this.runtime.getDevice(deviceId);
    } catch {
      this.markDisarmed(deviceId);
      return { applied: false, reason: 'device_not_found' };
    }

    const result: Record<string, unknown> = {
      deviceId,
      reason,
      disarmed: false,
      safeState: null,
    };

    // Prefer backend safeState — ProtocolDeviceBackend.safeState also disarms.
    // Bypass lease-gated invoke so expiry cleanup cannot deadlock on the lease it reaped.
    try {
      const safeState = await device.applySafeState();
      result.safeState = safeState ?? { applied: true };
      result.disarmed = true;
    } catch (error) {
      result.safeStateError = error instanceof Error ? error.message : String(error);
    }

    this.markDisarmed(deviceId);

    this.journal.append(
      'safety.state_changed',
      { deviceId },
      {
        event: 'fail_safe.applied',
        reason,
        ...details,
        result,
      },
    );
    this.publishEvent?.('safety', {
      event: 'fail_safe.applied',
      deviceId,
      reason,
      ...details,
      result,
    });

    return result;
  }
}
