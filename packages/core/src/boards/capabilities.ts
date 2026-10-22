import type { CapabilityDescriptor, DeviceInfo } from '../types.js';

/** Advertise only argument forms implemented by the small AVR bridge. */
export function boardCapabilities(
  info: DeviceInfo,
  capabilities: CapabilityDescriptor[],
): CapabilityDescriptor[] {
  if (info.boardId !== 'arduino-uno') return capabilities;
  return capabilities.map((capability) => {
    const result = structuredClone(capability);
    const props = result.inputSchema.properties;
    if (!props) return result;
    if (result.name === 'gpio.write' || result.name === 'watchdog.kick') delete props.validityMs;
    if (result.name === 'gpio.mode') {
      props.mode = { type: 'string', enum: ['input', 'output', 'pullup'] };
      delete props.safeLevel;
      delete props.polarity;
    }
    if (result.name === 'gpio.configSafeState')
      props.safeLevel = { type: 'string', enum: ['low', 'high', 'high-z'] };
    if (result.name === 'sys.arm')
      props.timeoutMs = { type: 'integer', minimum: 250, maximum: 10000 };
    if (result.name === 'gpio.analogRead')
      result.outputSchema.properties!.value = { type: 'integer', minimum: 0, maximum: 1023 };
    return result;
  });
}
