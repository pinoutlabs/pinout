export {
  AWARENESS_TRANSITIONS,
  DEFAULT_STALENESS,
  type AwarenessConnector,
  type AwarenessEvent,
  type AwarenessEventType,
  type AwarenessFile,
  type AwarenessHealth,
  type AwarenessIdentity,
  type AwarenessRecord,
  type AwarenessState,
  type AwarenessStalenessConfig,
  type AwarenessTransport,
  type ConnectorStatus,
  type EvidenceLevel,
  type SupportLevel,
} from './types.js';

export {
  InvalidAwarenessTransitionError,
  assertTransition,
  canTransition,
  evaluateStaleness,
  isKnownModule,
  presenceStateForObservation,
  transition,
} from './stateMachine.js';

export {
  AwarenessRegistry,
  atomicWriteJson,
  resolveAwarenessPath,
  transitionPath,
  type AwarenessJournalSink,
  type AwarenessRegistryOptions,
} from './store.js';

export {
  AwarenessClient,
  type AwarenessClientOptions,
  type AwarenessSubscribeCallback,
  type EnrollResult,
} from './client.js';

export {
  MOCK_DEVICE_PRESETS,
  loadMockDevices,
  macHash,
  mockDiscoveryPlugin,
  mockSpecToCandidate,
  type MockDeviceSpec,
  type MockDevicesFile,
} from './mockDevices.js';

export {
  supportLevelToSupportStatus,
  evidenceLevelToSupportStatus,
} from './supportMapping.js';
