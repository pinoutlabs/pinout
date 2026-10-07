import { DeviceError } from '../../errors.js';
import type { DeviceBackend } from '../../runtime/types.js';

export type PipetteOperationalStatus = 'ready' | 'aspirating' | 'dispensing' | 'faulted';

export interface PipetteState {
  status: PipetteOperationalStatus;
  hasTip: boolean;
  maxVolumeUl: number;
  currentVolumeUl: number;
  defaultFlowRateUlPerSec: number;
}

export function createSimulatedPipetteBackend(
  options: {
    maxVolumeUl?: number;
    initialHasTip?: boolean;
    initialVolumeUl?: number;
    defaultFlowRateUlPerSec?: number;
  } = {},
): DeviceBackend {
  return new SimulatedPipetteBackend(options);
}

class SimulatedPipetteBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private state: PipetteState;
  private listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;

  constructor(
    options: {
      maxVolumeUl?: number;
      initialHasTip?: boolean;
      initialVolumeUl?: number;
      defaultFlowRateUlPerSec?: number;
    } = {},
  ) {
    const maxVol = options.maxVolumeUl ?? 1000;
    this.state = {
      status: 'ready',
      hasTip: options.initialHasTip ?? false,
      maxVolumeUl: maxVol,
      currentVolumeUl: Math.min(options.initialVolumeUl ?? 0, maxVol),
      defaultFlowRateUlPerSec: options.defaultFlowRateUlPerSec ?? 50,
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
      throw new DeviceError('DISCONNECTED', 'Simulated pipette is closed.');
    }
    if (this.state.status === 'faulted') {
      throw new DeviceError('DEVICE_FAULT', 'Pipette is faulted.');
    }

    switch (action) {
      case 'pipette.attach_tip': {
        this.state.hasTip = true;
        this.emit('pipette.tip_changed', { hasTip: true });
        return { hasTip: true };
      }

      case 'pipette.eject_tip': {
        this.state.hasTip = false;
        this.state.currentVolumeUl = 0;
        this.emit('pipette.tip_changed', { hasTip: false });
        return { hasTip: false };
      }

      case 'pipette.aspirate': {
        if (!this.state.hasTip) {
          throw new DeviceError(
            'SAFETY_INTERLOCK',
            'Cannot aspirate without a pipette tip attached. Call pipette.attach_tip first.',
          );
        }
        const volumeUl = requirePositiveNumber(payload.volumeUl, 'volumeUl');
        const availableSpace = this.state.maxVolumeUl - this.state.currentVolumeUl;
        if (volumeUl > availableSpace) {
          throw new DeviceError(
            'CAPACITY_EXCEEDED',
            `Requested aspirate volume ${volumeUl} µL exceeds remaining tip capacity ${availableSpace} µL.`,
          );
        }
        this.state.currentVolumeUl = Math.round((this.state.currentVolumeUl + volumeUl) * 100) / 100;
        this.state.status = 'ready';
        this.emit('pipette.aspirated', {
          aspiratedUl: volumeUl,
          currentVolumeUl: this.state.currentVolumeUl,
        });
        return {
          currentVolumeUl: this.state.currentVolumeUl,
          aspiratedUl: volumeUl,
        };
      }

      case 'pipette.dispense': {
        if (!this.state.hasTip) {
          throw new DeviceError(
            'SAFETY_INTERLOCK',
            'Cannot dispense without a pipette tip attached.',
          );
        }
        const volumeUl = requirePositiveNumber(payload.volumeUl, 'volumeUl');
        if (volumeUl > this.state.currentVolumeUl) {
          throw new DeviceError(
            'INSUFFICIENT_VOLUME',
            `Requested dispense volume ${volumeUl} µL exceeds liquid in tip ${this.state.currentVolumeUl} µL.`,
          );
        }
        this.state.currentVolumeUl = Math.round((this.state.currentVolumeUl - volumeUl) * 100) / 100;
        this.state.status = 'ready';
        this.emit('pipette.dispensed', {
          dispensedUl: volumeUl,
          currentVolumeUl: this.state.currentVolumeUl,
        });
        return {
          currentVolumeUl: this.state.currentVolumeUl,
          dispensedUl: volumeUl,
        };
      }

      case 'pipette.blowout': {
        this.state.currentVolumeUl = 0;
        this.emit('pipette.blown_out', { blownOut: true, currentVolumeUl: 0 });
        return { blownOut: true, currentVolumeUl: 0 };
      }

      case 'pipette.read':
        return {
          currentVolumeUl: this.state.currentVolumeUl,
          maxVolumeUl: this.state.maxVolumeUl,
          hasTip: this.state.hasTip,
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
      currentVolumeUl: this.state.currentVolumeUl,
      maxVolumeUl: this.state.maxVolumeUl,
      hasTip: this.state.hasTip,
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
