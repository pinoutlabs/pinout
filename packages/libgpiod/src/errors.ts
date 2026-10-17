/**
 * Structured errors for the libgpiod adapter.
 *
 * Codes are stable and machine-checkable; messages never carry the only copy
 * of the diagnostic information (details do). `LibgpiodError` extends core
 * {@link DeviceError} so runtime, journal, and conformance tooling treat these
 * errors exactly like every other device backend in Pinout.
 *
 * Tool stderr is version-dependent prose. It is never parsed for control flow
 * beyond a best-effort classification into `GPIOCHIP_NOT_FOUND` /
 * `GPIO_LINE_NOT_FOUND`, and the raw text always travels in `details.stderr`.
 */
import { DeviceError } from '@pinout/core';

export type LibgpiodErrorCode =
  | 'VALIDATION_ERROR'
  | 'PLATFORM_UNSUPPORTED'
  | 'GPIOCHIP_NOT_FOUND'
  | 'GPIO_LINE_NOT_FOUND'
  | 'GPIO_TOOL_MISSING'
  | 'GPIO_OPERATION_FAILED'
  | 'COMMAND_TIMEOUT'
  | 'UNSUPPORTED_CONFIGURATION';

export class LibgpiodError extends DeviceError {
  constructor(code: LibgpiodErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

export interface ToolFailureDetails {
  tool: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Markers observed in libgpiod v2 tool stderr when a line cannot be resolved.
 *
 * Assumption (documented, unverifiable here): libgpiod reports missing lines
 * with one of these phrases. Anything else falls back to
 * `GPIO_OPERATION_FAILED`, which still carries the raw stderr.
 */
const LINE_ERROR_MARKERS: RegExp[] = [
  /\bcannot find line\b/i,
  /\bunable to find line\b/i,
  /\bcould not find line\b/i,
  /\bline not found\b/i,
  /\bno such line\b/i,
  /\bunknown line\b/i,
];

/**
 * Markers for an unresolvable chip. "No such file or directory" appears when
 * the tool fails to open /dev/gpiochipN; the tool-missing case (missing
 * executable) is detected through the spawn error code instead, never through
 * this prose.
 */
const CHIP_ERROR_MARKERS: RegExp[] = [
  /\bunable to find (?:the )?(?:gpio)?chip\b/i,
  /\bcannot find (?:the )?(?:gpio)?chip\b/i,
  /\bcould not (?:find|open|access) (?:the )?(?:gpio)?chip\b/i,
  /\bgpiochip\d*\b.*\bnot found\b/i,
  /\bunknown chip\b/i,
  /\bchip not found\b/i,
  /\bno such file or directory\b/i,
];

/** Classify a nonzero tool exit into a stable error code. Best effort only. */
export function classifyToolExit(stderr: string): LibgpiodErrorCode {
  for (const marker of LINE_ERROR_MARKERS) {
    if (marker.test(stderr)) return 'GPIO_LINE_NOT_FOUND';
  }
  for (const marker of CHIP_ERROR_MARKERS) {
    if (marker.test(stderr)) return 'GPIOCHIP_NOT_FOUND';
  }
  return 'GPIO_OPERATION_FAILED';
}

export function platformUnsupportedError(operation: string, platform: string): LibgpiodError {
  return new LibgpiodError(
    'PLATFORM_UNSUPPORTED',
    `${operation} requires Linux GPIO character devices (/dev/gpiochip*); host platform is '${platform}'.`,
    { platform, operation },
  );
}

export function toolMissingError(
  tool: string,
  spawnError?: { code: string; message: string },
): LibgpiodError {
  return new LibgpiodError(
    'GPIO_TOOL_MISSING',
    `'${tool}' could not be executed${spawnError ? ` (${spawnError.code})` : ''}. Install the libgpiod v2 tools (gpiod) and ensure '${tool}' is on PATH.`,
    {
      tool,
      ...(spawnError ? { spawnErrorCode: spawnError.code, spawnErrorMessage: spawnError.message } : {}),
      installHint: 'Debian/Ubuntu: apt install gpiod (libgpiod v2).',
    },
  );
}

export function commandTimeoutError(
  tool: string,
  args: string[],
  timeoutMs: number,
): LibgpiodError {
  return new LibgpiodError(
    'COMMAND_TIMEOUT',
    `'${tool}' did not finish within ${timeoutMs}ms and was killed.`,
    { tool, args, timeoutMs },
  );
}

export function toolFailureError(details: ToolFailureDetails): LibgpiodError {
  const code = classifyToolExit(details.stderr);
  const summary = firstMeaningfulLine(details.stderr);
  return new LibgpiodError(
    code,
    `'${details.tool}' exited with ${details.exitCode === null ? 'a signal' : `code ${details.exitCode}`}${summary ? `: ${summary}` : '.'}`,
    { phase: 'tool', ...details },
  );
}

export function parseFailureError(tool: string, message: string, stdout: string): LibgpiodError {
  return new LibgpiodError('GPIO_OPERATION_FAILED', `${tool} output could not be parsed: ${message}`, {
    phase: 'parse',
    tool,
    stdout,
  });
}

function firstMeaningfulLine(stderr: string): string {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}
