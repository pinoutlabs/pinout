/**
 * Fixed GATT layout for Pinout NDJSON over BLE.
 *
 * Layout mirrors a Nordic UART–style duplex (RX write / TX notify) but uses
 * Pinout-owned 128-bit UUIDs so tooling does not confuse this service with NUS.
 *
 * Shared with `firmware/esp32-ble-bridge`. Transports move bytes only — they do
 * not parse GPIO commands.
 */
export const pinoutBleGattUuids = {
  /** Primary service advertised by the ESP32 BLE bridge. */
  service: '6e700001-b5a3-f393-e0a9-e50e24dcca9e',
  /**
   * Host → device. Properties: Write, Write Without Response.
   * Carries UTF-8 NDJSON bytes (may be fragmented across ATT writes).
   */
  rx: '6e700002-b5a3-f393-e0a9-e50e24dcca9e',
  /**
   * Device → host. Properties: Notify.
   * Carries UTF-8 NDJSON bytes (may be fragmented across notifications).
   */
  tx: '6e700003-b5a3-f393-e0a9-e50e24dcca9e',
} as const;

export type PinoutBleGattUuidKey = keyof typeof pinoutBleGattUuids;

/** Default local name prefix used when advertising (firmware may append a suffix). */
export const pinoutBleAdvertisedNamePrefix = 'Pinout';

/**
 * Conservative default ATT payload size used by the in-process simulator when
 * chunking TX notifications. Real radios negotiate MTU; this matches a common
 * default (ATT_MTU 23 → 20-byte value).
 */
export const pinoutBleDefaultAttPayloadBytes = 20;
