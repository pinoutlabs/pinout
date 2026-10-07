import { DeviceError } from '../../errors.js';
import type { DeviceBackend } from '../../runtime/types.js';

export type HeaterShakerOperationalStatus = 'ready' | 'running' | 'faulted';

export interface HeaterShakerState {
  status: HeaterShakerOperationalStatus;
  currentTemperatureC: number;
  targetTemperatureC: number;
  currentRpm: number;
  targetRpm: number;
  running: boolean;
  heating: boolean;
}

export function createSimulatedHeaterShakerBackend(
  options: {
    initialTemperatureC?: number;
    initialTargetTempC?: number;
    initialTargetRpm?: number;
  } = {},
): DeviceBackend {
  return new SimulatedHeaterShakerBackend(options);
}

class SimulatedHeaterShakerBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private state: HeaterShakerState;
  private listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  private closed = false;

  constructor(
    options: {
      initialTemperatureC?: number;
      initialTargetTempC?: number;
      initialTargetRpm?: number;
    } = {},
  ) {
    const temp = options.initialTemperatureC ?? 22;
    this.state = {
      status: 'ready',
      currentTemperatureC: temp,
      targetTemperatureC: options.initialTargetTempC ?? temp,
      currentRpm: 0,
      targetRpm: options.initialTargetRpm ?? 500,
      running: false,
      heating: false,
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
      throw new DeviceError('DISCONNECTED', 'Simulated heater-shaker is closed.');
    }
    if (this.state.status === 'faulted') {
      throw new DeviceError('DEVICE_FAULT', 'Heater-shaker is faulted.');
    }

    switch (action) {
      case 'temperature.set': {
        const temp = requireNumber(payload.targetTemperatureC, 'targetTemperatureC');
        if (temp < 4 || temp > 100) {
          throw new DeviceError('OUT_OF_RANGE', 'Temperature must be between 4°C and 100°C.');
        }
        this.state.targetTemperatureC = temp;
        this.state.currentTemperatureC = temp;
        this.state.heating = temp > 25;
        this.emit('temperature.changed', {
          currentTemperatureC: this.state.currentTemperatureC,
          targetTemperatureC: this.state.targetTemperatureC,
        });
        return { targetTemperatureC: temp };
      }

      case 'temperature.read':
        return {
          currentTemperatureC: this.state.currentTemperatureC,
          targetTemperatureC: this.state.targetTemperatureC,
          heating: this.state.heating,
        };

      case 'shaker.set_speed': {
        const rpm = requireNonNegativeNumber(payload.rpm, 'rpm');
        if (rpm > 3000) {
          throw new DeviceError('OUT_OF_RANGE', 'RPM exceeds maximum limit of 3,000.');
        }
        this.state.targetRpm = rpm;
        this.emit('shaker.target_rpm_changed', { targetRpm: rpm });
        return { targetRpm: rpm };
      }

      case 'shaker.start': {
        if (this.state.targetRpm <= 0) {
          throw new DeviceError(
            'INVALID_TARGET_SPEED',
            'Target RPM must be greater than zero to start.',
          );
        }
        this.state.running = true;
        this.state.currentRpm = this.state.targetRpm;
        this.state.status = 'running';
        this.emit('shaker.started', { running: true, targetRpm: this.state.targetRpm });
        return { running: true, targetRpm: this.state.targetRpm };
      }

      case 'shaker.stop': {
        this.state.running = false;
        this.state.currentRpm = 0;
        this.state.status = 'ready';
        this.emit('shaker.stopped', { running: false, currentRpm: 0 });
        return { running: false };
      }

      case 'shaker.read':
        return {
          currentRpm: this.state.currentRpm,
          targetRpm: this.state.targetRpm,
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
      currentTemperatureC: this.state.currentTemperatureC,
      targetTemperatureC: this.state.targetTemperatureC,
      currentRpm: this.state.currentRpm,
      targetRpm: this.state.targetRpm,
      running: this.state.running,
      heating: this.state.heating,
    };
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeviceError('INVALID_PAYLOAD', `${field} must be a finite number.`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DeviceError('INVALID_PAYLOAD', `${field} must be a non-negative finite number.`);
  }
  return value;
}
