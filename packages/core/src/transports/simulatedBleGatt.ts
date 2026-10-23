import { TransportError } from '../errors.js';
import { simulatedEsp32 } from '../drivers/esp32/simulatedTransport.js';
import type { Transport } from '../types.js';
import type { BleGattSession } from './bleGattSession.js';
import { bleGattTransport, type BleGattTransport } from './bleGattTransport.js';
import { ByteQueue } from './byteQueue.js';
import {
  pinoutBleDefaultAttPayloadBytes,
  pinoutBleGattUuids,
} from './bleGattUuids.js';

export interface SimulatedBleGattBridgeOptions {
  /**
   * Device-side byte pipe. Defaults to {@link simulatedEsp32}.
   * The bridge copies RX writes into this transport and notifies TX from its readable.
   */
  inner?: Transport;
  /**
   * When set, TX notifications are fragmented to this payload size to mimic a
   * conservative ATT MTU. Defaults to {@link pinoutBleDefaultAttPayloadBytes}.
   * Pass `0` to disable chunking.
   */
  attPayloadBytes?: number;
}

export interface SimulatedBleGattBridge {
  /** UUIDs the simulated peripheral exposes (same as firmware). */
  readonly uuids: typeof pinoutBleGattUuids;
  /** Host session suitable for {@link bleGattTransport}. */
  readonly hostSession: BleGattSession;
  /** Convenience Transport (`kind: simulated-ble-gatt`) ready for `connect()`. */
  readonly transport: BleGattTransport;
  /** Tear down host session and inner device transport. */
  close(): Promise<void>;
}

/**
 * In-process BLE GATT peripheral + host session pair for CI.
 *
 * Status: **SIMULATED** — no physical radio. Exercises the same RX/TX UUID
 * layout and byte path as `firmware/esp32-ble-bridge`.
 */
export function createSimulatedBleGattBridge(
  options: SimulatedBleGattBridgeOptions = {},
): SimulatedBleGattBridge {
  const inner = options.inner ?? simulatedEsp32();
  const attPayloadBytes =
    options.attPayloadBytes === undefined
      ? pinoutBleDefaultAttPayloadBytes
      : options.attPayloadBytes;

  const hostTx = new ByteQueue();
  let opened = false;
  let devicePump: Promise<void> | undefined;
  let closed = false;

  const hostSession: BleGattSession = {
    get txNotifications(): AsyncIterable<Uint8Array> {
      return hostTx;
    },

    async open(): Promise<void> {
      if (closed) {
        throw new TransportError('Simulated BLE GATT bridge is closed.');
      }
      if (opened) {
        return;
      }
      opened = true;
      await inner.open();
      devicePump = (async () => {
        try {
          for await (const chunk of inner.readable) {
            for (const piece of chunkBytes(chunk, attPayloadBytes)) {
              hostTx.push(piece);
            }
          }
        } catch (error) {
          hostTx.fail(
            error instanceof Error
              ? error
              : new TransportError(`Simulated BLE device stream failed: ${String(error)}`),
          );
          return;
        }
        hostTx.close();
      })();
    },

    async writeRx(data: Uint8Array): Promise<void> {
      if (!opened || closed) {
        throw new TransportError('Simulated BLE GATT session is not open.');
      }
      await inner.write(data);
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      opened = false;
      hostTx.close();
      await inner.close();
      if (devicePump) {
        await devicePump.catch(() => undefined);
        devicePump = undefined;
      }
    },
  };

  const transport = bleGattTransport({
    session: hostSession,
    kind: 'simulated-ble-gatt',
  });

  return {
    uuids: pinoutBleGattUuids,
    hostSession,
    transport,
    async close(): Promise<void> {
      await transport.close();
    },
  };
}

function chunkBytes(data: Uint8Array, payloadBytes: number): Uint8Array[] {
  if (payloadBytes <= 0 || data.byteLength <= payloadBytes) {
    return [data];
  }
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += payloadBytes) {
    pieces.push(data.subarray(offset, Math.min(offset + payloadBytes, data.byteLength)));
  }
  return pieces;
}
