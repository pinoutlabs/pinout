import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEvidenceRules,
  mapFromGeneratorLifecycle,
  type SupportLevel,
} from '@pinout/core';
import {
  generateConnector as generatorGenerateConnector,
  type GenerateConnectorOptions,
  type GenerateConnectorResult as GeneratorGenerateConnectorResult,
  type HardwareInterfaceIR,
} from '@pinout/generator';

/**
 * Daemon-facing generateConnector wrapper around `@pinout/generator`.
 * Maps PR3 result shape into the install pipeline's capability summary.
 */
export interface GenerateConnectorInput {
  source?: GenerateConnectorOptions['source'];
  ir?: HardwareInterfaceIR;
  raw?: unknown;
  sourcePath?: string;
  outDir?: string;
  inMemory?: boolean;
  overwrite?: boolean;
  compileCheck?: boolean;
  deviceClass?: string;
}

export interface GenerateConnectorCapability {
  name: string;
  description?: string;
  physicalOutput: boolean;
  reversible?: boolean;
}

export interface GenerateConnectorResult {
  files: string[];
  report: Record<string, unknown>;
  capabilities: GenerateConnectorCapability[];
  safety: Record<string, unknown>;
  evidenceLevel: SupportLevel;
  moduleId: string;
  version: string;
  outputPath?: string;
  ir?: HardwareInterfaceIR;
}

export type GenerateConnectorFn = (
  input: GenerateConnectorInput,
) => Promise<GenerateConnectorResult>;

/** Call the real PR3 generateConnector, adapting the result for the pipeline. */
export async function generateConnector(
  input: GenerateConnectorInput,
): Promise<GenerateConnectorResult> {
  if (!input.outDir && !input.inMemory) {
    throw new Error('generateConnector requires outDir or inMemory.');
  }

  const options: GenerateConnectorOptions = {
    source: input.source ?? (input.ir ? 'ir' : 'auto'),
    ...(input.ir !== undefined ? { ir: input.ir } : {}),
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
    ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
    ...(input.outDir !== undefined ? { outDir: input.outDir } : {}),
    ...(input.inMemory !== undefined ? { inMemory: input.inMemory } : {}),
    ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
    ...(input.compileCheck !== undefined ? { compileCheck: input.compileCheck } : {}),
    ...(input.deviceClass !== undefined ? { deviceClass: input.deviceClass } : {}),
  };

  const generated = await generatorGenerateConnector(options);
  return adaptGeneratorResult(generated);
}

export function adaptGeneratorResult(
  generated: GeneratorGenerateConnectorResult,
): GenerateConnectorResult {
  const capabilities: GenerateConnectorCapability[] = generated.capabilities.map((capability) => {
    const physicalOutput =
      capability.safetyClass === 'physicalOutput' || capability.requiresApproval === true;
    const entry: GenerateConnectorCapability = {
      name: capability.id,
      physicalOutput,
      reversible: true,
    };
    if (capability.description !== undefined) {
      entry.description = capability.description;
    }
    return entry;
  });

  return {
    files: Object.keys(generated.files),
    report: {
      generator: 'generateConnector',
      moduleId: generated.report.moduleId,
      evidenceLevel: generated.evidenceLevel,
      pendingApprovals: generated.report.pendingApprovals,
      neverInstalls: generated.report.neverInstalls,
      neverRegisters: generated.report.neverRegisters,
      uncertainties: generated.report.uncertainties,
      transportKinds: generated.report.transportKinds,
      provenance: generated.report.provenance,
    },
    capabilities,
    safety: {
      physicalOutputsDisabled: true,
      requiresHumanApproval: true,
      constraints: generated.safety,
      pendingApprovals: generated.report.pendingApprovals,
    },
    evidenceLevel: applyEvidenceRules(generated.evidenceLevel, { generated: true }),
    moduleId: generated.report.moduleId,
    version: '0.1.0',
    ...(generated.outputPath !== undefined ? { outputPath: generated.outputPath } : {}),
    ir: generated.ir,
  };
}

/**
 * Fast JS emitter for tests (malicious/garbage/tamper). Production uses
 * `@pinout/generator` generateConnector via {@link generateConnector}.
 */
export async function generateConnectorFallback(
  input: GenerateConnectorInput,
): Promise<GenerateConnectorResult> {
  if (!input.outDir) {
    throw new Error('generateConnectorFallback requires outDir.');
  }
  const ir = input.ir;
  if (!ir) {
    throw new Error('generateConnectorFallback requires ir.');
  }

  const slug = slugify(ir.device.model ?? ir.device.vendor ?? 'generated-device');
  const moduleId = `${slug}/connector`;
  const version = '0.1.0';
  const deviceClass = ir.device.deviceClass ?? 'device.custom';
  const root = input.outDir;
  mkdirSync(root, { recursive: true });

  const caps: GenerateConnectorCapability[] = ir.capabilities.map((capability) => {
    const physicalOutput =
      capability.safetyClass === 'physicalOutput' ||
      inferPhysicalOutput(capability.id);
    const entry: GenerateConnectorCapability = {
      name: capability.id,
      physicalOutput,
      reversible: true,
    };
    if (capability.description !== undefined) {
      entry.description = capability.description;
    }
    return entry;
  });

  const files: string[] = [];
  const write = (relativePath: string, content: string): void => {
    writeFileSync(join(root, relativePath), content, 'utf8');
    files.push(relativePath);
  };

  write(
    'pinout.module.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: moduleId,
        version,
        deviceClass,
        entrypoint: './index.js',
        runtime: 'node',
        capabilities: caps.map((capability) => capability.name),
        simulation: { provided: true, simulator: 'connector-fallback' },
        status: 'CANDIDATE',
        provenance: { generated: true, source: input.source ?? 'connector-pipeline' },
        name: ir.device.model ?? moduleId,
        vendor: ir.device.vendor,
        model: ir.device.model,
        pinout: { minimumVersion: '0.0.1-alpha.1' },
      },
      null,
      2,
    )}\n`,
  );
  write('index.js', buildRunnableModuleSource(moduleId, version, deviceClass, caps));
  write(
    'GENERATION_REPORT.md',
    [
      '# Connector generation report',
      '',
      `Module: \`${moduleId}\``,
      'Status: UNVERIFIED / GENERATED (test fallback emitter)',
      '',
    ].join('\n'),
  );

  return {
    files,
    report: {
      generator: 'connector-fallback',
      moduleId,
      message: 'Test fallback emitter — production uses @pinout/generator generateConnector.',
    },
    capabilities: caps,
    safety: { physicalOutputsDisabled: true, requiresHumanApproval: true },
    evidenceLevel: applyEvidenceRules(mapFromGeneratorLifecycle('GENERATED'), { generated: true }),
    moduleId,
    version,
    outputPath: root,
    ir,
  };
}

function inferPhysicalOutput(capabilityId: string): boolean {
  const lower = capabilityId.toLowerCase();
  if (/(^|\.)(read|status|get|list|info|sense|sensor)(\.|$)/.test(lower)) {
    return false;
  }
  return /(set|write|move|actuate|on|off|drive|pwm|gpio|heat|pump|valve|relay)/.test(lower);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function buildRunnableModuleSource(
  moduleId: string,
  version: string,
  deviceClass: string,
  capabilities: GenerateConnectorCapability[],
): string {
  const capabilityLiterals = capabilities.map((capability) => {
    const physical = capability.physicalOutput;
    return `{
  name: ${JSON.stringify(capability.name)},
  description: ${JSON.stringify(capability.description ?? capability.name)},
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  outputSchema: { type: 'object', properties: {}, additionalProperties: true },
  safety: { physicalOutput: ${physical ? 'true' : 'false'}, reversible: true },
}`;
  });

  const names = capabilities.map((capability) => capability.name);
  return `const capabilities = [
${capabilityLiterals.join(',\n')}
];

const definition = {
  id: ${JSON.stringify(moduleId)},
  version: ${JSON.stringify(version)},
  deviceClass: ${JSON.stringify(deviceClass)},
  capabilities,
  capabilityNames: ${JSON.stringify(names)},
  policies: [],
  supportedTransportKinds: ['simulated'],
  createSimulatedBackend() {
    const known = new Set(${JSON.stringify(names)});
    return {
      kind: 'simulated',
      async invoke(action, payload) {
        if (!known.has(action)) {
          throw new Error('unknown capability ' + action);
        }
        return { action, payload: payload ?? {}, ok: true };
      },
      async close() {},
      async safeState() { return { ok: true }; },
      subscribe() { return () => {}; },
    };
  },
};

export default definition;
`;
}
