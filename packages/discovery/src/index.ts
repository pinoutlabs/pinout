export {
  validateCandidate,
  mergeCandidates,
  runDiscovery,
  formatCandidatesTable,
  candidateId,
  CandidateValidationError,
} from './core.js';
export type {
  DiscoveredCandidate,
  DiscoveredEndpoint,
  EndpointKind,
  Evidence,
  IdentityGuess,
  DiscoveryOptions,
  DiscoveryPlugin,
  DiscoveryRun,
} from './core.js';
export {
  serialDiscoveryPlugin,
  usbDiscoveryPlugin,
  mdnsDiscoveryPlugin,
  networkProbePlugin,
  encodeMdnsQuery,
  parseMdnsResponse,
} from './plugins.js';
export {
  bleDiscoveryPlugin,
  simulatedBleScan,
  defaultBleScan,
  linuxBluetoothctlScan,
  parseBluetoothctlOutput,
  advertisementToCandidate,
  bleScanAvailable,
  normalizeBleAddress,
  normalizeBleUuid,
  BLE_RULES,
} from './ble.js';
export type { BleAdvertisement, BleScan, BleScanOptions, BleIdentityRule } from './ble.js';