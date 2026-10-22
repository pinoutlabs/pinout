import { boardCapabilities } from './boards/capabilities.js';
import { boardForInfo, validateBoardAction } from './boards/builtin.js';
import { UnsupportedCapabilityError, ValidationError } from './errors.js';
import { describeCapability, describeCapabilities, toAgentTools } from './capabilities.js';
import { validateInputSchema, validateOutputSchema } from './schema.js';
import {
  assertBusBytes,
  assertBusLength,
  assertEsp32AnalogPin,
  assertEsp32BusPin,
  assertEsp32ModePin,
  assertEsp32PwmPin,
  assertEsp32ReadPin,
  assertEsp32WritePin,
  assertGpioMode,
  assertGpioPin,
  assertGpioValue,
  assertI2cAddress,
  assertMotorSpeed,
  assertNonNegativeInt,
  assertPolarity,
  assertSafeLevel,
  assertServoAngle,
  resolveEsp32BoardPin,
  type GpioPolarity,
  type GpioSafeLevel,
} from './drivers/esp32/pins.js';
import type { Session } from './session.js';
import type { AgentTool, CapabilityDescriptor, DeviceEventHandler, DeviceInfo } from './types.js';

export class Device {
  readonly capabilities: CapabilityDescriptor[];
  readonly gpio: Gpio;
  private readonly handlers = new Map<string, Set<DeviceEventHandler>>();
  private readonly onceHandlers = new Map<string, Set<DeviceEventHandler>>();
  private removeEventListener: (() => void) | undefined;

  constructor(
    readonly info: DeviceInfo,
    private readonly session: Session,
  ) {
    this.capabilities = boardCapabilities(info, describeCapabilities(info.capabilities));
    this.gpio = new Gpio(this);
    this.removeEventListener = session.addEventListener((event) => {
      if (event.event === 'ready') {
        return;
      }
      this.emit(event.event, event.payload);
    });
  }

  supports(action: string): boolean {
    return this.info.capabilities.includes(action);
  }

  hasFeature(feature: string): boolean {
    return this.info.features?.includes(feature) ?? false;
  }

  async arm(options: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    return this.invoke('sys.arm', options);
  }

  async disarm(): Promise<Record<string, unknown>> {
    return this.invoke('sys.disarm', {});
  }

  async configureWatchdog(timeoutMs: number): Promise<Record<string, unknown>> {
    return this.invoke('watchdog.configure', { timeoutMs });
  }

  async kickWatchdog(validityMs?: number): Promise<Record<string, unknown>> {
    return this.invoke('watchdog.kick', validityMs !== undefined ? { validityMs } : {});
  }

  async configSafeState(
    pin: number,
    safeLevel: GpioSafeLevel = 'low',
    polarity: GpioPolarity = 'active-high',
  ): Promise<Record<string, unknown>> {
    return this.invoke('gpio.configSafeState', { pin, safeLevel, polarity });
  }

  on(event: string, handler: DeviceEventHandler): void {
    this.addHandler(this.handlers, event, handler);
  }

  off(event: string, handler: DeviceEventHandler): void {
    this.handlers.get(event)?.delete(handler);
    this.onceHandlers.get(event)?.delete(handler);
  }

  once(event: string, handler: DeviceEventHandler): void {
    this.addHandler(this.onceHandlers, event, handler);
  }

  async invoke(
    action: string,
    payload: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.supports(action)) {
      throw new UnsupportedCapabilityError(action);
    }
    const descriptor =
      this.capabilities.find((c) => c.name === action) ?? describeCapability(action);
    const checked = validateInputSchema(descriptor.inputSchema, payload);
    const board = boardForInfo(this.info);
    if (board) validateBoardAction(board, action, checked);
    if (board?.family === 'esp32-c3' && action === 'gpio.pwm' && checked.channel === undefined)
      checked.channel = Number(checked.pin) % 6;
    const normalized = validateAction(
      this.info.firmware,
      action,
      checked,
      Boolean(this.info.boardId),
    );
    const result = await this.session.request(action, normalized, options);
    return validateOutputSchema(descriptor.outputSchema, result);
  }

  toAgentTools(): AgentTool[] {
    return toAgentTools(this.capabilities);
  }

  async close(): Promise<void> {
    this.removeEventListener?.();
    this.removeEventListener = undefined;
    this.handlers.clear();
    this.onceHandlers.clear();
    await this.session.close();
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    this.dispatch(this.handlers.get(event), payload);
    const once = this.onceHandlers.get(event);
    if (once) {
      this.dispatch(once, payload);
      this.onceHandlers.delete(event);
    }
  }

  private dispatch(
    handlers: Set<DeviceEventHandler> | undefined,
    payload: Record<string, unknown>,
  ): void {
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      handler(payload);
    }
  }

  private addHandler(
    store: Map<string, Set<DeviceEventHandler>>,
    event: string,
    handler: DeviceEventHandler,
  ): void {
    const handlers = store.get(event);
    if (handlers) {
      handlers.add(handler);
      return;
    }
    store.set(event, new Set([handler]));
  }
}

class Gpio {
  constructor(private readonly device: Device) {}

  async mode(pin: number, mode: 'input' | 'output' | 'pullup' | 'pulldown'): Promise<void> {
    await this.device.invoke('gpio.mode', { pin, mode });
  }

  async write(pin: number, value: boolean): Promise<void> {
    await this.device.invoke('gpio.write', { pin, value });
  }

  async batchWrite(writes: Array<{ pin: number; value: boolean }>): Promise<void> {
    await this.device.invoke('gpio.batchWrite', { writes });
  }

  async stopAll(): Promise<number[]> {
    const result = await this.device.invoke('gpio.stopAll', {});
    if (
      !Array.isArray(result.stoppedPins) ||
      !result.stoppedPins.every((pin) => typeof pin === 'number')
    ) {
      throw new ValidationError('gpio.stopAll returned invalid stoppedPins.');
    }
    return result.stoppedPins as number[];
  }

  async read(pin: number): Promise<boolean> {
    const result = await this.device.invoke('gpio.read', { pin });
    if (typeof result.value !== 'boolean') {
      throw new ValidationError('gpio.read returned a non-boolean value.');
    }
    return result.value;
  }

  async toggle(pin: number): Promise<boolean> {
    const result = await this.device.invoke('gpio.toggle', { pin });
    if (typeof result.value !== 'boolean') {
      throw new ValidationError('gpio.toggle returned a non-boolean value.');
    }
    return result.value;
  }

  async pulse(pin: number, durationMs: number, value = true): Promise<void> {
    await this.device.invoke('gpio.pulse', { pin, durationMs, value });
  }

  async pwm(channel: number, pin: number, duty: number, frequency: number): Promise<void> {
    await this.device.invoke('gpio.pwm', { channel, pin, duty, frequency });
  }

  async analogRead(pin: number): Promise<number> {
    const result = await this.device.invoke('gpio.analogRead', { pin });
    if (typeof result.value !== 'number') {
      throw new ValidationError('gpio.analogRead returned a non-numeric value.');
    }
    return result.value;
  }

  async watch(pin: number): Promise<void> {
    await this.device.invoke('gpio.watch', { pin });
  }

  async unwatch(pin: number): Promise<void> {
    await this.device.invoke('gpio.unwatch', { pin });
  }

  async configSafeState(
    pin: number,
    safeLevel: GpioSafeLevel = 'low',
    polarity: GpioPolarity = 'active-high',
  ): Promise<void> {
    await this.device.invoke('gpio.configSafeState', { pin, safeLevel, polarity });
  }

  resolveBoardPin(name: string): number {
    if (this.device.info.firmware === 'esp32-bridge') {
      return resolveEsp32BoardPin(name);
    }
    throw new ValidationError(
      `Board pin names are not defined for '${this.device.info.firmware}'.`,
    );
  }
}

function validateAction(
  firmware: string,
  action: string,
  payload: Record<string, unknown>,
  boardAware = false,
): Record<string, unknown> {
  if (action === 'sys.hello' || action === 'sys.ping' || action === 'sys.info') {
    assertEmptyPayload(payload, action);
    return {};
  }

  if (action === 'sys.arm') {
    if (payload.timeoutMs !== undefined) {
      return { timeoutMs: assertNonNegativeInt(payload.timeoutMs, 'timeoutMs') };
    }
    return {};
  }

  if (action === 'sys.disarm') {
    assertEmptyPayload(payload, action);
    return {};
  }

  if (action === 'watchdog.configure') {
    return { timeoutMs: assertNonNegativeInt(payload.timeoutMs, 'timeoutMs') };
  }

  if (action === 'watchdog.kick') {
    if (payload.validityMs !== undefined) {
      return { validityMs: assertPositiveInt(payload.validityMs, 'validityMs') };
    }
    return {};
  }

  if (firmware !== 'esp32-bridge') {
    return payload;
  }

  switch (action) {
    case 'gpio.configSafeState': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32ModePin(pin);
      const safeLevel =
        payload.safeLevel === undefined ? 'low' : assertSafeLevel(payload.safeLevel);
      const polarity =
        payload.polarity === undefined ? 'active-high' : assertPolarity(payload.polarity);
      return { pin, safeLevel, polarity };
    }
    case 'gpio.mode': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32ModePin(pin);
      const result: Record<string, unknown> = {
        pin,
        mode: assertGpioMode(payload.mode),
      };
      if (payload.safeLevel !== undefined) {
        result.safeLevel = assertSafeLevel(payload.safeLevel);
      }
      if (payload.polarity !== undefined) {
        result.polarity = assertPolarity(payload.polarity);
      }
      return result;
    }
    case 'gpio.write': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32WritePin(pin);
      const result: Record<string, unknown> = { pin, value: assertGpioValue(payload.value) };
      if (payload.validityMs !== undefined) {
        result.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return result;
    }
    case 'gpio.batchWrite': {
      if (
        !Array.isArray(payload.writes) ||
        payload.writes.length < 1 ||
        payload.writes.length > 16
      ) {
        throw new ValidationError('writes must contain 1–16 entries.');
      }
      const result: Record<string, unknown> = {
        writes: payload.writes.map((entry, index) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new ValidationError(`writes[${index}] must be an object.`);
          }
          const item = entry as Record<string, unknown>;
          const pin = assertGpioPin(item.pin);
          if (!boardAware) assertEsp32WritePin(pin);
          return { pin, value: assertGpioValue(item.value) };
        }),
      };
      if (payload.validityMs !== undefined) {
        result.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return result;
    }
    case 'gpio.stopAll':
      assertEmptyPayload(payload, action);
      return {};
    case 'gpio.read':
    case 'gpio.watch':
    case 'gpio.unwatch': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32ReadPin(pin);
      return { pin };
    }
    case 'gpio.toggle':
    case 'gpio.pulse': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32WritePin(pin);
      if (action === 'gpio.toggle') {
        const result: Record<string, unknown> = { pin };
        if (payload.validityMs !== undefined) {
          result.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
        }
        return result;
      }
      const result: Record<string, unknown> = {
        pin,
        durationMs: assertPositiveInt(payload.durationMs, 'durationMs'),
        value: payload.value === undefined ? true : assertGpioValue(payload.value),
      };
      if (payload.validityMs !== undefined) {
        result.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return result;
    }
    case 'gpio.pwm': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32PwmPin(pin);
      const result: Record<string, unknown> = {
        channel: payload.channel === undefined ? pin % 8 : assertChannel(payload.channel),
        pin,
        duty: assertDuty(payload.duty),
        frequency:
          payload.frequency === undefined
            ? 5000
            : assertPositiveInt(payload.frequency, 'frequency'),
      };
      if (payload.validityMs !== undefined) {
        result.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return result;
    }
    case 'gpio.analogRead': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32AnalogPin(pin);
      return { pin };
    }
    case 'i2c.begin': {
      const next: Record<string, unknown> = {};
      if (payload.sda !== undefined) {
        const sda = assertGpioPin(payload.sda);
        if (!boardAware) assertEsp32BusPin(sda, 'I2C SDA');
        next.sda = sda;
      }
      if (payload.scl !== undefined) {
        const scl = assertGpioPin(payload.scl);
        if (!boardAware) assertEsp32BusPin(scl, 'I2C SCL');
        next.scl = scl;
      }
      if (payload.frequency !== undefined) {
        next.frequency = assertPositiveInt(payload.frequency, 'frequency');
      }
      return next;
    }
    case 'i2c.write': {
      const result: Record<string, unknown> = {
        address: assertI2cAddress(payload.address),
        data: assertBusBytes(payload.data, 'data'),
      };
      if (payload.validityMs !== undefined) {
        result.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return result;
    }
    case 'i2c.read':
      return {
        address: assertI2cAddress(payload.address),
        length: assertBusLength(payload.length),
      };
    case 'i2c.scan':
      assertEmptyPayload(payload, action);
      return {};
    case 'spi.begin': {
      const next: Record<string, unknown> = {};
      if (payload.sck !== undefined) {
        const sck = assertGpioPin(payload.sck);
        if (!boardAware) assertEsp32BusPin(sck, 'SPI SCK');
        next.sck = sck;
      }
      if (payload.miso !== undefined) {
        const miso = assertGpioPin(payload.miso);
        if (!boardAware) assertEsp32ReadPin(miso);
        next.miso = miso;
      }
      if (payload.mosi !== undefined) {
        const mosi = assertGpioPin(payload.mosi);
        if (!boardAware) assertEsp32BusPin(mosi, 'SPI MOSI');
        next.mosi = mosi;
      }
      if (payload.chipSelect !== undefined) {
        const chipSelect = assertGpioPin(payload.chipSelect);
        if (!boardAware) assertEsp32BusPin(chipSelect, 'SPI chip-select');
        next.chipSelect = chipSelect;
      }
      if (payload.frequency !== undefined) {
        next.frequency = assertPositiveInt(payload.frequency, 'frequency');
      }
      return next;
    }
    case 'spi.transfer': {
      const next: Record<string, unknown> = { data: assertBusBytes(payload.data, 'data') };
      if (payload.chipSelect !== undefined) {
        const chipSelect = assertGpioPin(payload.chipSelect);
        if (!boardAware) assertEsp32BusPin(chipSelect, 'SPI chip-select');
        next.chipSelect = chipSelect;
      }
      if (payload.validityMs !== undefined) {
        next.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return next;
    }
    case 'gpio.servo': {
      const pin = assertGpioPin(payload.pin);
      if (!boardAware) assertEsp32PwmPin(pin);
      const result: Record<string, unknown> = { pin, angle: assertServoAngle(payload.angle) };
      if (payload.validityMs !== undefined) {
        result.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return result;
    }
    case 'gpio.motor': {
      const pwmPin = assertGpioPin(payload.pwmPin);
      if (!boardAware) assertEsp32PwmPin(pwmPin);
      const next: Record<string, unknown> = { pwmPin };
      if (payload.dirPin !== undefined) {
        const dirPin = assertGpioPin(payload.dirPin);
        if (!boardAware) assertEsp32WritePin(dirPin);
        next.dirPin = dirPin;
      }
      next.speed = assertMotorSpeed(payload.speed, payload.dirPin !== undefined);
      if (payload.validityMs !== undefined) {
        next.validityMs = assertPositiveInt(payload.validityMs, 'validityMs');
      }
      return next;
    }
    default:
      return payload;
  }
}

function assertEmptyPayload(payload: Record<string, unknown>, action: string): void {
  for (const key of Object.keys(payload)) {
    throw new ValidationError(`Unexpected field '${key}' in payload for '${action}'.`);
  }
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer, received ${String(value)}.`);
  }
  return value;
}

function assertChannel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 15) {
    throw new ValidationError(
      `channel must be an integer from 0 to 15, received ${String(value)}.`,
    );
  }
  return value;
}

function assertDuty(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`duty must be a number from 0 to 1, received ${String(value)}.`);
  }
  return value;
}
