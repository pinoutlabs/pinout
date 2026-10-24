#!/usr/bin/env node
import { runStdioServer } from './runStdio.js';

export { createDaemonMcpServer } from './createDaemonServer.js';
export type { DaemonMcpServerOptions } from './createDaemonServer.js';
export {
  awarenessControlPlaneTools,
  awarenessToolNames,
  nearbyDevicesToolName,
  awarenessEventsToolName,
  describeNearbyToolName,
  requestEnrollToolName,
  generateConnectorToolName,
  connectorStatusToolName,
  listConnectorsToolName,
} from './awarenessSurface.js';
export {
  normalizeEvidenceLevel,
  withNormalizedEvidence,
  normalizeGeneratedConnector,
  normalizeConnectorRecord,
  filterAwarenessRecords,
  awarenessConnectorGuidance,
  generatedConnectorGuidance,
  connectorCapabilityGuidance,
  honestyNote,
} from './awarenessContracts.js';
export type {
  AwarenessRecord,
  AwarenessEvent,
  AwarenessEventType,
  AwarenessState,
  AwarenessTransport,
  AwarenessIdentity,
  AwarenessHealth,
  AwarenessConnector,
  EvidenceLevel,
  GeneratedConnectorStatus,
  GeneratedConnectorRecord,
  ConnectorStatus,
  ConnectorRecord,
  NearbyDevicesFilter,
} from './awarenessContracts.js';
export type { SupportLevel } from '@pinout/core';
export { AwarenessClient } from '@pinout/awareness';
export type {
  AwarenessClientOptions,
  AwarenessSubscribeCallback,
  EnrollResult,
} from '@pinout/awareness';

runStdioServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
