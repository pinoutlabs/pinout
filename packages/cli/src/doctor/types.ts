import type { Device, DevicesFile, Transport } from '@pinout/core';
import type { BoardDescriptor } from '@pinout/core';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type DoctorStage =
  'environment' | 'daemon' | 'discovery' | 'firmware' | 'configuration' | 'simulator';

export interface DoctorCheckResult {
  stage: DoctorStage;
  name: string;
  status: DoctorStatus;
  detail: string;
  nextStep?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface DoctorSummary {
  total: number;
  passed: number;
  warned: number;
  failed: number;
  skipped: number;
}

export interface DoctorReport {
  ok: boolean;
  status: 'pass' | 'warn' | 'fail';
  summary: DoctorSummary;
  checks: DoctorCheckResult[];
  nextSteps: string[];
}

export interface DoctorOptions {
  daemon?: boolean | undefined;
  port?: string | undefined;
  device?: string | undefined;
  mock?: boolean | undefined;
  timeoutMs?: number | undefined;
  url?: string | undefined;
  json?: boolean | undefined;
}

export interface SerialPortEntry {
  path: string;
  manufacturer?: string | undefined;
  serialNumber?: string | undefined;
  vendorId?: string | undefined;
  productId?: string | undefined;
}

export interface DoctorDependencies {
  nodeVersion?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  listSerialPorts?: (() => Promise<SerialPortEntry[]>) | undefined;
  /** Injectable BLE availability probe (defaults to BlueZ bluetoothctl on Linux). */
  bleScanAvailable?: (() => Promise<boolean>) | undefined;
  /** Injectable read-only BLE discovery (defaults to advertisement-only plugin). */
  discoverBle?: (() => Promise<
    Array<{ endpoint: { address: string }; possibleIdentity: Array<{ moduleId: string }> }>
  >) | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  boardsDir?: string | undefined;
  loadBoards?:
    | ((dir: string) => {
        boards: BoardDescriptor[];
        errors: Array<{ file: string; message: string }>;
      })
    | undefined;
  readDevicesFile?: ((path?: string, home?: string) => DevicesFile) | undefined;
  connect?:
    ((options: { transport: Transport; timeoutMs?: number }) => Promise<Device>) | undefined;
  createSerialTransport?: ((options: { path: string; baudRate?: number }) => Transport) | undefined;
  isHomeWritable?: ((dir: string) => boolean) | undefined;
}
