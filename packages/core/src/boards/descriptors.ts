/**
 * Data-driven board descriptors (spec v1).
 *
 * Boards are DATA, not code: one descriptor per board family entry, one
 * loader with validation. Reserved/unsafe pins are never guessed — every pin
 * a descriptor claims must come from the board's documentation, and the
 * validator rejects overlapping reserved/usable pins.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BoardDescriptor {
  schemaVersion: '1';
  boardId: string;
  family:
    | 'esp32'
    | 'esp32-s2'
    | 'esp32-s3'
    | 'esp32-c3'
    | 'esp32-c6'
    | 'rp2040'
    | 'avr'
    | 'linux'
    | 'micropython';
  mcu: string;
  gpioPins: number[];
  adcPins?: number[];
  dacPins?: number[];
  pwmPins?: number[];
  /** Pins that must never be driven (flash, strap, USB, power). */
  reservedPins: number[];
  /** Input-only pins on this board. */
  inputOnlyPins?: number[];
  uartPins?: Array<{ id: number; tx: number; rx: number }>;
  i2cDefaults?: { sda: number; scl: number };
  spiDefaults?: { sck: number; miso: number; mosi: number; cs?: number };
  voltage: { logic: 3.3 | 5; adcMax?: number };
  usb?: { vendorId: string; productId: string };
  firmwareTarget?: string;
  warnings?: string[];
  /** Optional wireless bridge metadata (e.g. MQTT LAN sketch) from board JSON. */
  wireless?: {
    mqttBridge?: {
      firmware: string;
      support: 'IMPLEMENTED' | 'COMPILE_TESTED' | 'SIMULATED' | 'PLANNED' | 'EXPERIMENTAL';
      compileTarget?: string;
      compileStatus?: 'IMPLEMENTED' | 'COMPILE_TESTED' | 'SIMULATED' | 'PLANNED' | 'EXPERIMENTAL';
      config?: string[];
      notes?: string;
    };
  };
  support: 'IMPLEMENTED' | 'COMPILE_TESTED' | 'SIMULATED' | 'PLANNED' | 'EXPERIMENTAL';
}

const SUPPORTED_FAMILIES = new Set([
  'esp32',
  'esp32-s2',
  'esp32-s3',
  'esp32-c3',
  'esp32-c6',
  'rp2040',
  'avr',
  'linux',
  'micropython',
]);

export class BoardDescriptorError extends Error {
  readonly code = 'BOARD_DESCRIPTOR_INVALID';
}

export function validateBoardDescriptor(descriptor: unknown): BoardDescriptor {
  const board = descriptor as BoardDescriptor;
  if (board === null || typeof board !== 'object') {
    throw new BoardDescriptorError('Board descriptor must be an object.');
  }
  if (board.schemaVersion !== '1') {
    throw new BoardDescriptorError(
      `schemaVersion must be '1', received '${String(board.schemaVersion)}'.`,
    );
  }
  if (typeof board.boardId !== 'string' || board.boardId.length === 0) {
    throw new BoardDescriptorError('boardId is required.');
  }
  if (!SUPPORTED_FAMILIES.has(board.family)) {
    throw new BoardDescriptorError(`Unknown family '${String(board.family)}'.`);
  }
  if (typeof board.mcu !== 'string' || !board.mcu.trim()) {
    throw new BoardDescriptorError('mcu is required.');
  }
  if (
    !['IMPLEMENTED', 'COMPILE_TESTED', 'SIMULATED', 'PLANNED', 'EXPERIMENTAL'].includes(
      board.support,
    )
  ) {
    throw new BoardDescriptorError('Unknown support status.');
  }
  for (const field of [
    'gpioPins',
    'reservedPins',
    'adcPins',
    'dacPins',
    'pwmPins',
    'inputOnlyPins',
  ] as const) {
    const pins = board[field];
    if (pins === undefined && field !== 'gpioPins' && field !== 'reservedPins') continue;
    if (
      !Array.isArray(pins) ||
      pins.some((pin) => !Number.isInteger(pin) || pin < 0) ||
      new Set(pins).size !== pins.length
    ) {
      throw new BoardDescriptorError(
        `${board.boardId}: ${field} must contain unique nonnegative integer pins.`,
      );
    }
  }
  if (!Array.isArray(board.gpioPins) || board.gpioPins.length === 0) {
    throw new BoardDescriptorError(`${board.boardId}: gpioPins must be a non-empty array.`);
  }
  if (!Array.isArray(board.reservedPins)) {
    throw new BoardDescriptorError(
      `${board.boardId}: reservedPins must be an array (may be empty).`,
    );
  }
  const usable = new Set(board.gpioPins);
  for (const pin of board.reservedPins) {
    if (usable.has(pin)) {
      throw new BoardDescriptorError(
        `${board.boardId}: pin ${pin} is both usable and reserved — reserved pins are never guessed, fix the descriptor.`,
      );
    }
  }
  for (const field of ['adcPins', 'dacPins', 'pwmPins', 'inputOnlyPins'] as const) {
    const pins = board[field];
    if (!pins) continue;
    for (const pin of pins) {
      if (!usable.has(pin)) {
        throw new BoardDescriptorError(
          `${board.boardId}: ${field} contains pin ${pin} which is not a usable GPIO.`,
        );
      }
    }
  }
  if (board.voltage?.logic !== 3.3 && board.voltage?.logic !== 5) {
    throw new BoardDescriptorError(`${board.boardId}: voltage.logic must be 3.3 or 5.`);
  }
  return board;
}

/** Load every valid descriptor from a directory; invalid files are named, never skipped silently. */
export function loadBoardDescriptors(dir: string): {
  boards: BoardDescriptor[];
  errors: Array<{ file: string; message: string }>;
} {
  const boards: BoardDescriptor[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  if (!existsSync(dir)) {
    return { boards, errors: [{ file: dir, message: 'Descriptor directory does not exist.' }] };
  }
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.json') || entry === 'catalog.json') continue;
    const path = join(dir, entry);
    try {
      boards.push(validateBoardDescriptor(JSON.parse(readFileSync(path, 'utf8'))));
    } catch (error) {
      errors.push({ file: entry, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { boards, errors };
}

/** Look up a pin's role. Unknown pins return 'unknown' — callers must not actuate them. */
export function pinRole(
  board: BoardDescriptor,
  pin: number,
): 'reserved' | 'usable' | 'adc' | 'input-only' | 'unknown' {
  if (board.reservedPins.includes(pin)) return 'reserved';
  if (board.inputOnlyPins?.includes(pin)) return 'input-only';
  if (!board.gpioPins.includes(pin)) return 'unknown';
  if (board.adcPins?.includes(pin)) return 'adc';
  return 'usable';
}
