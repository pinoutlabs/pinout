/**
 * In-process stand-in for `firmware/esp32-mqtt-bridge`.
 *
 * Speaks the same MQTT topic contract as the Wi-Fi firmware: subscribe to
 * `cmd/*`, enforce arming, drive a virtual GPIO table, publish `state/*` and
 * `evt/*`. CI-safe — no network beyond the loopback broker simulator.
 */
import { tcpTransport } from '@pinout/core';
import type { MqttBrokerSimulator } from './brokerSimulator.js';
import { defaultEsp32MqttDeviceId, createEsp32MqttMapping } from './esp32MqttMapping.js';
import { esp32MqttTopicPrefix } from './mapping.js';
import { MqttClient } from './mqttClient.js';

export interface Esp32MqttDeviceSimulatorOptions {
  broker: MqttBrokerSimulator;
  deviceId?: string;
  clientId?: string;
  /** When true, start armed (demo/tests only). Default false. */
  autoArm?: boolean;
}

type ArmedState = 'disarmed' | 'armed' | 'tripped';

/**
 * Firmware-side MQTT peer for the ESP32 Wi-Fi bridge contract.
 * Status: SIMULATED — not physical hardware.
 */
export class Esp32MqttDeviceSimulator {
  readonly kind = 'simulated' as const;
  readonly deviceId: string;
  private readonly broker: MqttBrokerSimulator;
  private readonly client: MqttClient;
  private readonly prefix: string;
  private readonly gpioLevels = new Map<number, boolean>();
  private armed: ArmedState = 'disarmed';
  private closed = false;
  private readonly ready: Promise<void>;

  private constructor(options: {
    broker: MqttBrokerSimulator;
    deviceId: string;
    client: MqttClient;
    autoArm: boolean;
  }) {
    this.broker = options.broker;
    this.deviceId = options.deviceId;
    this.prefix = esp32MqttTopicPrefix(options.deviceId);
    this.client = options.client;
    if (options.autoArm) this.armed = 'armed';
    this.ready = this.start();
  }

  static async create(options: Esp32MqttDeviceSimulatorOptions): Promise<Esp32MqttDeviceSimulator> {
    await options.broker.start();
    const deviceId = options.deviceId ?? defaultEsp32MqttDeviceId;
    const client = new MqttClient({
      transport: tcpTransport({ host: '127.0.0.1', port: options.broker.port }),
      clientId: options.clientId ?? `esp32-mqtt-sim-${deviceId}`,
      timeoutMs: 3000,
      keepAliveSeconds: 0,
    });
    const sim = new Esp32MqttDeviceSimulator({
      broker: options.broker,
      deviceId,
      client,
      autoArm: options.autoArm === true,
    });
    await sim.ensureReady();
    return sim;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.ready;
    } catch {
      // connect failed
    }
    await this.client.close().catch(() => undefined);
  }

  getArmedState(): ArmedState {
    return this.armed;
  }

  getGpioLevel(pin: number): boolean | undefined {
    return this.gpioLevels.get(pin);
  }

  private async start(): Promise<void> {
    await this.client.connect();
    const mapping = createEsp32MqttMapping({ deviceId: this.deviceId });
    for (const rule of mapping.publishes) {
      await this.client.subscribe(rule.topic, (topic, body) => {
        void this.onCommand(topic, body);
      });
    }
    await this.publishArmed();
    await this.client.publish(
      `${this.prefix}/evt/hello`,
      JSON.stringify({
        firmware: 'esp32-mqtt-bridge',
        version: '0.0.1-alpha.1',
        protocol: 1,
        transport: 'mqtt',
        deviceId: this.deviceId,
        status: 'SIMULATED',
        capabilities: mapping.publishes.map((rule) => rule.capability),
      }),
    );
  }

  private async onCommand(topic: string, body: Buffer): Promise<void> {
    if (this.closed) return;
    let args: Record<string, unknown> = {};
    const text = body.toString('utf8').trim();
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        await this.publishError('MQTT_PAYLOAD_NOT_JSON', `Invalid JSON on ${topic}`);
        return;
      }
    }

    const action = topic.slice(`${this.prefix}/cmd/`.length);
    try {
      switch (action) {
        case 'sys.arm':
          this.armed = 'armed';
          await this.publishArmed();
          break;
        case 'sys.disarm':
          this.applySafeState();
          this.armed = 'disarmed';
          await this.publishArmed();
          break;
        case 'gpio.write': {
          this.assertArmed();
          const pin = requirePin(args.pin);
          const value = coerceBool(args.value);
          this.gpioLevels.set(pin, value);
          await this.publishGpio(pin, value);
          break;
        }
        case 'gpio.toggle': {
          this.assertArmed();
          const pin = requirePin(args.pin);
          const next = !(this.gpioLevels.get(pin) ?? false);
          this.gpioLevels.set(pin, next);
          await this.publishGpio(pin, next);
          break;
        }
        case 'gpio.read': {
          const pin = requirePin(args.pin);
          const value = this.gpioLevels.get(pin) ?? false;
          await this.publishGpio(pin, value);
          break;
        }
        default:
          await this.publishError('UNKNOWN_ACTION', `Unknown MQTT cmd '${action}'.`);
      }
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String((error as { code: string }).code)
          : 'DEVICE_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      await this.publishError(code, message);
    }
  }

  private assertArmed(): void {
    if (this.armed !== 'armed') {
      const err = new Error(
        this.armed === 'tripped'
          ? 'Device is tripped; re-arm required.'
          : 'Device is disarmed; call sys.arm first.',
      );
      (err as Error & { code: string }).code =
        this.armed === 'tripped' ? 'WATCHDOG_TRIPPED' : 'NOT_ARMED';
      throw err;
    }
  }

  private applySafeState(): void {
    for (const pin of this.gpioLevels.keys()) {
      this.gpioLevels.set(pin, false);
      void this.publishGpio(pin, false);
    }
  }

  private async publishArmed(): Promise<void> {
    await this.client.publish(`${this.prefix}/state/armed`, this.armed);
  }

  private async publishGpio(pin: number, value: boolean): Promise<void> {
    await this.client.publish(`${this.prefix}/state/gpio/${pin}`, value ? '1' : '0');
  }

  private async publishError(code: string, message: string): Promise<void> {
    await this.client.publish(`${this.prefix}/evt/error`, JSON.stringify({ code, message }));
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }
}

function requirePin(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 39) {
    const err = new Error('gpio pin must be an integer 0–39.');
    (err as Error & { code: string }).code = 'INVALID_PIN';
    throw err;
  }
  return raw;
}

function coerceBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || raw === 'high' || raw === 'true') return true;
  if (raw === 0 || raw === '0' || raw === 'low' || raw === 'false') return false;
  const err = new Error('gpio value must be boolean, 0/1, high/low, or true/false.');
  (err as Error & { code: string }).code = 'INVALID_ARGUMENT';
  throw err;
}
