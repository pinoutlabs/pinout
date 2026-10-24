import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import {
  applyEvidenceRules,
  PinoutError,
  ValidationError,
  type Journal,
  type SupportLevel,
} from '@pinout/core';
import {
  buildIrFromAwareness,
  resolveAwarenessRecord,
  type AwarenessLookup,
} from './awareness.js';
import { runConformanceGate, type ConformanceGateOptions } from './conformanceGate.js';
import {
  generateConnector,
  type GenerateConnectorFn,
  type GenerateConnectorResult,
} from './generateAdapter.js';
import { installConnectorModule, uninstallConnectorModule } from './install.js';
import {
  connectorModuleDirectory,
  deleteConnectorDirectory,
  ensureConnectorsRoot,
  listConnectorRecords,
  readConnectorRecord,
  writeConnectorRecord,
} from './store.js';
import type {
  ApproveConnectorBody,
  ConnectorCapabilitySummary,
  ConnectorListItem,
  ConnectorRecord,
  ConnectorSafetyFlags,
  RejectConnectorBody,
} from './types.js';

export interface ConnectorPipelineOptions {
  home?: string;
  journal?: Journal;
  awarenessLookup?: AwarenessLookup;
  generateConnectorFn?: GenerateConnectorFn;
  conformanceOptions?: ConformanceGateOptions;
  /** Emit daemon events (connector.installed, etc.). */
  publishEvent?: (kind: string, data: Record<string, unknown>) => void;
}

const defaultSafety = (): ConnectorSafetyFlags => ({
  physicalOutputsDisabled: true,
  requiresHumanApproval: true,
  autoInstallForbidden: true,
  autoFlashForbidden: true,
  autoActuateForbidden: true,
});

export class ConnectorPipeline {
  private readonly home: string | undefined;
  private readonly journal: Journal | undefined;
  private readonly awarenessLookup: AwarenessLookup | undefined;
  private readonly generateConnectorFn: GenerateConnectorFn;
  private readonly conformanceOptions: ConformanceGateOptions;
  private readonly publishEvent: ((kind: string, data: Record<string, unknown>) => void) | undefined;

  constructor(options: ConnectorPipelineOptions = {}) {
    this.home = options.home;
    this.journal = options.journal;
    this.awarenessLookup = options.awarenessLookup;
    this.generateConnectorFn = options.generateConnectorFn ?? generateConnector;
    this.conformanceOptions = options.conformanceOptions ?? {};
    this.publishEvent = options.publishEvent;
    ensureConnectorsRoot(this.home);
  }

  private homeOpts(): { home?: string } {
    return this.home !== undefined ? { home: this.home } : {};
  }

  list(): ConnectorListItem[] {
    return listConnectorRecords(this.home);
  }

  /** Full records for HTTP/MCP (`GET /v1/connectors` matches PR2 list shape). */
  listRecords(): ConnectorRecord[] {
    return listConnectorRecords(this.home).map((item) => this.get(item.id));
  }

  get(connectorId: string): ConnectorRecord {
    const record = readConnectorRecord(connectorId, this.home);
    if (!record) {
      throw notFound(`Connector '${connectorId}' was not found.`);
    }
    return withCapabilityEnablement(record);
  }

  async generate(awarenessId: string): Promise<ConnectorRecord> {
    const awareness = await resolveAwarenessRecord(awarenessId, this.awarenessLookup);
    const ir = buildIrFromAwareness(awareness);
    const connectorId = randomUUID();
    const moduleDir = connectorModuleDirectory(connectorId, this.home);
    rmSync(moduleDir, { recursive: true, force: true });
    mkdirSync(moduleDir, { recursive: true });

    let generated: GenerateConnectorResult;
    try {
      generated = await this.generateConnectorFn({
        source: 'ir',
        ir,
        outDir: moduleDir,
        overwrite: true,
        awarenessId,
      });
    } catch (error) {
      const failed = buildFailedCandidate({
        id: connectorId,
        awarenessId,
        modulePath: moduleDir,
        moduleId: `failed/${connectorId.slice(0, 8)}`,
        reason: error instanceof Error ? error.message : String(error),
      });
      writeConnectorRecord(failed, this.home);
      this.journalAppend('connector.generated', {
        connectorId,
        awarenessId,
        status: failed.status,
        error: failed.report.reasons,
      });
      return withCapabilityEnablement(failed);
    }

    const gate = await runConformanceGate(moduleDir, this.conformanceOptions);
    const evidenceLevel = capEvidence(generated.evidenceLevel);
    const capabilities = toCapabilitySummaries(generated.capabilities, gate.passed);

    const status = gate.passed ? 'QUARANTINED' : 'CANDIDATE';
    const now = new Date().toISOString();
    const report: ConnectorRecord['report'] = {
      passed: gate.passed,
      checks: gate.checks,
      reasons: gate.reasons,
      generator: generated.report,
    };
    if (gate.level !== undefined) report.level = gate.level;
    if (gate.buildError !== undefined) report.buildError = gate.buildError;
    if (gate.integrityStatus !== undefined) report.integrityStatus = gate.integrityStatus;

    const record: ConnectorRecord = {
      id: connectorId,
      awarenessId,
      moduleId: generated.moduleId,
      version: generated.version,
      status,
      evidenceLevel,
      capabilities,
      safety: {
        ...defaultSafety(),
        physicalOutputsDisabled: true,
      },
      report,
      modulePath: moduleDir,
      createdAt: now,
      updatedAt: now,
    };
    if (gate.contentHash !== undefined) record.contentHash = gate.contentHash;
    if (gate.manifestHash !== undefined) record.manifestHash = gate.manifestHash;

    writeConnectorRecord(record, this.home);
    this.journalAppend('connector.generated', {
      connectorId,
      awarenessId,
      moduleId: record.moduleId,
      status: record.status,
      evidenceLevel: record.evidenceLevel,
      // Avoid keys matching the journal secret redactor (`pass…`).
      gatePassed: gate.passed,
    });
    if (gate.passed) {
      this.journalAppend('connector.quarantined', {
        connectorId,
        moduleId: record.moduleId,
        contentHash: record.contentHash,
      });
    }
    this.publishEvent?.('connector.generated', { connector: summarize(record) });
    return withCapabilityEnablement(record);
  }

  approve(connectorId: string, body: ApproveConnectorBody): ConnectorRecord {
    const record = this.get(connectorId);
    if (record.status === 'REJECTED') {
      throw new ValidationError(`Connector '${connectorId}' was rejected and cannot be approved.`);
    }
    if (record.status === 'CANDIDATE') {
      throw new ValidationError(
        `Connector '${connectorId}' failed the conformance gate and cannot be approved.`,
      );
    }
    if (record.status !== 'QUARANTINED' && record.status !== 'APPROVED') {
      throw new ValidationError(
        `Connector '${connectorId}' must be QUARANTINED before approval (status=${record.status}).`,
      );
    }
    if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
      throw new ValidationError("Body field 'capabilities' must be a non-empty array of names.");
    }
    if (!body.ranges || typeof body.ranges !== 'object' || Array.isArray(body.ranges)) {
      throw new ValidationError(
        "Body field 'ranges' must be an object of capability parameter bounds.",
      );
    }

    const known = new Set(record.capabilities.map((capability) => capability.name));
    for (const name of body.capabilities) {
      if (!known.has(name)) {
        throw new ValidationError(`Unknown capability '${name}' for connector '${connectorId}'.`);
      }
    }
    validateRanges(body.ranges, body.capabilities);
    for (const name of body.capabilities) {
      const capability = record.capabilities.find((entry) => entry.name === name);
      if (capability?.physicalOutput) {
        const params = body.ranges[name];
        if (!params || Object.keys(params).length === 0) {
          throw new ValidationError(
            `Physical capability '${name}' requires policy ranges at approval time.`,
          );
        }
      }
    }

    const approvedBy = body.approvedBy?.trim() || 'operator';
    const approvedAt = new Date().toISOString();
    const approval = {
      approvedAt,
      approvedBy,
      capabilities: [...body.capabilities],
      ranges: body.ranges,
    };

    const next: ConnectorRecord = {
      ...record,
      status: 'APPROVED',
      approval,
      safety: {
        ...record.safety,
        physicalOutputsDisabled: false,
      },
      capabilities: record.capabilities.map((capability) => ({
        ...capability,
        enabled: !capability.physicalOutput || body.capabilities.includes(capability.name),
      })),
      updatedAt: approvedAt,
    };
    writeConnectorRecord(next, this.home);
    this.journalAppend('connector.approved', {
      connectorId,
      approvedBy,
      approvedAt,
      capabilities: approval.capabilities,
      ranges: approval.ranges,
    });
    this.publishEvent?.('connector.approved', { connector: summarize(next) });
    return withCapabilityEnablement(next);
  }

  async install(connectorId: string): Promise<ConnectorRecord> {
    const record = this.get(connectorId);
    if (record.status !== 'APPROVED' && record.status !== 'INSTALLED') {
      throw new ValidationError(
        `Connector '${connectorId}' must be APPROVED before install (status=${record.status}).`,
      );
    }
    const result = await installConnectorModule(record, this.homeOpts());
    writeConnectorRecord(result.record, this.home);
    this.journalAppend('connector.installed', {
      connectorId,
      moduleId: result.record.moduleId,
      installPath: result.installPath,
      contentHash: result.contentHash,
      approvedBy: result.record.approval?.approvedBy,
    });
    // MCP PR2 watches /v1/events for connector_installed / connector.installed
    // with connectorId + status (see packages/mcp isConnectorInstallEvent).
    this.publishEvent?.('connector.installed', {
      connectorId: result.record.id,
      ...(result.record.awarenessId !== undefined
        ? { awarenessId: result.record.awarenessId }
        : {}),
      status: 'INSTALLED',
      connector: summarize(result.record),
      moduleId: result.record.moduleId,
    });
    return withCapabilityEnablement(result.record);
  }

  reject(connectorId: string, body: RejectConnectorBody = {}): ConnectorRecord {
    const record = this.get(connectorId);
    if (record.status === 'REJECTED') {
      return record;
    }

    if (record.status === 'INSTALLED') {
      uninstallConnectorModule(record, this.homeOpts());
    }

    const rejectedAt = new Date().toISOString();
    const rejectedBy = body.rejectedBy?.trim() || 'operator';
    const { installPath: _removedInstallPath, ...rest } = record;
    void _removedInstallPath;
    const rejection: NonNullable<ConnectorRecord['rejection']> = {
      rejectedAt,
      rejectedBy,
    };
    if (body.reason) {
      rejection.reason = body.reason;
    }
    const next: ConnectorRecord = {
      ...rest,
      status: 'REJECTED',
      rejection,
      safety: {
        ...record.safety,
        physicalOutputsDisabled: true,
      },
      capabilities: record.capabilities.map((capability) => ({
        ...capability,
        enabled: !capability.physicalOutput,
      })),
      updatedAt: rejectedAt,
    };
    writeConnectorRecord(next, this.home);
    this.journalAppend('connector.rejected', {
      connectorId,
      rejectedBy,
      rejectedAt,
      reason: body.reason,
      previousStatus: record.status,
    });
    this.publishEvent?.('connector.rejected', { connector: summarize(next) });
    return withCapabilityEnablement(next);
  }

  /** Test helper: remove connector files after assertions. */
  purge(connectorId: string): void {
    const record = readConnectorRecord(connectorId, this.home);
    if (record?.status === 'INSTALLED') {
      uninstallConnectorModule(record, this.homeOpts());
    }
    deleteConnectorDirectory(connectorId, this.home);
  }

  private journalAppend(
    kind:
      | 'connector.generated'
      | 'connector.quarantined'
      | 'connector.approved'
      | 'connector.installed'
      | 'connector.rejected',
    payload: Record<string, unknown>,
  ): void {
    if (!this.journal) return;
    this.journal.append(kind, {}, payload);
  }
}

function capEvidence(level: SupportLevel): SupportLevel {
  return applyEvidenceRules(level, { generated: true });
}

function toCapabilitySummaries(
  capabilities: GenerateConnectorResult['capabilities'],
  gatePassed: boolean,
): ConnectorCapabilitySummary[] {
  return capabilities.map((capability) => {
    const summary: ConnectorCapabilitySummary = {
      name: capability.name,
      physicalOutput: capability.physicalOutput,
      enabled: gatePassed ? !capability.physicalOutput : false,
    };
    if (capability.description !== undefined) summary.description = capability.description;
    if (capability.reversible !== undefined) summary.reversible = capability.reversible;
    return summary;
  });
}

function withCapabilityEnablement(record: ConnectorRecord): ConnectorRecord {
  if (
    record.status === 'QUARANTINED' ||
    record.status === 'CANDIDATE' ||
    record.status === 'REJECTED'
  ) {
    return {
      ...record,
      safety: { ...record.safety, physicalOutputsDisabled: true },
      capabilities: record.capabilities.map((capability) => ({
        ...capability,
        enabled: record.status === 'CANDIDATE' ? false : !capability.physicalOutput,
      })),
    };
  }
  if (record.status === 'APPROVED' || record.status === 'INSTALLED') {
    const allowed = new Set(record.approval?.capabilities ?? []);
    return {
      ...record,
      safety: {
        ...record.safety,
        physicalOutputsDisabled: allowed.size === 0,
      },
      capabilities: record.capabilities.map((capability) => ({
        ...capability,
        enabled: !capability.physicalOutput || allowed.has(capability.name),
      })),
    };
  }
  return record;
}

function validateRanges(
  ranges: ApproveConnectorBody['ranges'],
  capabilities: string[],
): void {
  for (const capability of capabilities) {
    const params = ranges[capability];
    if (!params || typeof params !== 'object') {
      continue;
    }
    for (const [param, bounds] of Object.entries(params)) {
      if (
        !bounds ||
        typeof bounds.min !== 'number' ||
        typeof bounds.max !== 'number' ||
        !Number.isFinite(bounds.min) ||
        !Number.isFinite(bounds.max) ||
        bounds.min > bounds.max
      ) {
        throw new ValidationError(
          `Invalid range for ${capability}.${param}: expected finite {min,max} with min <= max.`,
        );
      }
    }
  }
}

function buildFailedCandidate(input: {
  id: string;
  awarenessId: string;
  modulePath: string;
  moduleId: string;
  reason: string;
}): ConnectorRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    awarenessId: input.awarenessId,
    moduleId: input.moduleId,
    version: '0.0.0',
    status: 'CANDIDATE',
    evidenceLevel: 'UNKNOWN',
    capabilities: [],
    safety: defaultSafety(),
    report: {
      passed: false,
      checks: [{ name: 'generate', passed: false, detail: input.reason }],
      reasons: [input.reason],
    },
    modulePath: input.modulePath,
    createdAt: now,
    updatedAt: now,
  };
}

function summarize(record: ConnectorRecord): Record<string, unknown> {
  return {
    id: record.id,
    moduleId: record.moduleId,
    status: record.status,
    evidenceLevel: record.evidenceLevel,
    awarenessId: record.awarenessId,
  };
}

function notFound(message: string): PinoutError {
  return new PinoutError('DEVICE_NOT_FOUND', message);
}
