import { DeviceError } from '../../errors.js';
import type { DeviceBackend } from '../../runtime/types.js';

export type CentrifugeOperationalStatus = 'ready' | 'spinning' | 'braking' | 'faulted';

export interface CentrifugeState {
  status: CentrifugeOperationalStatus;
  currentRpm: number;
  targetRpm: number;
  lidOpen: boolean;
  running: boolean;
  temperatureC: number;
}

export function createSimulatedCentrifugeBackend(
  options: {
    initialRpm?: number;
    initialLidOpen?: boolean;
    initialTemperatureC?: number;
  } = {},
): DeviceBackend {
  return new SimulatedCentrifugeBackend(options);
}

class SimulatedCentrifugeBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private state: CentrifugeState;
  private listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;

  constructor(
    options: {
      initialRpm?: number;
      initialLidOpen?: boolean;
      initialTemperatureC?: number;
    } = {},
  ) {
    this.state = {
      status: 'ready',
      currentRpm: 0,
      targetRpm: options.initialRpm ?? 3000,
      lidOpen: options.initialLidOpen ?? false,
      running: false,
      temperatureC: options.initialTemperatureC ?? 21,
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
      throw new DeviceError('DISCONNECTED', 'Simulated centrifuge is closed.');
    }
    if (this.state.status === 'faulted') {
      throw new DeviceError('DEVICE_FAULT', 'Centrifuge is faulted.');
    }

    switch (action) {
      case 'centrifuge.set_speed': {
        const rpm = requireNonNegativeNumber(payload.rpm, 'rpm');
        if (rpm > 15000) {
          throw new DeviceError('OUT_OF_RANGE', 'RPM exceeds maximum limit of 15,000.');
        }
        this.state.targetRpm = rpm;
        this.emit('centrifuge.target_rpm_changed', { targetRpm: rpm });
        return { targetRpm: rpm };
      }

      case 'centrifuge.start': {
        if (this.state.lidOpen) {
          throw new DeviceError(
            'SAFETY_INTERLOCK',
            'Cannot start centrifuge while lid is open. Close lid first.',
          );
        }
        if (this.state.targetRpm <= 0) {
          throw new DeviceError(
            'INVALID_TARGET_SPEED',
            'Target RPM must be greater than zero to start centrifuge.',
          );
        }
        this.state.running = true;
        this.state.status = 'spinning';
        this.state.currentRpm = this.state.targetRpm;
        this.emit('centrifuge.started', {
          running: true,
          targetRpm: this.state.targetRpm,
          currentRpm: this.state.currentRpm,
        });
        return { running: true, targetRpm: this.state.targetRpm };
      }

      case 'centrifuge.stop': {
        this.state.running = false;
        this.state.currentRpm = 0;
        this.state.status = 'ready';
        this.emit('centrifuge.stopped', { running: false, currentRpm: 0 });
        return { running: false };
      }

      case 'centrifuge.open_lid': {
        if (this.state.currentRpm > 0 || this.state.running) {
          throw new DeviceError(
            'SAFETY_INTERLOCK',
            `Cannot open lid while centrifuge rotor is spinning (${this.state.currentRpm} RPM). Stop centrifuge first.`,
          );
        }
        this.state.lidOpen = true;
        this.emit('centrifuge.lid_changed', { lidOpen: true });
        return { lidOpen: true };
      }

      case 'centrifuge.close_lid': {
        this.state.lidOpen = false;
        this.emit('centrifuge.lid_changed', { lidOpen: false });
        return { lidOpen: false };
      }

      case 'centrifuge.read':
        return {
          currentRpm: this.state.currentRpm,
          targetRpm: this.state.targetRpm,
          lidOpen: this.state.lidOpen,
          running: this.state.running,
          temperatureC: this.state.temperatureC,
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
      currentRpm: this.state.currentRpm,
      targetRpm: this.state.targetRpm,
      lidOpen: this.state.lidOpen,
      running: this.state.running,
      temperatureC: this.state.temperatureC,
    };
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DeviceError('INVALID_PAYLOAD', `${field} must be a non-negative finite number.`);
  }
  return value;
}
