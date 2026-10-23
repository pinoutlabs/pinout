import { TransportError } from '../errors.js';
import type { Transport } from '../types.js';
import type { BleGattSession } from './bleGattSession.js';
import { ByteQueue } from './byteQueue.js';

export interface BleGattTransportOptions {
  /** Injected radio or simulator session. */
  session: BleGattSession;
  /**
   * Transport kind string. Defaults to `ble-gatt`.
   * Use `simulated-ble-gatt` when the session is the in-process bridge.
   */
  kind?: string;
}

/**
 * Host-side Transport that carries Pinout NDJSON over a BLE GATT session.
 *
 * Bytes written by Session become RX characteristic writes. TX notifications
 * are pushed into the readable byte stream. No protocol parsing happens here.
 */
export function bleGattTransport(options: BleGattTransportOptions): BleGattTransport {
  return new BleGattTransport(options);
}

export class BleGattTransport implements Transport {
  readonly kind: string;
  private readonly session: BleGattSession;
  private readonly inbound = new ByteQueue();
  private opened = false;
  private pump: Promise<void> | undefined;

  constructor(options: BleGattTransportOptions) {
    this.session = options.session;
    this.kind = options.kind ?? 'ble-gatt';
  }

  get readable(): AsyncIterable<Uint8Array> {
    return this.inbound;
  }

  async open(): Promise<void> {
    if (this.opened) {
      return;
    }
    await this.session.open();
    this.opened = true;
    this.pump = this.pumpNotifications();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.opened) {
      throw new TransportError('BLE GATT transport is not open.');
    }
    await this.session.writeRx(data);
  }

  async close(): Promise<void> {
    this.opened = false;
    this.inbound.close();
    await this.session.close();
    if (this.pump) {
      await this.pump.catch(() => undefined);
      this.pump = undefined;
    }
  }

  private async pumpNotifications(): Promise<void> {
    try {
      for await (const chunk of this.session.txNotifications) {
        this.inbound.push(chunk);
      }
    } catch (error) {
      this.inbound.fail(
        error instanceof Error
          ? error
          : new TransportError(`BLE GATT notification stream failed: ${String(error)}`),
      );
      return;
    }
    this.inbound.close();
  }
}
