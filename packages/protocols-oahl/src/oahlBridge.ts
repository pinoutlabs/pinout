import {
  DeviceError,
  LeaseManager,
  PinoutError,
  PinoutRuntime,
  PinoutStructuredError,
  type AcquireLeaseOptions,
  type LeaseScopeInput,
} from '@pinout/core';
import {
  OahlDeviceNotFoundError,
  OahlReservationConflictError,
  OahlReservationExpiredError,
  OahlValidationError,
} from './errors.js';
import {
  OAHL_PROTOCOL_VERSION,
  type OahlBridgeOptions,
  type OahlDevice,
  type OahlDiscoverFilter,
  type OahlDiscoverResponse,
  type OahlExecuteRequest,
  type OahlExecuteResponse,
  type OahlReleaseRequest,
  type OahlReleaseResponse,
  type OahlRenewRequest,
  type OahlRenewResponse,
  type OahlReserveRequest,
  type OahlReserveResponse,
} from './types.js';

export class OahlBridge {
  readonly runtime: PinoutRuntime;
  readonly leaseManager: LeaseManager;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private executionCounter = 0;

  constructor(runtime: PinoutRuntime, options: OahlBridgeOptions = {}) {
    this.runtime = runtime;
    this.leaseManager = new LeaseManager();
    this.defaultTtlMs = options.defaultTtlMs ?? 30_000;
    this.maxTtlMs = options.maxTtlMs ?? 300_000;
  }

  /**
   * Phase 1: Discover
   * Query all registered devices, capabilities, safety flags, and reservation status.
   */
  async discover(filter: OahlDiscoverFilter = {}): Promise<OahlDiscoverResponse> {
    const rawDevices = this.runtime.devices();
    const nowIso = new Date().toISOString();

    const devices: OahlDevice[] = [];

    for (const d of rawDevices) {
      if (filter.deviceClass && d.deviceClass !== filter.deviceClass) {
        continue;
      }

      // Check current active lease on device
      const activeLeases = this.leaseManager.list({ deviceId: d.id });
      const currentLease = activeLeases[0];

      const isAvailable = !currentLease;
      if (filter.availableOnly && !isAvailable) {
        continue;
      }

      const instance = this.runtime.getDevice(d.id);
      const capabilities = instance.capabilities.map((c) => ({
        name: c.name,
        description: c.description,
        inputSchema: c.inputSchema as Record<string, unknown>,
        outputSchema: c.outputSchema as Record<string, unknown> | undefined,
        safety: {
          physicalOutput: c.safety.physicalOutput,
          reversible: c.safety.reversible,
          notes: c.safety.notes,
        },
      }));

      if (filter.capability && !capabilities.some((c) => c.name === filter.capability)) {
        continue;
      }

      const oahlDev: OahlDevice = {
        id: d.id,
        label: d.label ?? d.id,
        deviceClass: d.deviceClass,
        vendor: d.vendor,
        model: d.model,
        status: (d.lifecycle === 'ready' ? 'ready' : 'busy') as 'ready' | 'busy' | 'faulted' | 'offline',
        available: isAvailable,
        capabilities,
      };

      if (currentLease) {
        oahlDev.currentReservation = {
          reservationId: currentLease.id,
          owner: currentLease.owner,
          expiresAt: new Date(currentLease.expiresAt).toISOString(),
          scope: currentLease.mode === 'shared-read' ? 'shared' : 'exclusive',
        };
      }

      devices.push(oahlDev);
    }

    return {
      protocolVersion: OAHL_PROTOCOL_VERSION,
      timestamp: nowIso,
      devices,
    };
  }

  /**
   * Phase 2: Reserve (Allocate)
   * Acquire a time-bound lease on a specific hardware device.
   */
  async reserve(req: OahlReserveRequest): Promise<OahlReserveResponse> {
    if (!req.deviceId) {
      throw new OahlValidationError("Missing required parameter 'deviceId'.");
    }
    if (!req.owner) {
      throw new OahlValidationError("Missing required parameter 'owner'.");
    }

    const deviceExists = this.runtime.devices().some((d) => d.id === req.deviceId);
    if (!deviceExists) {
      throw new OahlDeviceNotFoundError(req.deviceId);
    }

    const requestedTtl = req.ttlMs ?? this.defaultTtlMs;
    const boundedTtl = Math.min(Math.max(requestedTtl, 1000), this.maxTtlMs);

    const scope: LeaseScopeInput =
      req.capabilities && req.capabilities.length > 0
        ? {
            kind: 'capability',
            deviceId: req.deviceId,
            capabilities: req.capabilities,
          }
        : {
            kind: 'device',
            deviceId: req.deviceId,
          };

    try {
      const acquireOpts: AcquireLeaseOptions = {
        owner: req.owner,
        ttlMs: boundedTtl,
        mode: req.scope === 'shared' ? 'shared-read' : 'exclusive',
        scope,
      };

      const lease = this.leaseManager.acquire(acquireOpts);

      return {
        reservationId: lease.id,
        deviceId: req.deviceId,
        owner: req.owner,
        grantedTtlMs: boundedTtl,
        expiresAt: new Date(lease.expiresAt).toISOString(),
        status: 'acquired',
      };
    } catch (err) {
      if (err instanceof PinoutStructuredError && err.code === 'LEASE_CONFLICT') {
        const details = err.details as { owner?: string } | undefined;
        throw new OahlReservationConflictError(req.deviceId, details?.owner);
      }
      throw err;
    }
  }

  /**
   * Heartbeat / Renew reservation
   */
  async renew(req: OahlRenewRequest): Promise<OahlRenewResponse> {
    if (!req.reservationId) {
      throw new OahlValidationError("Missing required parameter 'reservationId'.");
    }

    const lease = this.leaseManager.get(req.reservationId);
    if (!lease) {
      throw new OahlReservationExpiredError(req.reservationId);
    }

    const requestedTtl = req.ttlMs ?? this.defaultTtlMs;
    const boundedTtl = Math.min(Math.max(requestedTtl, 1000), this.maxTtlMs);

    try {
      const renewed = this.leaseManager.renew(req.reservationId, lease.owner, boundedTtl);
      return {
        reservationId: renewed.id,
        grantedTtlMs: boundedTtl,
        expiresAt: new Date(renewed.expiresAt).toISOString(),
      };
    } catch (err) {
      if (err instanceof PinoutStructuredError && err.code === 'LEASE_EXPIRED') {
        throw new OahlReservationExpiredError(req.reservationId);
      }
      throw err;
    }
  }

  /**
   * Phase 3: Execute
   * Execute an action/capability on a device under an active reservation.
   */
  async execute(req: OahlExecuteRequest): Promise<OahlExecuteResponse> {
    if (!req.reservationId) {
      throw new OahlValidationError("Missing required parameter 'reservationId'.");
    }
    if (!req.deviceId) {
      throw new OahlValidationError("Missing required parameter 'deviceId'.");
    }
    if (!req.action) {
      throw new OahlValidationError("Missing required parameter 'action'.");
    }

    const lease = this.leaseManager.get(req.reservationId);
    if (!lease) {
      throw new OahlReservationExpiredError(req.reservationId);
    }

    // Verify lease covers this device & capability
    const check = this.leaseManager.permits(
      lease.owner,
      req.deviceId,
      req.action,
      lease.mode,
    );
    if (!check.permitted) {
      throw new OahlReservationConflictError(req.deviceId, check.conflict?.owner);
    }

    const executionId = `exec_${++this.executionCounter}_${Date.now()}`;
    const executedAt = new Date().toISOString();

    try {
      const result = await this.runtime.invoke(req.deviceId, req.action, req.params ?? {});
      return {
        executionId,
        deviceId: req.deviceId,
        action: req.action,
        status: 'completed',
        result,
        executedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof PinoutError || err instanceof DeviceError
          ? err.code
          : 'EXECUTION_FAILED';

      return {
        executionId,
        deviceId: req.deviceId,
        action: req.action,
        status: 'failed',
        error: {
          code,
          message,
        },
        executedAt,
      };
    }
  }

  /**
   * Phase 4: Release
   * Release reservation and optionally safe-park device.
   */
  async release(req: OahlReleaseRequest): Promise<OahlReleaseResponse> {
    if (!req.reservationId) {
      throw new OahlValidationError("Missing required parameter 'reservationId'.");
    }

    const lease = this.leaseManager.get(req.reservationId);
    if (lease) {
      this.leaseManager.forceRelease(req.reservationId);
      // If safePark requested and device specified, attempt stop or safe home if capability exists
      if (req.safePark && req.deviceId) {
        try {
          const dev = this.runtime.getDevice(req.deviceId);
          const caps = dev.capabilities;
          if (caps.some((c) => c.name.endsWith('.stop'))) {
            const stopCap = caps.find((c) => c.name.endsWith('.stop'))!;
            await this.runtime.invoke(req.deviceId, stopCap.name, {});
          }
        } catch {
          // Best effort safe-park on release
        }
      }
    }

    return {
      released: true,
      reservationId: req.reservationId,
      releasedAt: new Date().toISOString(),
    };
  }
}
