/**
 * BLE discovery — advertisement observation only.
 *
 * Never connects, pairs, bonds, or writes GATT characteristics. Service UUIDs
 * and names come from advertisement / BlueZ cache metadata that does not
 * require an ATT session. Confidence stays within the weak-heuristic cap
 * (≤ 0.5) because local names and UUIDs are spoofable.
 *
 * Platform support (zero native deps):
 * - Linux with BlueZ `bluetoothctl`: bounded passive scan, then parse devices.
 * - macOS / Windows / missing radio tooling: return [] rather than guessing.
 *
 * CI uses `simulatedBleScan([...])` — same plugin path, no radio required.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiscoveredCandidate, DiscoveryOptions, DiscoveryPlugin, Evidence } from './core.js';
import { candidateId } from './core.js';

const execFileAsync = promisify(execFile);

/** Observed BLE advertisement / cached BlueZ device metadata (read-only). */
export interface BleAdvertisement {
  /** Bluetooth address (MAC), normalized to lowercase colon-separated. */
  address: string;
  localName?: string;
  serviceUuids?: string[];
  /** Bluetooth company identifier from manufacturer data, when known. */
  manufacturerId?: number;
  rssi?: number;
}

export interface BleScanOptions {
  timeoutMs: number;
}

/** Read-only scanner. Must not connect or actuate. */
export type BleScan = (options: BleScanOptions) => Promise<BleAdvertisement[]>;

export interface BleIdentityRule {
  testName?: RegExp;
  /** Normalized lowercase UUID (with or without dashes). */
  serviceUuid?: string;
  moduleId: string;
  vendor?: string;
  deviceClass?: string;
  confidence: number;
  reason: string;
  /**
   * When true, `moduleId` is a discovery hint only — it is not expected to
   * resolve in the builtin module registry (no dangling installable id).
   */
  unavailable?: boolean;
}

/**
 * Weak heuristics only — names and UUIDs are not device-confirmed handshakes.
 *
 * Every `moduleId` must either exist in `@pinout/core` builtin modules or set
 * `unavailable: true`. Do not reference installable-looking ids that are not
 * registered (`pinout/micropython-bridge`, `pinout/bridge`, bare `unknown/*`
 * without the unavailable flag).
 */
export const BLE_RULES: BleIdentityRule[] = [
  {
    testName: /esp32|espressif/i,
    moduleId: 'pinout/esp32',
    vendor: 'Espressif',
    deviceClass: 'microcontroller',
    confidence: 0.5,
    reason: 'advertised local name resembles an ESP32 board',
  },
  {
    testName: /pico|raspberry\s*pi/i,
    // Desk Pico path is USB CDC today; BLE name match is a weak hint only.
    moduleId: 'pinout/board',
    vendor: 'Raspberry Pi',
    deviceClass: 'microcontroller',
    confidence: 0.45,
    reason: 'advertised local name resembles a Raspberry Pi / Pico board',
  },
  {
    testName: /arduino/i,
    moduleId: 'pinout/board',
    vendor: 'Arduino',
    deviceClass: 'microcontroller',
    confidence: 0.35,
    reason: 'advertised local name resembles an Arduino board',
  },
  {
    testName: /pinout/i,
    moduleId: 'pinout/board',
    vendor: 'Pinout',
    deviceClass: 'bridge',
    confidence: 0.5,
    reason: 'advertised local name mentions Pinout',
  },
  {
    // Nordic UART Service — common on maker BLE bridges; still a weak signal.
    serviceUuid: '6e400001b5a3f393e0a9e50e24dcca9e',
    moduleId: 'unavailable/ble-nordic-uart',
    unavailable: true,
    confidence: 0.4,
    reason: 'advertisement lists Nordic UART Service UUID',
  },
  {
    serviceUuid: '0000ffe000001000800000805f9b34fb',
    moduleId: 'unavailable/ble-ffe0',
    unavailable: true,
    confidence: 0.35,
    reason: 'advertisement lists common 0xFFE0 vendor service UUID',
  },
];

const WEAK_HEURISTIC_CAP = 0.5;

export function normalizeBleAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function normalizeBleUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

/** Test double: return fixed advertisements without touching a radio. */
export function simulatedBleScan(advertisements: BleAdvertisement[]): BleScan {
  return async (_options: BleScanOptions): Promise<BleAdvertisement[]> =>
    advertisements.map((ad) => ({
      address: normalizeBleAddress(ad.address),
      ...(ad.localName !== undefined ? { localName: ad.localName } : {}),
      ...(ad.serviceUuids !== undefined
        ? { serviceUuids: ad.serviceUuids.map((uuid) => uuid.toLowerCase()) }
        : {}),
      ...(ad.manufacturerId !== undefined ? { manufacturerId: ad.manufacturerId } : {}),
      ...(ad.rssi !== undefined ? { rssi: ad.rssi } : {}),
    }));
}

/**
 * Parse `bluetoothctl` scan / devices text into advertisements.
 * Exported for unit tests — no radio required.
 */
export function parseBluetoothctlOutput(text: string): BleAdvertisement[] {
  const byAddress = new Map<string, BleAdvertisement>();

  const ensure = (rawAddress: string): BleAdvertisement => {
    const address = normalizeBleAddress(rawAddress);
    const existing = byAddress.get(address);
    if (existing) return existing;
    const created: BleAdvertisement = { address };
    byAddress.set(address, created);
    return created;
  };

  const ansiEscape = String.fromCharCode(27);
  const ansiColorPattern = new RegExp(`${ansiEscape}\\[[0-9;]*m`, 'g');

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip ANSI color codes from bluetoothctl TTY output.
    const line = rawLine.replace(ansiColorPattern, '').trim();
    if (!line) continue;

    const rssiMatch = line.match(
      /Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+RSSI:\s*(-?\d+)/i,
    );
    if (rssiMatch) {
      const ad = ensure(rssiMatch[1]!);
      ad.rssi = Number.parseInt(rssiMatch[2]!, 10);
      continue;
    }

    const uuidMatch = line.match(
      /Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\s+UUID:\s*([0-9a-fA-F-]+)/i,
    );
    if (uuidMatch) {
      const ad = ensure(uuidMatch[1]!);
      const uuid = uuidMatch[2]!.toLowerCase();
      ad.serviceUuids = [...new Set([...(ad.serviceUuids ?? []), uuid])];
      continue;
    }

    const nameMatch = line.match(
      /(?:\[(?:NEW|CHG)\]\s+)?Device\s+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})(?:\s+(.+))?$/i,
    );
    if (nameMatch) {
      const ad = ensure(nameMatch[1]!);
      const rest = nameMatch[2]?.trim();
      if (
        rest &&
        !/^RSSI:/i.test(rest) &&
        !/^UUID:/i.test(rest) &&
        !/^TxPower:/i.test(rest) &&
        !/^Connected:/i.test(rest) &&
        rest !== 'not available'
      ) {
        ad.localName = rest;
      }
    }
  }

  return [...byAddress.values()];
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux BlueZ path: `bluetoothctl --timeout N scan on` then `devices`.
 * Never issues connect/pair/gatt commands.
 */
export async function linuxBluetoothctlScan(
  options: BleScanOptions,
  exec: typeof execFileAsync = execFileAsync,
): Promise<BleAdvertisement[]> {
  const timeoutSec = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  const execTimeoutMs = options.timeoutMs + 3000;
  let combined = '';

  try {
    const scan = await exec('bluetoothctl', ['--timeout', String(timeoutSec), 'scan', 'on'], {
      timeout: execTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    combined += `${scan.stdout}\n${scan.stderr}\n`;
  } catch (error) {
    // bluetoothctl --timeout exits non-zero when the timer fires; stdout still
    // carries [NEW]/[CHG] lines. Treat that as success when we got output.
    if (error && typeof error === 'object' && 'stdout' in error) {
      const failed = error as { stdout?: string; stderr?: string };
      combined += `${failed.stdout ?? ''}\n${failed.stderr ?? ''}\n`;
    } else {
      return [];
    }
  }

  try {
    const devices = await exec('bluetoothctl', ['devices'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    combined += `${devices.stdout}\n${devices.stderr}\n`;
  } catch {
    // devices list is best-effort; scan output alone may still yield candidates
  }

  return parseBluetoothctlOutput(combined);
}

/** True when this host can attempt a real nearby BLE scan (not a guarantee of radio). */
export async function bleScanAvailable(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== 'linux') return false;
  return commandExists('bluetoothctl');
}

/**
 * Default scanner: Linux + bluetoothctl when present; otherwise empty.
 * macOS/Windows return [] — no zero-dependency nearby LE scan without native bindings.
 */
export async function defaultBleScan(options: BleScanOptions): Promise<BleAdvertisement[]> {
  if (process.platform !== 'linux') {
    return [];
  }
  if (!(await commandExists('bluetoothctl'))) {
    return [];
  }
  return linuxBluetoothctlScan(options);
}

export function advertisementToCandidate(ad: BleAdvertisement): DiscoveredCandidate {
  const evidence: Evidence[] = [
    {
      source: 'ble-advertisement',
      detail: `BLE advertisement from ${ad.address}${ad.rssi !== undefined ? ` (RSSI ${ad.rssi})` : ''}`,
      weight: 0.3,
    },
  ];
  const identities: Array<{
    moduleId: string;
    vendor?: string;
    deviceClass?: string;
    reason: string;
    unavailable?: boolean;
  }> = [];
  let confidence = 0.25;

  if (ad.localName) {
    evidence.push({
      source: 'ble-local-name',
      detail: `local name '${ad.localName}'`,
      weight: 0.45,
    });
    for (const rule of BLE_RULES) {
      if (rule.testName && rule.testName.test(ad.localName)) {
        identities.push({
          moduleId: rule.moduleId,
          ...(rule.vendor !== undefined ? { vendor: rule.vendor } : {}),
          ...(rule.deviceClass !== undefined ? { deviceClass: rule.deviceClass } : {}),
          reason: rule.reason,
          ...(rule.unavailable ? { unavailable: true } : {}),
        });
        confidence = Math.max(confidence, rule.confidence);
      }
    }
  }

  const normalizedUuids = (ad.serviceUuids ?? []).map(normalizeBleUuid);
  if (normalizedUuids.length > 0) {
    evidence.push({
      source: 'ble-service-uuid',
      detail: `advertised service UUID(s): ${ad.serviceUuids!.join(', ')}`,
      weight: 0.4,
    });
    for (const rule of BLE_RULES) {
      if (!rule.serviceUuid) continue;
      if (normalizedUuids.includes(normalizeBleUuid(rule.serviceUuid))) {
        identities.push({
          moduleId: rule.moduleId,
          ...(rule.vendor !== undefined ? { vendor: rule.vendor } : {}),
          ...(rule.deviceClass !== undefined ? { deviceClass: rule.deviceClass } : {}),
          reason: rule.reason,
          ...(rule.unavailable ? { unavailable: true } : {}),
        });
        confidence = Math.max(confidence, rule.confidence);
      }
    }
  }

  if (identities.length === 0) {
    identities.push({
      moduleId: 'unavailable/ble',
      unavailable: true,
      reason: 'BLE advertisement with no matching name or service UUID signature',
    });
  }

  // Hard cap: advertisement metadata alone is never a device-confirmed handshake.
  confidence = Math.min(confidence, WEAK_HEURISTIC_CAP);

  const details: Record<string, unknown> = {};
  if (ad.localName !== undefined) details.localName = ad.localName;
  if (ad.serviceUuids !== undefined) details.serviceUuids = ad.serviceUuids;
  if (ad.manufacturerId !== undefined) details.manufacturerId = ad.manufacturerId;
  if (ad.rssi !== undefined) details.rssi = ad.rssi;

  return {
    id: candidateId({ kind: 'ble', address: ad.address }),
    endpoint: {
      kind: 'ble',
      address: ad.address,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
    possibleIdentity: identities,
    evidence,
    confidence,
    interfaces: ['ble'],
  };
}

export function bleDiscoveryPlugin(scan: BleScan = defaultBleScan): DiscoveryPlugin {
  return {
    name: 'ble',
    async discover(options: DiscoveryOptions): Promise<DiscoveredCandidate[]> {
      const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 2000, 200), 10_000);
      let advertisements: BleAdvertisement[];
      try {
        advertisements = await scan({ timeoutMs });
      } catch {
        // Missing radio / permission / tooling → empty, never invent devices.
        return [];
      }
      return advertisements.map(advertisementToCandidate);
    },
  };
}
