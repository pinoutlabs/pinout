/**
 * Fair tool budgets for both arms.
 *
 * Both arms get a compact, task-relevant tool set of similar size. The Pinout
 * arm is NOT given the entire capability catalog (that would inflate discovery
 * and dilute the comparison). The raw arm is NOT given Pinout shortcuts.
 */

/** Capability actions exposed to the Pinout arm (task-relevant subset). */
export const pinoutTaskCapabilityNames = [
  'sys.arm',
  'sys.disarm',
  'watchdog.configure',
  'watchdog.kick',
  'gpio.write',
  'gpio.read',
  'gpio.servo',
  'gpio.analogRead',
] as const;

export const pinoutDiscoveryToolNames = [
  'pinout__list_devices',
  'pinout__describe_device',
  'pinout__read_state',
] as const;

export const rawSimulatedToolNames = [
  'list_workspace',
  'read_file',
  'write_file',
  'compile_flash',
  'serial_request',
  'read_flash_log',
] as const;

export const rawRealToolNames = [
  'list_workspace',
  'read_file',
  'write_file',
  'list_serial_ports',
  'compile_firmware',
  'flash_firmware',
  'serial_request',
] as const;

export function describeArmBudgets(): string {
  return [
    'Arm A (raw) tools: workspace files, datasheet, compile/flash via real toolchains',
    '(or SIMULATED compile_flash), serial_request, list_serial_ports on real boards.',
    'Arm B (Pinout) tools: list/describe/read_state plus task-relevant capabilities',
    `(${pinoutTaskCapabilityNames.join(', ')}). Full capability catalogs are intentionally`,
    'not dumped into the Pinout arm tool list for this benchmark.',
  ].join(' ');
}
