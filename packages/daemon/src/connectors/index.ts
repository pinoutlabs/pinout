export type {
  ConnectorStatus,
  ConnectorRangeMap,
  ConnectorCapabilitySummary,
  ConnectorSafetyFlags,
  ConnectorApproval,
  ConnectorConformanceReport,
  ConnectorRecord,
  ConnectorListItem,
  ApproveConnectorBody,
  RejectConnectorBody,
  GenerateConnectorBody,
} from './types.js';

export { ConnectorPipeline, type ConnectorPipelineOptions } from './pipeline.js';

export {
  createAwarenessServiceLookup,
  buildIrFromAwareness,
  resolveAwarenessRecord,
  type AwarenessLookup,
} from './awareness.js';

export type { AwarenessRecord } from '@pinout/awareness';

export {
  generateConnector,
  generateConnectorFallback,
  adaptGeneratorResult,
  type GenerateConnectorFn,
  type GenerateConnectorInput,
  type GenerateConnectorResult,
} from './generateAdapter.js';

export {
  runConformanceGate,
  assertIntegrityMatches,
  computeModuleHashes,
} from './conformanceGate.js';

export { installConnectorModule, uninstallConnectorModule } from './install.js';

export {
  serializeConnectorRecord,
  serializeConnectorListItem,
} from './serialize.js';

export {
  connectorsRoot,
  connectorDirectory,
  connectorModuleDirectory,
  listConnectorRecords,
  readConnectorRecord,
  writeConnectorRecord,
} from './store.js';
