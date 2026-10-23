import { join } from 'node:path';
import { listSerialPorts, loadBoardDescriptors, type BoardDescriptor } from '@pinout/core';
import { bleDiscoveryPlugin, bleScanAvailable, runDiscovery } from '@pinout/discovery';
import type {
  DoctorCheckResult,
  DoctorDependencies,
  DoctorOptions,
  SerialPortEntry,
} from './types.js';

const BUILTIN_BOARD_FALLBACKS: Array<{
  boardId: string;
  family: string;
  mcu: string;
  vendorId: string;
  productId?: string;
}> = [
  {
    boardId: 'esp32-devkit-v1',
    family: 'esp32',
    mcu: 'ESP32-D0WD',
    vendorId: '10c4',
    productId: 'ea60',
  },
  {
    boardId: 'esp32-devkit-v1-ch340',
    family: 'esp32',
    mcu: 'ESP32-D0WD',
    vendorId: '1a86',
    productId: '7523',
  },
  {
    boardId: 'esp32-c3-supermini',
    family: 'esp32-c3',
    mcu: 'ESP32-C3',
    vendorId: '303a',
    productId: '1001',
  },
  {
    boardId: 'raspberry-pi-pico',
    family: 'rp2040',
    mcu: 'RP2040',
    vendorId: '2e8a',
    productId: '0003',
  },
  {
    boardId: 'arduino-uno',
    family: 'avr',
    mcu: 'ATmega328P',
    vendorId: '2341',
    productId: '0043',
  },
];

export async function checkDiscovery(
  options: DoctorOptions,
  deps: DoctorDependencies,
): Promise<{ checks: DoctorCheckResult[]; ports: SerialPortEntry[] }> {
  const checks: DoctorCheckResult[] = [];
  const listPortsFn = deps.listSerialPorts ?? listSerialPorts;

  let ports: SerialPortEntry[] = [];
  try {
    ports = await listPortsFn();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (options.mock) {
      // Mock mode does not need a host serial stack (e.g. missing udevadm).
      checks.push({
        stage: 'discovery',
        name: 'serial-ports',
        status: 'pass',
        detail: `Serial enumeration unavailable (${errorMessage}); mock mode active.`,
      });
      checks.push(await checkBleDiscovery(options, deps));
      return { checks, ports: [] };
    }
    checks.push({
      stage: 'discovery',
      name: 'serial-ports',
      status: 'fail',
      detail: `Failed to enumerate serial ports: ${errorMessage}`,
      nextStep: 'Check OS serial driver and USB permissions.',
    });
    checks.push(await checkBleDiscovery(options, deps));
    return { checks, ports: [] };
  }

  if (ports.length === 0) {
    if (options.mock) {
      checks.push({
        stage: 'discovery',
        name: 'serial-ports',
        status: 'pass',
        detail: 'No serial ports detected (mock mode active).',
      });
    } else {
      checks.push({
        stage: 'discovery',
        name: 'serial-ports',
        status: 'warn',
        detail:
          'No serial ports detected on host. If using hardware, connect your board via USB data cable; if testing software, pass --mock.',
        nextStep:
          'Connect an ESP32 board via USB data cable, verify the cable carries data, or pass --mock for local simulation.',
      });
    }
    checks.push(await checkBleDiscovery(options, deps));
    return { checks, ports };
  }

  checks.push({
    stage: 'discovery',
    name: 'serial-ports',
    status: 'pass',
    detail: `${ports.length} serial port(s) detected.`,
  });

  checks.push(await checkBleDiscovery(options, deps));

  const loadedBoards = loadDescriptors(deps);

  for (const port of ports) {
    const rawVid = port.vendorId ? normalizeHex(port.vendorId) : undefined;
    const rawPid = port.productId ? normalizeHex(port.productId) : undefined;

    const matchedBoard = findMatchingBoard(rawVid, rawPid, loadedBoards);

    if (matchedBoard) {
      checks.push({
        stage: 'discovery',
        name: `board-match:${port.path}`,
        status: 'pass',
        detail: `Port ${port.path}: matched board '${matchedBoard.boardId}' (${matchedBoard.family}, MCU: ${matchedBoard.mcu}, VID:${rawVid} PID:${rawPid ?? '*'}).`,
        meta: {
          port: port.path,
          boardId: matchedBoard.boardId,
          family: matchedBoard.family,
          mcu: matchedBoard.mcu,
          vid: rawVid,
          pid: rawPid,
        },
      });
    } else {
      const vidDisplay = rawVid ?? 'unknown';
      const pidDisplay = rawPid ?? 'unknown';
      const manufacturerDisplay = port.manufacturer ? `, manufacturer: ${port.manufacturer}` : '';
      checks.push({
        stage: 'discovery',
        name: `board-match:${port.path}`,
        status: 'warn',
        detail: `Port ${port.path}: unidentified board (VID:${vidDisplay} PID:${pidDisplay}${manufacturerDisplay}). Pinout will never auto-flash unidentified boards.`,
        nextStep:
          'Confirm board identity and manually flash Pinout bridge firmware using PlatformIO ("pio run -e esp32dev -t upload") per firmware/esp32-bridge/README.md.',
        meta: {
          port: port.path,
          vid: rawVid,
          pid: rawPid,
          manufacturer: port.manufacturer,
        },
      });
    }
  }

  return { checks, ports };
}

/**
 * Advertisement-only BLE check. Never connects or actuates. Unsupported
 * platforms report pass with an honest empty/unavailable detail (same honesty
 * pattern as Windows USB discovery) — not a warn that would fail green CI.
 */
async function checkBleDiscovery(
  options: DoctorOptions,
  deps: DoctorDependencies,
): Promise<DoctorCheckResult> {
  if (options.mock) {
    return {
      stage: 'discovery',
      name: 'ble-scan',
      status: 'pass',
      detail: 'BLE scan skipped in mock mode (no radio claims).',
    };
  }

  const availableFn = deps.bleScanAvailable ?? bleScanAvailable;
  let available = false;
  try {
    available = await availableFn();
  } catch {
    available = false;
  }

  if (!available) {
    return {
      stage: 'discovery',
      name: 'ble-scan',
      status: 'pass',
      detail:
        'BLE nearby scan unavailable on this platform/tooling (returns empty; Linux needs BlueZ bluetoothctl). No devices invented.',
    };
  }

  try {
    const discoverFn =
      deps.discoverBle ??
      (async () => {
        const run = await runDiscovery({
          plugins: [bleDiscoveryPlugin()],
          timeoutMs: options.timeoutMs ?? 1500,
        });
        return run.candidates;
      });
    const candidates = await discoverFn();
    if (candidates.length === 0) {
      return {
        stage: 'discovery',
        name: 'ble-scan',
        status: 'pass',
        detail: 'BLE advertisement scan available; no nearby advertisements observed (never connects).',
      };
    }
    const preview = candidates
      .slice(0, 3)
      .map((candidate) => {
        const identity = candidate.possibleIdentity[0]?.moduleId ?? 'unknown/ble';
        return `${candidate.endpoint.address} (${identity})`;
      })
      .join(', ');
    return {
      stage: 'discovery',
      name: 'ble-scan',
      status: 'pass',
      detail: `BLE advertisement scan found ${candidates.length} candidate(s): ${preview}. Confidence capped as weak heuristics; never connects.`,
      meta: { count: candidates.length },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stage: 'discovery',
      name: 'ble-scan',
      status: 'pass',
      detail: `BLE scan tooling present but scan failed (${message}); returning empty rather than guessing.`,
    };
  }
}

function normalizeHex(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase().padStart(4, '0');
}

function loadDescriptors(deps: DoctorDependencies): BoardDescriptor[] {
  const loader = deps.loadBoards ?? loadBoardDescriptors;
  const boardsDir = deps.boardsDir ?? join(process.cwd(), 'firmware', 'boards');

  try {
    const result = loader(boardsDir);
    if (result.boards.length > 0) {
      return result.boards;
    }
  } catch {
    // Graceful fallback to built-ins
  }

  return BUILTIN_BOARD_FALLBACKS.map((fallback) => ({
    schemaVersion: '1',
    boardId: fallback.boardId,
    family: fallback.family as BoardDescriptor['family'],
    mcu: fallback.mcu,
    gpioPins: [2],
    reservedPins: [],
    voltage: { logic: 3.3 },
    usb: { vendorId: fallback.vendorId, productId: fallback.productId ?? '' },
    support: 'IMPLEMENTED',
  }));
}

function findMatchingBoard(
  vid: string | undefined,
  pid: string | undefined,
  boards: BoardDescriptor[],
): BoardDescriptor | undefined {
  if (!vid) {
    return undefined;
  }

  const exactMatch = boards.find((board) => {
    if (!board.usb?.vendorId) return false;
    const boardVid = normalizeHex(board.usb.vendorId);
    if (boardVid !== vid) return false;
    if (board.usb.productId && pid) {
      return normalizeHex(board.usb.productId) === pid;
    }
    return true;
  });

  if (exactMatch) {
    return exactMatch;
  }

  // Check fallback known USB chips (e.g. CP2102 10c4:ea60 or CH340 1a86:*)
  const fallback = BUILTIN_BOARD_FALLBACKS.find((entry) => {
    if (normalizeHex(entry.vendorId) !== vid) return false;
    if (entry.productId && pid) {
      return normalizeHex(entry.productId) === pid;
    }
    return true;
  });

  if (fallback) {
    return {
      schemaVersion: '1',
      boardId: fallback.boardId,
      family: fallback.family as BoardDescriptor['family'],
      mcu: fallback.mcu,
      gpioPins: [2],
      reservedPins: [],
      voltage: { logic: 3.3 },
      usb: { vendorId: fallback.vendorId, productId: fallback.productId ?? '' },
      support: 'IMPLEMENTED',
    };
  }

  return undefined;
}
