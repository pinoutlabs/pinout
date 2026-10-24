import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ensurePinoutHome,
  installModuleFromPath,
  loadModuleFromDirectory,
  mergeModulePolicies,
  moduleInstallDirectory,
  policiesFromDeclarative,
  readModulesIndex,
  registerModule,
  resolvePinoutHome,
  uninstallModule,
  unregisterModule,
  writeModulesIndex,
  type DeclarativePolicyMap,
  type PinoutModuleDefinition,
  type PolicyRule,
} from '@pinout/core';
import { contentHash, manifestHash } from '@pinout/module-host';
import type { ConnectorApproval, ConnectorRecord } from './types.js';
import { assertIntegrityMatches } from './conformanceGate.js';

export interface InstallConnectorResult {
  record: ConnectorRecord;
  module: PinoutModuleDefinition;
  installPath: string;
  contentHash: string;
  manifestHash: string;
}

/**
 * Persist a quarantined/approved connector into `~/.pinout/modules`, register
 * it into runtimeModules (hot, no daemon restart), and return integrity hashes.
 */
export async function installConnectorModule(
  connector: ConnectorRecord,
  options: { home?: string } = {},
): Promise<InstallConnectorResult> {
  if (connector.status !== 'APPROVED' && connector.status !== 'INSTALLED') {
    throw new Error(
      `Connector '${connector.id}' must be APPROVED before install (status=${connector.status}).`,
    );
  }
  if (!connector.approval) {
    throw new Error(`Connector '${connector.id}' is missing an approval record.`);
  }
  if (!connector.contentHash) {
    throw new Error(`Connector '${connector.id}' is missing a content hash from the conformance gate.`);
  }

  const integrity = assertIntegrityMatches(connector.modulePath, connector.contentHash);
  if (!integrity.ok) {
    throw new Error(
      `Connector '${connector.id}' failed integrity check before install (expected ${integrity.expected}, got ${integrity.actual}).`,
    );
  }

  const home = ensurePinoutHome(options.home);
  applyApprovalPoliciesToModuleDir(connector.modulePath, connector.approval);

  const installed = await installModuleFromPath(connector.modulePath, {
    home,
    force: true,
    allowCandidate: true,
  });

  // Recompute hashes on the installed copy and persist them on the index row.
  const hashes = {
    contentHash: contentHash(installed.installPath),
    manifestHash: manifestHash(
      JSON.parse(readFileSync(join(installed.installPath, 'pinout.module.json'), 'utf8')),
    ),
  };
  const index = readModulesIndex(home);
  const nextModules = index.modules.map((entry) =>
    entry.id === installed.id
      ? { ...entry, contentHash: hashes.contentHash, manifestHash: hashes.manifestHash, status: 'REVIEWED' as const }
      : entry,
  );
  writeModulesIndex({ schemaVersion: 1, modules: nextModules }, home);

  const { module } = await loadModuleFromDirectory(installed.installPath);
  // Merge human-approved numericRange rules into the registered module even when
  // the generator entrypoint is dist/index.js (sidecar alone is not loaded).
  const approvalRules = policiesFromDeclarative(
    declarativePoliciesFromApproval(connector.approval),
  );
  const moduleWithApproval: PinoutModuleDefinition = {
    ...module,
    policies: mergeModulePolicies(module.policies ?? [], approvalRules),
  };
  registerModule(moduleWithApproval);

  const updated: ConnectorRecord = {
    ...connector,
    status: 'INSTALLED',
    installPath: installed.installPath,
    contentHash: hashes.contentHash,
    manifestHash: hashes.manifestHash,
    updatedAt: new Date().toISOString(),
  };

  return {
    record: updated,
    module: moduleWithApproval,
    installPath: installed.installPath,
    contentHash: hashes.contentHash,
    manifestHash: hashes.manifestHash,
  };
}

function declarativePoliciesFromApproval(approval: ConnectorApproval): DeclarativePolicyMap {
  const declarative: DeclarativePolicyMap = {};
  for (const capability of approval.capabilities) {
    const ranges = approval.ranges[capability] ?? {};
    const constraints: DeclarativePolicyMap[string]['constraints'] = {};
    for (const [param, bounds] of Object.entries(ranges)) {
      constraints[param] = { min: bounds.min, max: bounds.max };
    }
    declarative[capability] = { constraints };
  }
  return declarative;
}

export function uninstallConnectorModule(
  connector: ConnectorRecord,
  options: { home?: string } = {},
): void {
  const home = resolvePinoutHome(options.home);
  if (connector.moduleId) {
    try {
      unregisterModule(connector.moduleId);
    } catch {
      // Module may not be registered.
    }
    const index = readModulesIndex(home);
    if (index.modules.some((entry) => entry.id === connector.moduleId)) {
      uninstallModule(connector.moduleId, home);
    } else if (connector.installPath && existsSync(connector.installPath)) {
      rmSync(connector.installPath, { recursive: true, force: true });
    } else {
      const fallback = moduleInstallDirectory(home, connector.moduleId);
      if (existsSync(fallback)) {
        rmSync(fallback, { recursive: true, force: true });
      }
    }
  }
}

/** Write approval ranges into a sidecar policy file merged at load/install time. */
export function applyApprovalPoliciesToModuleDir(
  modulePath: string,
  approval: ConnectorApproval,
): PolicyRule[] {
  const declarative = declarativePoliciesFromApproval(approval);
  const rules = policiesFromDeclarative(declarative);
  const sidecarPath = join(modulePath, 'pinout.connector.approval.json');
  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(
    sidecarPath,
    `${JSON.stringify(
      {
        approvedAt: approval.approvedAt,
        approvedBy: approval.approvedBy,
        capabilities: approval.capabilities,
        ranges: approval.ranges,
        policies: declarative,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // If the module source is our fallback JS, splice numericRange policies into the export.
  const entryPath = join(modulePath, 'index.js');
  if (existsSync(entryPath)) {
    try {
      let source = readFileSync(entryPath, 'utf8');
      if (source.includes('policies: []') || source.includes('policies:[]')) {
        const policyLiteral = JSON.stringify(rules, null, 2);
        source = source.replace(/policies:\s*\[\s*\]/, `policies: ${policyLiteral}`);
        writeFileSync(entryPath, source, 'utf8');
      }
    } catch {
      // Sidecar remains the source of truth for operators.
    }
  }

  return rules;
}
