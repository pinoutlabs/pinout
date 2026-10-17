/**
 * Non-actuating device discovery.
 *
 * `proposeLibgpiodDevices` answers one question: "what could this host's GPIO
 * subsystem be, described as Pinout devices?" It deliberately never asks a
 * second question ("what does a line currently read?") and never touches a
 * line: only `gpiodetect` and `gpioinfo` are invoked. `gpioget`, `gpioset`,
 * and `gpiomon` are absent by construction, and the unit tests assert that no
 * invoking tool name ever reaches the runner.
 *
 * The proposal is conservative by design:
 *
 * - Only lines with no consumer are offered in `suggestedConfig`, and only as
 *   INPUTS. A line whose direction is not currently claimed by anyone reads as
 *   an input without changing its direction (`gpioget --as-is`), which is the
 *   one use that cannot energize a load by itself.
 * - Lines already claimed by another consumer are reported for visibility but
 *   excluded from the configuration, because requesting them would fail
 *   (EBUSY) or, worse, silently reinterpret someone else's signal.
 * - Outputs are never proposed. Turning a pin into an output is a wiring
 *   decision that needs a human to declare the load and its safe level, so the
 *   proposal says so in `notes` instead of guessing.
 */
import { LibgpiodError } from './errors.js';
import { libgpiodModuleId } from './module.js';
import { normalizeChipName, type GpioLineInfo } from './parser.js';
import type { CommandRunner } from './runner.js';
import { GpioTools } from './tools.js';

export const libgpiodDeviceClass = 'controller.linux-sbc-gpio';

export interface LibgpiodDiscoveryOptions {
  /** Host platform override (test seam). Defaults to `process.platform`. */
  platform?: string;
  /** Per-invocation timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Restrict discovery to one chip (`0`, `gpiochip0`, `/dev/gpiochip0`). */
  chip?: string;
}

/** One pin as reported by `gpioinfo`, with no interpretation beyond the text. */
export interface ProposedLibgpiodLine {
  offset: number;
  /** Suggested logical name (device-tree name when present, sanitized). */
  name: string;
  /** Device-tree line name exactly as reported, or null. */
  lineName: string | null;
  direction: 'input' | 'output' | 'unknown';
  consumer: string | null;
  /** True when gpioinfo reported the active-low attribute on the line. */
  activeLow: boolean;
  bias: 'pull-up' | 'pull-down' | null;
  used: boolean;
}

export interface ProposedLibgpiodLineConfig {
  offset: number;
  name: string;
  direction: 'input';
  polarity: 'active-high' | 'active-low';
  safeLevel: 'high-z';
  bias: 'pull-up' | 'pull-down' | 'as-is';
}

export interface ProposedLibgpiodDevice {
  id: string;
  moduleId: string;
  deviceClass: string;
  label: string;
  chip: string;
  chipLabel: string | null;
  lineCount: number | null;
  /** Always true: the proposal is safe to register for read-only use as-is. */
  readOnly: true;
  /** Every line on the chip, including ones held by other consumers. */
  lines: ProposedLibgpiodLine[];
  /** Input-only configuration for the unclaimed lines. */
  suggestedConfig: {
    chip: string;
    lines: ProposedLibgpiodLineConfig[];
  };
  notes: string[];
}

/**
 * Propose one device per GPIO chip. Read-only: never requests, drives, or
 * monitors a line; never runs `gpioget`/`gpioset`/`gpiomon`.
 */
export async function proposeLibgpiodDevices(
  runner: CommandRunner,
  options: LibgpiodDiscoveryOptions = {},
): Promise<ProposedLibgpiodDevice[]> {
  const tools = new GpioTools({
    runner,
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  const chips = await tools.detectChips();
  const wanted = options.chip === undefined ? null : normalizeChipName(options.chip);
  if (wanted !== null && !chips.some((chip) => chip.name === wanted)) {
    throw new LibgpiodError(
      'GPIOCHIP_NOT_FOUND',
      `GPIO chip '${wanted}' is not present on this host.`,
      { chip: wanted, availableChips: chips.map((chip) => chip.name) },
    );
  }

  const proposals: ProposedLibgpiodDevice[] = [];
  for (const chip of chips) {
    if (wanted !== null && chip.name !== wanted) continue;
    const info = await tools.infoChip(chip.name);
    proposals.push(proposeDeviceForChip(chip.name, chip.label, chip.lineCount, info.lines, info.unparsed));
  }
  return proposals;
}

function proposeDeviceForChip(
  chip: string,
  chipLabel: string | null,
  lineCount: number | null,
  reportedLines: GpioLineInfo[],
  unparsedLines: string[],
): ProposedLibgpiodDevice {
  const usedNames = new Set<string>();
  const carrierLines: ProposedLibgpiodLine[] = [];
  const suggestedLines: ProposedLibgpiodLineConfig[] = [];
  let excludedUsed = 0;

  for (const line of [...reportedLines].sort((a, b) => a.offset - b.offset)) {
    const name = uniqueName(sanitizeName(line.name, line.offset), line.offset, usedNames);
    const proposal: ProposedLibgpiodLine = {
      offset: line.offset,
      name,
      lineName: line.name,
      direction: line.direction,
      consumer: line.consumer,
      activeLow: line.activeLow,
      bias: line.bias,
      used: line.used,
    };
    carrierLines.push(proposal);

    // Inputs only, and only lines nobody else holds. A DT-configured output
    // is respected as an output even when no consumer is listed.
    if (line.consumer !== null || line.used || line.direction === 'output') {
      excludedUsed += 1;
      continue;
    }
    suggestedLines.push({
      offset: line.offset,
      name,
      direction: 'input',
      polarity: line.activeLow ? 'active-low' : 'active-high',
      safeLevel: 'high-z',
      bias: line.bias ?? 'as-is',
    });
  }

  const notes = [
    'Discovery is non-actuating: only gpiodetect and gpioinfo were invoked; no line was requested, driven, or monitored.',
    'suggestedConfig declares input lines only. To use a line as an output, add it manually with an explicit safeLevel and polarity after reviewing the wiring.',
  ];
  if (excludedUsed > 0) {
    notes.push(
      `${excludedUsed} line(s) are held by another consumer or configured as outputs and were excluded from suggestedConfig.`,
    );
  }
  if (unparsedLines.length > 0) {
    notes.push(
      `${unparsedLines.length} gpioinfo line(s) were not recognized and are listed only in raw tool output, never guessed into the proposal.`,
    );
  }

  return {
    id: `linux-gpio-${chip}`,
    moduleId: libgpiodModuleId,
    deviceClass: libgpiodDeviceClass,
    label: chipLabel ? `Linux GPIO ${chip} (${chipLabel})` : `Linux GPIO ${chip}`,
    chip,
    chipLabel,
    lineCount,
    readOnly: true,
    lines: carrierLines,
    suggestedConfig: { chip, lines: suggestedLines },
    notes,
  };
}

function sanitizeName(lineName: string | null, offset: number): string {
  if (lineName === null) return `line${offset}`;
  const sanitized = lineName.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
  if (sanitized.length === 0 || sanitized === '_') return `line${offset}`;
  return sanitized;
}

function uniqueName(base: string, offset: number, used: Set<string>): string {
  let candidate = base;
  if (used.has(candidate)) candidate = `${base}_${offset}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${offset}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}
