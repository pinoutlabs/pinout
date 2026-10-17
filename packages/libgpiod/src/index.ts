/**
 * `@pinout/libgpiod` — public surface.
 *
 * A zero-native-dependency Linux SBC GPIO backend for Pinout built entirely on
 * the libgpiod v2 command-line tools. Status: IMPLEMENTED, exercised against a
 * scripted command runner in unit tests; never verified against real
 * hardware from this repository (see README.md).
 *
 * Layering, from the outside in:
 *
 * - {@link libgpiodModule} — the `pinout/linux-gpio` module definition.
 * - {@link LibgpiodBackend} — capabilities `gpio.info`, `gpio.read`,
 *   `gpio.write`, `gpio.watch`, `gpio.unwatch`, `gpio.safeState`.
 * - {@link GpioTools} — typed wrappers around gpiodetect/gpioinfo/gpioget/
 *   gpioset/gpiomon.
 * - {@link CommandRunner} — the execution seam; {@link NodeCommandRunner} is
 *   the production implementation, tests substitute a scripted fake.
 */
export {
  LibgpiodError,
  classifyToolExit,
  commandTimeoutError,
  parseFailureError,
  platformUnsupportedError,
  toolFailureError,
  toolMissingError,
} from './errors.js';
export type { LibgpiodErrorCode, ToolFailureDetails } from './errors.js';

export { assertLinux, isLinux } from './platform.js';

export { NodeCommandRunner } from './runner.js';
export type {
  CommandExitInfo,
  CommandRunOptions,
  CommandRunResult,
  CommandRunner,
  CommandSpawnError,
  CommandSpawnOptions,
  CommandStream,
} from './runner.js';

export {
  normalizeChipName,
  parseGpiodetectOutput,
  parseGpioinfoLine,
  parseGpioinfoOutput,
  parseGpiogetValues,
  parseGpiomonLine,
} from './parser.js';
export type {
  GpioChipInfo,
  GpioLineInfo,
  GpioMonitorEvent,
  GpioinfoResult,
} from './parser.js';

export { GpioTools, libgpiodConsumerName, libgpiodToolNames } from './tools.js';
export type {
  GpioGetOptions,
  GpioLineRawValue,
  GpioSetOptions,
  GpioToolsOptions,
  GpioWatch,
  GpioWatchEvent,
  GpioWatchOptions,
  GpioWatchStats,
  HeldLines,
  HoldLinesOptions,
  LibgpiodBiasSetting,
} from './tools.js';

export {
  LibgpiodBackend,
  libgpiodSafeStateNote,
  logicalToRaw,
  rawToLogical,
  validateLibgpiodConfig,
} from './backend.js';
export type {
  LibgpiodBackendOptions,
  LibgpiodBias,
  LibgpiodDirection,
  LibgpiodLineConfig,
  LibgpiodPolarity,
  LibgpiodSafeLevel,
  SafeLevelAction,
  SafeLevelOutcome,
  ValidatedLibgpiodConfig,
  ValidatedLibgpiodLine,
} from './backend.js';

export {
  createLibgpiodBackend,
  libgpiodCapabilities,
  libgpiodMaxDebounceMs,
  libgpiodMaxPulseMs,
  libgpiodModule,
  libgpiodModuleId,
  libgpiodPolicies,
} from './module.js';

export { libgpiodDeviceClass, proposeLibgpiodDevices } from './discovery.js';
export type {
  LibgpiodDiscoveryOptions,
  ProposedLibgpiodDevice,
  ProposedLibgpiodLine,
  ProposedLibgpiodLineConfig,
} from './discovery.js';
