/**
 * Radio/session adapter for Pinout BLE GATT.
 *
 * Production hosts inject a Web Bluetooth / noble / platform binding that
 * discovers the Pinout service and wires RX writes + TX notifications.
 * CI uses {@link createSimulatedBleGattBridge} — no physical radio required.
 *
 * This interface carries opaque bytes only. Line framing and GPIO parsing stay
 * in Session / Device.
 */
export interface BleGattSession {
  /** Connect / subscribe to TX notifications. Idempotent when already open. */
  open(): Promise<void>;
  /** Tear down the link. Idempotent. */
  close(): Promise<void>;
  /** Write a chunk to the RX characteristic (host → device). */
  writeRx(data: Uint8Array): Promise<void>;
  /** Stream of TX characteristic notification payloads (device → host). */
  readonly txNotifications: AsyncIterable<Uint8Array>;
}
