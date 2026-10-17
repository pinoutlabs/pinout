/**
 * Pure parsers for libgpiod v2 command-line tool output.
 *
 * Every function here is synchronous, side-effect free, and exported so the
 * adapter's assumptions about real tool output are unit-testable with text
 * fixtures — no Linux host and no libgpiod installation required.
 *
 * Verified against the libgpiod v2.2/v2.3 documentation and README examples:
 *
 * - `gpiodetect`:   `gpiochip0 [pinctrl-rp1] (54 lines)` — one chip per line.
 * - `gpioinfo`:     `gpiochip1 - 8 lines:` header, then lines such as
 *                   `line   2: "PWR_LED_OFF"    output active-low consumer="led1"`.
 *                   Older/label-style output (still accepted) prints the
 *                   consumer as a second quoted field and flags in brackets:
 *                   `line  17: "GPIO17" "led" output active-high [used]`.
 * - `gpioget`:      `--numeric` prints values only, e.g. `1 0` for two lines.
 * - `gpiomon`:      our `--format=%o %e %S` prints `<offset> <edge> <seconds>`,
 *                   e.g. `17 1 10002.907638045`. The v2 default format
 *                   `<seconds> <edge word> "<name>"` is also accepted.
 *
 * Unrecognized GPIOMON lines (banners, notices, future formats) are reported
 * as `null` and counted by the watcher rather than guessed at.
 */
import { parseFailureError } from './errors.js';

export interface GpioChipInfo {
  /** Canonical chip name as printed by the tool, e.g. `gpiochip0`. */
  name: string;
  /** Kernel/device-tree label, or null when the tool reported none. */
  label: string | null;
  /** Number of lines, or null when the tool did not report it. */
  lineCount: number | null;
  raw: string;
}

export interface GpioLineInfo {
  /** Chip the line belongs to, when the output form carried it. */
  chip: string | null;
  offset: number;
  /** Device-tree line name, or null for unnamed lines. */
  name: string | null;
  /** Current consumer (the process/DT node holding the line), or null. */
  consumer: string | null;
  direction: 'input' | 'output' | 'unknown';
  /** True when the tool reported the `active-low` line attribute. */
  activeLow: boolean;
  bias: 'pull-up' | 'pull-down' | null;
  /** True when the line is flagged used or has a consumer. */
  used: boolean;
  raw: string;
}

export interface GpioinfoResult {
  chips: GpioChipInfo[];
  lines: GpioLineInfo[];
  /** Non-blank lines the parser did not recognize; surfaced, never dropped silently. */
  unparsed: string[];
}

export interface GpioMonitorEvent {
  /** Line offset, or null when the output form only carried a line name. */
  offset: number | null;
  /** Line name, or null when the output form only carried an offset. */
  name: string | null;
  edge: 'rising' | 'falling';
  /**
   * Event timestamp as printed by the tool. libgpiod defaults to
   * CLOCK_MONOTONIC, so this is device-monotonic seconds with a nanosecond
   * fraction — NOT wall-clock time. Callers must pair it with their own
   * receipt time when they need `at`-style wall-clock ordering.
   */
  deviceTimestampSeconds: number | null;
  raw: string;
}

const CHIP_DETECT_PATTERN = /^(gpiochip\d+)\s+\[([^\]]*)\]\s+\((\d+)\s+lines?\)\s*$/;
const CHIP_INFO_HEADER_PATTERN = /^(gpiochip\d+)\s*-\s*(\d+)\s+lines:/;
const LINE_KEYWORD_PATTERN = /^line$/i;
const CHIP_TOKEN_PATTERN = /^gpiochip\d+$/;
const OFFSET_TOKEN_PATTERN = /^(\d+):?$/;

interface ParsedToken {
  value: string;
  quoted: boolean;
  bracketed: boolean;
}

/**
 * `gpiodetect` prints exactly one chip per line. A non-blank line that does
 * not match the documented shape is treated as a parse failure rather than
 * silently dropping a chip from the device map.
 */
export function parseGpiodetectOutput(stdout: string): GpioChipInfo[] {
  const chips: GpioChipInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = CHIP_DETECT_PATTERN.exec(line);
    if (!match) {
      throw parseFailureError(
        'gpiodetect',
        `unrecognized line ${JSON.stringify(line)} (expected 'gpiochipN [label] (N lines)')`,
        line,
      );
    }
    chips.push({
      name: match[1]!,
      label: match[2]!.length > 0 ? match[2]! : null,
      lineCount: Number.parseInt(match[3]!, 10),
      raw: line,
    });
  }
  return chips;
}

/**
 * Parse a single `gpioinfo` line entry. Returns null for blank lines, chip
 * headers, and anything that is not a line entry.
 *
 * Accepted entry forms:
 *
 *     line  17:	"GPIO17"	"led"	output	active-high	[used]
 *     line   2: "PWR_LED_OFF" output active-low consumer="led1"
 *     line   7: "SD_OC_N" input
 *     line   0: unnamed input
 *     gpiochip0 42 "STATUS_LED_G_CLK" output consumer="led0"
 *
 * Tokens are classified, not positionally destructured, so additional future
 * tokens (open-drain, drive modes, ...) are ignored while the original text
 * stays available in `raw`.
 */
export function parseGpioinfoLine(rawLine: string): GpioLineInfo | null {
  const line = rawLine.trim();
  if (line.length === 0) return null;
  if (CHIP_INFO_HEADER_PATTERN.test(line)) return null;

  const tokens = tokenize(line);
  const first = tokens[0];
  if (!first || first.quoted || first.bracketed) return null;

  let chip: string | null = null;
  let offset: number;
  let index: number;
  if (LINE_KEYWORD_PATTERN.test(first.value)) {
    const second = tokens[1];
    const offsetMatch = second ? OFFSET_TOKEN_PATTERN.exec(second.value) : null;
    if (!second || second.quoted || second.bracketed || !offsetMatch) return null;
    offset = Number.parseInt(offsetMatch[1]!, 10);
    index = 2;
  } else if (CHIP_TOKEN_PATTERN.test(first.value)) {
    const second = tokens[1];
    const offsetMatch = second ? /^(\d+)$/.exec(second.value) : null;
    if (!second || second.quoted || second.bracketed || !offsetMatch) return null;
    chip = first.value;
    offset = Number.parseInt(offsetMatch[1]!, 10);
    index = 2;
  } else {
    return null;
  }

  let name: string | null = null;
  let nameSeen = false;
  let consumer: string | null = null;
  let direction: 'input' | 'output' | 'unknown' = 'unknown';
  let activeLow = false;
  let bias: 'pull-up' | 'pull-down' | null = null;
  let usedFlag = false;

  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.quoted) {
      if (!nameSeen) {
        nameSeen = true;
        name = isUnnamed(token.value) ? null : token.value;
      } else if (consumer === null && !isUnnamed(token.value)) {
        consumer = token.value;
      }
      continue;
    }
    if (token.bracketed) {
      for (const entry of token.value.split(',')) {
        const flag = entry.trim();
        if (flag.toLowerCase() === 'used') usedFlag = true;
        if (flag.toLowerCase() === 'active-low') activeLow = true;
        const flagConsumer = /^consumer="?(.*?)"?$/.exec(flag);
        if (flagConsumer) {
          const value = flagConsumer[1]!;
          consumer = isUnnamed(value) ? null : value;
        }
        if (/^(bias=)?pull-up$/i.test(flag)) bias = 'pull-up';
        if (/^(bias=)?pull-down$/i.test(flag)) bias = 'pull-down';
      }
      continue;
    }

    const value = token.value;
    const lower = value.toLowerCase();
    if (lower.startsWith('input')) {
      direction = 'input';
      continue;
    }
    if (lower.startsWith('output')) {
      direction = 'output';
      continue;
    }
    if (lower === 'active-low') {
      activeLow = true;
      continue;
    }
    if (lower === 'active-high') {
      activeLow = false;
      continue;
    }
    if (lower === 'unnamed') {
      nameSeen = true;
      continue;
    }
    const consumerMatch = /^consumer="?(.*?)"?$/.exec(value);
    if (consumerMatch) {
      const resolved = consumerMatch[1]!;
      consumer = isUnnamed(resolved) ? null : resolved;
      continue;
    }
    if (lower === 'pull-up' || lower === 'pullup' || lower === 'bias=pull-up') {
      bias = 'pull-up';
      continue;
    }
    if (lower === 'pull-down' || lower === 'pulldown' || lower === 'bias=pull-down') {
      bias = 'pull-down';
      continue;
    }
    // Unknown tokens are ignored by design: newer libgpiod releases add
    // attributes, and refusing to parse them would hide every other line.
  }

  return {
    chip,
    offset,
    name,
    consumer,
    direction,
    activeLow,
    bias,
    used: usedFlag || consumer !== null,
    raw: line,
  };
}

/** Parse full `gpioinfo` output, tracking the enclosing chip header. */
export function parseGpioinfoOutput(stdout: string): GpioinfoResult {
  const chips: GpioChipInfo[] = [];
  const lines: GpioLineInfo[] = [];
  const unparsed: string[] = [];
  let currentChip: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const header = CHIP_INFO_HEADER_PATTERN.exec(line);
    if (header) {
      currentChip = header[1]!;
      chips.push({
        name: currentChip,
        label: null,
        lineCount: Number.parseInt(header[2]!, 10),
        raw: line,
      });
      continue;
    }

    const parsed = parseGpioinfoLine(line);
    if (!parsed) {
      unparsed.push(line);
      continue;
    }
    lines.push({ ...parsed, chip: parsed.chip ?? currentChip });
  }

  return { chips, lines, unparsed };
}

/**
 * Parse `gpioget --numeric` output: whitespace-separated `0`/`1` tokens, e.g.
 * `1 0`. The `offset=value` shape is also accepted defensively; values are
 * returned in printed order, which matches requested order.
 */
export function parseGpiogetValues(stdout: string): number[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw parseFailureError('gpioget', 'no values were printed', stdout);
  }
  return trimmed.split(/\s+/).map((token) => {
    if (/^[01]$/.test(token)) return Number.parseInt(token, 10);
    const pair = /^\d+=([01])$/.exec(token);
    if (pair) return Number.parseInt(pair[1]!, 10);
    throw parseFailureError('gpioget', `unrecognized value token ${JSON.stringify(token)}`, stdout);
  });
}

/**
 * Parse a single `gpiomon` output line.
 *
 * Form 1 (what this adapter requests: `--format=%o %e %S`):
 *     `17 1 10002.907638045` — offset, numeric edge (1 rising / 2 falling,
 *     per the documented `%e` specifier), timestamp seconds.
 *
 * Form 2 (libgpiod v2 default output):
 *     `10002.907638045	rising	"GPIO22"` — timestamp, edge word, line name.
 *
 * Anything else returns null so the watcher can count it instead of inventing
 * an event.
 */
export function parseGpiomonLine(rawLine: string): GpioMonitorEvent | null {
  const line = rawLine.trim();
  if (line.length === 0) return null;
  const tokens = line.split(/\s+/);

  if (tokens.length === 3) {
    const [offsetToken, edgeToken, timeToken] = tokens as [string, string, string];
    const offsetMatch = /^(\d+)$/.exec(offsetToken);
    const edge: 'rising' | 'falling' | null =
      edgeToken === '1' ? 'rising' : edgeToken === '2' ? 'falling' : null;
    const seconds = Number(timeToken);
    if (offsetMatch && edge !== null && Number.isFinite(seconds)) {
      return {
        offset: Number.parseInt(offsetMatch[1]!, 10),
        name: null,
        edge,
        deviceTimestampSeconds: seconds,
        raw: line,
      };
    }
  }

  if (tokens.length >= 3) {
    const [timeToken, edgeToken, ...rest] = tokens as [string, string, ...string[]];
    const seconds = Number(timeToken);
    const edge = edgeWord(edgeToken);
    if (Number.isFinite(seconds) && edge !== null) {
      return {
        offset: null,
        name: cleanLineName(rest.join(' ')),
        edge,
        deviceTimestampSeconds: seconds,
        raw: line,
      };
    }
  }

  return null;
}

/**
 * Canonicalize the several chip spellings libgpiod accepts (`0`,
 * `gpiochip0`, `/dev/gpiochip0`) into `gpiochipN` so configuration, discovery,
 * and tool output can be compared reliably.
 */
export function normalizeChipName(chip: string): string {
  const trimmed = chip.trim();
  if (/^\d+$/.test(trimmed)) return `gpiochip${trimmed}`;
  const devicePath = /^\/dev\/(gpiochip\d+)$/.exec(trimmed);
  if (devicePath) return devicePath[1]!;
  return trimmed;
}

function tokenize(line: string): ParsedToken[] {
  const pattern = /"([^"]*)"|\[([^\]]*)\]|(\S+)/g;
  const tokens: ParsedToken[] = [];
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    if (match[1] !== undefined) {
      tokens.push({ value: match[1], quoted: true, bracketed: false });
    } else if (match[2] !== undefined) {
      tokens.push({ value: match[2], quoted: false, bracketed: true });
    } else {
      tokens.push({ value: match[3] ?? '', quoted: false, bracketed: false });
    }
  }
  return tokens;
}

function isUnnamed(value: string): boolean {
  return value.trim().toLowerCase() === 'unnamed';
}

function edgeWord(token: string): 'rising' | 'falling' | null {
  const lower = token.trim().toLowerCase();
  if (lower === 'rising' || lower === 'rising_edge' || lower === 'rising edge') return 'rising';
  if (lower === 'falling' || lower === 'falling_edge' || lower === 'falling edge') return 'falling';
  return null;
}

function cleanLineName(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  const unquoted = trimmed.replace(/^"|"$/g, '');
  return isUnnamed(unquoted) ? null : unquoted;
}
