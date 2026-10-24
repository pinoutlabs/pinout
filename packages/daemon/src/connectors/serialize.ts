import type { ConnectorListItem, ConnectorRecord } from './types.js';

/**
 * MCP (`packages/mcp` PR2) expects connector payloads that
 * `normalizeGeneratedConnector` can read:
 * - id, status, evidenceLevel
 * - optional awarenessId, capabilities[], report
 * - safetyFlags.physicalOutputBlockedUntilHumanApproval (mock contract)
 * - capability entries may nest `safety: { physicalOutput, reversible }`
 *
 * We keep our richer `safety` object for CLI/operators and add MCP aliases.
 */
export function serializeConnectorRecord(connector: ConnectorRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: connector.id,
    moduleId: connector.moduleId,
    version: connector.version,
    status: connector.status,
    evidenceLevel: connector.evidenceLevel,
    capabilities: connector.capabilities.map((capability) => ({
      name: capability.name,
      physicalOutput: capability.physicalOutput,
      enabled: capability.enabled,
      ...(capability.description !== undefined ? { description: capability.description } : {}),
      ...(capability.reversible !== undefined ? { reversible: capability.reversible } : {}),
      safety: {
        physicalOutput: capability.physicalOutput,
        reversible: capability.reversible ?? true,
      },
    })),
    safety: connector.safety,
    safetyFlags: {
      physicalOutputBlockedUntilHumanApproval: connector.safety.physicalOutputsDisabled,
      requiresHumanApproval: connector.safety.requiresHumanApproval,
      autoInstallForbidden: connector.safety.autoInstallForbidden,
      autoFlashForbidden: connector.safety.autoFlashForbidden,
      autoActuateForbidden: connector.safety.autoActuateForbidden,
    },
    report: connector.report,
    contentHash: connector.contentHash,
    manifestHash: connector.manifestHash,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    installPath: connector.installPath,
  };
  if (connector.awarenessId !== undefined) {
    payload.awarenessId = connector.awarenessId;
  }
  if (connector.approval !== undefined) {
    payload.approval = connector.approval;
  }
  if (connector.rejection !== undefined) {
    payload.rejection = connector.rejection;
  }
  return payload;
}

export function serializeConnectorListItem(item: ConnectorListItem): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: item.id,
    moduleId: item.moduleId,
    status: item.status,
    evidenceLevel: item.evidenceLevel,
    updatedAt: item.updatedAt,
  };
  if (item.awarenessId !== undefined) {
    payload.awarenessId = item.awarenessId;
  }
  return payload;
}
