/**
 * Module definition: `pinout/linux-gpio`.
 *
 * Wires {@link LibgpiodBackend} into the Pinout module contract with real
 * JSON Schemas and safety metadata for every capability, plus module-level
 * policy rules that bound the two payload fields where a runaway value is a
 * physical hazard:
 *
 * - `gpio.write.pulseMs` is capped at {@link libgpiodMaxPulseMs}. A pulse
 *   longer than that is a held write with extra steps; the cap keeps timers
 *   bounded and makes cancellation cheap.
 * - `gpio.watch.debounceMs` is capped at {@link libgpiodMaxDebounceMs}.
 *
 * The rules are `custom` policy rules rather than `numericRange` because both
 * fields are optional: the core `numericRange` evaluator rejects a missing
 * field outright, while an omitted `pulseMs` or `debounceMs` is perfectly
 * valid here.
 *
 * There is deliberately NO simulated backend. A fake `pinout/linux-gpio`
 * device would report success for writes that never touched a line, which is
 * exactly the class of lie this package exists to avoid. `createBackend`
 * therefore throws when `simulated: true` is requested; register the device
 * with `{ simulated: false, backendOptions: { chip, lines } }` (see
 * INTEGRATION_NOTES.md). Construction on non-Linux hosts is still allowed so
 * device catalogs and plans can be described anywhere; every command
 * operation throws `PLATFORM_UNSUPPORTED` there instead.
 */
import {
  PolicyConstraintViolation,
  defineModule,
  type CapabilityDescriptor,
  type JsonSchema,
  type PolicyRule,
  type PinoutModuleDefinition,
} from '@pinout/core';
import { LibgpiodBackend, type LibgpiodBackendOptions } from './backend.js';

export const libgpiodModuleId = 'pinout/linux-gpio';

/** Largest allowed `gpio.write.pulseMs` value, in milliseconds. */
export const libgpiodMaxPulseMs = 60_000;

/** Largest allowed `gpio.watch.debounceMs` value, in milliseconds. */
export const libgpiodMaxDebounceMs = 60_000;

const emptyObject: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const lineSelectorProperties: Record<string, JsonSchema> = {
  line: {
    type: 'string',
    minLength: 1,
    description: 'Logical line name declared in the device configuration.',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    description: 'Line offset within the chip. Alternative to `line`.',
  },
};

const electricalNote =
  'PHYSICAL GPIO on /dev/gpiochip*. Drives real electrical levels; level shifting, load wiring, and hardware fail-safes are the operator\u2019s responsibility. Commanded and acknowledged evidence is not a measurement \u2014 only gpio.read / gpio.watch observations are (source gpio-readback). A host crash releases every line this process holds.';

const safeStateNote =
  'Best-effort de-energization of declared lines (configured safe levels, high-z release, hold left untouched). Not a certified safety function and not a substitute for hardware fail-safes.';

export const libgpiodCapabilities: CapabilityDescriptor[] = [
  {
    name: 'gpio.info',
    description:
      'List every GPIO chip on the host (gpiodetect) and the lines of one chip (gpioinfo). Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chip: {
          type: 'string',
          minLength: 1,
          description: 'Chip to describe; defaults to the configured chip. Accepts 0, gpiochip0, or /dev/gpiochip0.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['chip', 'chips', 'lines', 'unparsedLines'],
      additionalProperties: true,
      properties: {
        chip: { type: 'string' },
        chips: { type: 'array', items: { type: 'object', additionalProperties: true } },
        lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
        unparsedLines: { type: 'array', items: { type: 'string' } },
      },
    },
    safety: {
      physicalOutput: false,
      reversible: true,
      notes: 'Read-only listing; never requests or drives a line.',
    },
  },
  {
    name: 'gpio.read',
    description:
      'Read one configured line (gpioget --numeric) and return both the raw electrical level and the logical value after polarity translation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: lineSelectorProperties,
    },
    outputSchema: {
      type: 'object',
      required: ['line', 'offset', 'raw', 'value', 'polarity', 'at', 'source'],
      additionalProperties: true,
      properties: {
        line: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        raw: { type: 'integer', minimum: 0, maximum: 1 },
        value: { type: 'boolean' },
        polarity: { type: 'string', enum: ['active-high', 'active-low'] },
        at: { type: 'string' },
        source: { type: 'string' },
      },
    },
    safety: {
      physicalOutput: false,
      reversible: true,
      notes:
        'Read-only, but not side-effect free on the wire: gpioget requests the line with --as-is so direction is not forced, and reading a line held by another process fails loudly (EBUSY) rather than guessing.',
    },
  },
  {
    name: 'gpio.write',
    description:
      'Drive one configured output line. Holds the level until replaced or released (default), for a bounded pulse (`pulseMs`), or for a short set-and-release window (`hold: false`).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: {
        ...lineSelectorProperties,
        value: { type: 'boolean', description: 'Logical value: true = active.' },
        pulseMs: {
          type: 'number',
          minimum: 1,
          maximum: libgpiodMaxPulseMs,
          description:
            'Drive the active level for this long, then return to the configured safe level.',
        },
        hold: {
          type: 'boolean',
          description:
            'Default true. When false, set the line briefly and release it (level is not guaranteed afterwards).',
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['line', 'offset', 'value', 'raw', 'mode'],
      additionalProperties: true,
      properties: {
        line: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        value: { type: 'boolean' },
        raw: { type: 'integer', minimum: 0, maximum: 1 },
        mode: { type: 'string', enum: ['hold', 'once', 'pulse'] },
      },
    },
    safety: {
      physicalOutput: true,
      reversible: true,
      notes: electricalNote,
    },
  },
  {
    name: 'gpio.watch',
    description:
      'Watch configured lines for edges (gpiomon) and emit gpio.changed events with source gpio-readback. Replaces any previous watch.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...lineSelectorProperties,
        lines: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
          description: 'Logical line names to watch.',
        },
        debounceMs: {
          type: 'number',
          minimum: 0,
          maximum: libgpiodMaxDebounceMs,
          description: 'Software debounce per line; default 0 (report every edge).',
        },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['watching', 'chip', 'lines', 'debounceMs'],
      additionalProperties: true,
      properties: {
        watching: { type: 'boolean' },
        chip: { type: 'string' },
        lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
        debounceMs: { type: 'number' },
      },
    },
    safety: {
      physicalOutput: false,
      reversible: true,
      notes:
        'Observing only. gpiomon requests the lines as inputs; on a line already held by another process the monitor fails loudly instead of stealing or faking events.',
    },
  },
  {
    name: 'gpio.unwatch',
    description: 'Stop the active gpiomon watch, if any.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['watching', 'chip', 'lines', 'stopped'],
      additionalProperties: true,
      properties: {
        watching: { type: 'boolean' },
        chip: { type: 'string' },
        lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
        stopped: { type: 'boolean' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'gpio.safeState',
    description:
      'Apply configured safe levels: drive de-energized levels, release high-z lines, leave hold lines untouched. Optionally targets a single line.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: lineSelectorProperties,
    },
    outputSchema: {
      type: 'object',
      required: ['applied', 'chip', 'lines', 'note'],
      additionalProperties: true,
      properties: {
        applied: { type: 'boolean' },
        chip: { type: 'string' },
        lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
        note: { type: 'string' },
      },
    },
    safety: {
      physicalOutput: true,
      reversible: false,
      notes: safeStateNote,
    },
  },
];

/**
 * Module policy rules. Evaluated by the runtime before the backend is invoked
 * (and during dry runs), so an out-of-range payload never reaches a tool.
 */
export const libgpiodPolicies: PolicyRule[] = [
  {
    kind: 'custom',
    capability: 'gpio.write',
    evaluate: (context) => {
      const pulseMs = context.payload.pulseMs;
      if (pulseMs === undefined) return;
      if (typeof pulseMs !== 'number' || !Number.isFinite(pulseMs) || pulseMs <= 0) {
        throw new PolicyConstraintViolation(
          "'pulseMs' must be a positive finite number of milliseconds when provided.",
          { deviceId: context.deviceId, capability: context.capability, field: 'pulseMs' },
        );
      }
      if (pulseMs > libgpiodMaxPulseMs) {
        throw new PolicyConstraintViolation(
          `'pulseMs' must not exceed ${libgpiodMaxPulseMs}ms; longer activations must be modeled as held writes or an external interlock.`,
          {
            deviceId: context.deviceId,
            capability: context.capability,
            field: 'pulseMs',
            max: libgpiodMaxPulseMs,
            received: pulseMs,
          },
        );
      }
    },
  },
  {
    kind: 'custom',
    capability: 'gpio.write',
    evaluate: (context) => {
      const hold = context.payload.hold;
      if (hold !== undefined && typeof hold !== 'boolean') {
        throw new PolicyConstraintViolation("'hold' must be a boolean when provided.", {
          deviceId: context.deviceId,
          capability: context.capability,
          field: 'hold',
        });
      }
    },
  },
  {
    kind: 'custom',
    capability: 'gpio.watch',
    evaluate: (context) => {
      const debounceMs = context.payload.debounceMs;
      if (debounceMs === undefined) return;
      if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
        throw new PolicyConstraintViolation(
          "'debounceMs' must be a non-negative finite number of milliseconds when provided.",
          { deviceId: context.deviceId, capability: context.capability, field: 'debounceMs' },
        );
      }
      if (debounceMs > libgpiodMaxDebounceMs) {
        throw new PolicyConstraintViolation(
          `'debounceMs' must not exceed ${libgpiodMaxDebounceMs}ms.`,
          {
            deviceId: context.deviceId,
            capability: context.capability,
            field: 'debounceMs',
            max: libgpiodMaxDebounceMs,
            received: debounceMs,
          },
        );
      }
    },
  },
  {
    kind: 'custom',
    capability: 'gpio.read',
    evaluate: (context) => assertSingleLineSelector(context),
  },
  {
    kind: 'custom',
    capability: 'gpio.safeState',
    evaluate: (context) => assertSingleLineSelector(context),
  },
];

function assertSingleLineSelector(context: { payload: Record<string, unknown> }): void {
  if (context.payload.line !== undefined && context.payload.offset !== undefined) {
    throw new PolicyConstraintViolation("Provide either 'line' or 'offset', not both.");
  }
}

/**
 * Factory used by `createBackend`; exported so integrators can build a backend
 * with the same configuration rules as the module.
 */
export function createLibgpiodBackend(options: Record<string, unknown>): LibgpiodBackend {
  if (options.simulated === true) {
    throw new Error(
      'pinout/linux-gpio has no simulated backend: faking a GPIO level would misrepresent physical lines. Register with { simulated: false, backendOptions: { chip, lines } } instead.',
    );
  }
  const { simulated: _ignored, ...backendOptions } = options;
  return new LibgpiodBackend(backendOptions as LibgpiodBackendOptions);
}

export const libgpiodModule: PinoutModuleDefinition = defineModule({
  id: libgpiodModuleId,
  version: '0.1.0',
  device: {
    class: 'controller.linux-sbc-gpio',
    vendor: 'Pinout',
    model: 'Linux SBC GPIO (libgpiod v2)',
    description:
      'GPIO header of any Linux single-board computer through the libgpiod v2 command-line tools (gpiodetect, gpioinfo, gpioget, gpioset, gpiomon).',
  },
  capabilities: libgpiodCapabilities,
  policies: libgpiodPolicies,
  supportedTransportKinds: ['host'],
  createBackend: createLibgpiodBackend,
});
