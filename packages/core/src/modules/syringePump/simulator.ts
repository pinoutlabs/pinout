import { DeviceError } from '../../errors.js';
import type { DeviceBackend } from '../../runtime/types.js';

export type SyringePumpDirection = 'infuse' | 'withdraw' | 'idle';
export type SyringePumpOperationalStatus = 'ready' | 'running' | 'stopped' | 'faulted';

export interface SyringePumpState {
  status: SyringePumpOperationalStatus;
  syringeCapacityMl: number;
  remainingVolumeMl: number;
  totalInfusedMl: number;
  rateMlPerMin: number;
  direction: SyringePumpDirection;
  running: boolean;
}

export function createSimulatedSyringePumpBackend(
  options: {
    syringeCapacityMl?: number;
    initialVolumeMl?: number;
    defaultRateMlPerMin?: number;
  } = {},
): DeviceBackend {
  return new SimulatedSyringePumpBackend(options);
}

class SimulatedSyringePumpBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private state: SyringePumpState;
  private listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;

  constructor(options: {
    syringeCapacityMl?: number;
    initialVolumeMl?: number;
    defaultRateMlPerMin?: number;
  } = {}) {
    const capacity = options.syringeCapacityMl ?? 50;
    const initialVolume = options.initialVolumeMl ?? 50;
    this.state = {
      status: 'ready',
      syringeCapacityMl: capacity,
      remainingVolumeMl: Math.min(initialVolume, capacity),
      totalInfusedMl: 0,
      rateMlPerMin: options.defaultRateMlPerMin ?? 1.0,
      direction: 'idle',
      running: false,
    };
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }

  getOperationalState(): Record<string, unknown> {
    return this.snapshotOperationalState();
  }

  async invoke(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new DeviceError('DISCONNECTED', 'Simulated syringe pump is closed.');
    }
    if (this.state.status === 'faulted') {
      throw new DeviceError('DEVICE_FAULT', 'Syringe pump is faulted.');
    }

    switch (action) {
      case 'syringe_pump.infuse': {
        const volumeMl = requirePositiveNumber(payload.volumeMl, 'volumeMl');
        if (typeof payload.rateMlPerMin === 'number') {
          this.state.rateMlPerMin = requirePositiveNumber(payload.rateMlPerMin, 'rateMlPerMin');
        }
        if (volumeMl > this.state.remainingVolumeMl) {
          throw new DeviceError(
            'INSUFFICIENT_VOLUME',
            `Requested infuse volume ${volumeMl} mL exceeds available volume ${this.state.remainingVolumeMl} mL.`,
          );
        }
        this.state.remainingVolumeMl = Math.round((this.state.remainingVolumeMl - volumeMl) * 1000) / 1000;
        this.state.totalInfusedMl = Math.round((this.state.totalInfusedMl + volumeMl) * 1000) / 1000;
        this.state.direction = 'idle';
        this.state.running = false;
        this.state.status = 'ready';
        this.emit('syringe_pump.infused', {
          infusedMl: volumeMl,
          remainingVolumeMl: this.state.remainingVolumeMl,
        });
        return {
          infusedMl: volumeMl,
          remainingVolumeMl: this.state.remainingVolumeMl,
        };
      }

      case 'syringe_pump.withdraw': {
        const volumeMl = requirePositiveNumber(payload.volumeMl, 'volumeMl');
        if (typeof payload.rateMlPerMin === 'number') {
          this.state.rateMlPerMin = requirePositiveNumber(payload.rateMlPerMin, 'rateMlPerMin');
        }
        const maxCanWithdraw = this.state.syringeCapacityMl - this.state.remainingVolumeMl;
        if (volumeMl > maxCanWithdraw) {
          throw new DeviceError(
            'CAPACITY_EXCEEDED',
            `Requested withdraw volume ${volumeMl} mL exceeds syringe remaining capacity ${maxCanWithdraw} mL.`,
          );
        }
        this.state.remainingVolumeMl = Math.round((this.state.remainingVolumeMl + volumeMl) * 1000) / 1000;
        this.state.direction = 'idle';
        this.state.running = false;
        this.state.status = 'ready';
        this.emit('syringe_pump.withdrawn', {
          withdrawnMl: volumeMl,
          remainingVolumeMl: this.state.remainingVolumeMl,
        });
        return {
          withdrawnMl: volumeMl,
          remainingVolumeMl: this.state.remainingVolumeMl,
        };
      }

      case 'syringe_pump.set_rate': {
        const rate = requirePositiveNumber(payload.rateMlPerMin, 'rateMlPerMin');
        this.state.rateMlPerMin = rate;
        this.emit('syringe_pump.rate_changed', { rateMlPerMin: rate });
        return { rateMlPerMin: rate };
      }

      case 'syringe_pump.stop': {
        this.state.running = false;
        this.state.direction = 'idle';
        this.state.status = 'stopped';
        this.emit('syringe_pump.stopped', { stopped: true });
        return { stopped: true };
      }

      case 'syringe_pump.read':
        return {
          remainingVolumeMl: this.state.remainingVolumeMl,
          totalInfusedMl: this.state.totalInfusedMl,
          rateMlPerMin: this.state.rateMlPerMin,
          direction: this.state.direction,
          running: this.state.running,
        };

      case 'status.read':
        return this.snapshotOperationalState();

      default:
        throw new DeviceError('UNKNOWN_ACTION', `Unknown action '${action}'.`);
    }
  }

  private snapshotOperationalState(): Record<string, unknown> {
    return {
      status: this.state.status,
      syringeCapacityMl: this.state.syringeCapacityMl,
      remainingVolumeMl: this.state.remainingVolumeMl,
      totalInfusedMl: this.state.totalInfusedMl,
      rateMlPerMin: this.state.rateMlPerMin,
      direction: this.state.direction,
      running: this.state.running,
    };
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DeviceError('INVALID_PAYLOAD', `${field} must be a positive finite number.`);
  }
  return value;
}
