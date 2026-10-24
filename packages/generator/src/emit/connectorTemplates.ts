import type {
  CandidateArgument,
  CandidateCapability,
  CandidateSafetyConstraint,
  HardwareInterfaceIR,
} from '../types/ir.js';
import type { GenerationProvenance } from '../types/provenance.js';
import type { GeneratorEvidenceLevel } from '../types/supportLevel.js';
import { confidenceBand } from '../types/ir.js';
import { GENERATOR_VERSION } from './moduleEmitter.js';

export interface ConnectorEmitContext {
  moduleId: string;
  slug: string;
  ir: HardwareInterfaceIR;
  provenance: GenerationProvenance;
  evidenceLevel: GeneratorEvidenceLevel;
  transportKinds: string[];
}

/** Deterministic template files for the 8-module connector pattern. */
export function buildConnectorFiles(ctx: ConnectorEmitContext): Record<string, string> {
  const files: Record<string, string> = {};
  files['pinout.module.json'] = `${JSON.stringify(buildManifest(ctx), null, 2)}\n`;
  files['package.json'] = `${JSON.stringify(buildPackageJson(ctx.slug), null, 2)}\n`;
  files['tsconfig.json'] = `${JSON.stringify(buildTsConfig(), null, 2)}\n`;
  files['src/generated.ts'] = buildGeneratedMeta(ctx);
  files['src/types.ts'] = buildTypes(ctx);
  files['src/capabilities.ts'] = buildCapabilities(ctx);
  files['src/simulator.ts'] = buildSimulator(ctx);
  files['src/backend.ts'] = buildBackendSkeleton(ctx);
  files['src/index.ts'] = buildIndex(ctx);
  files['test/module.test.ts'] = buildModuleTest(ctx);
  files['test/conformance.test.ts'] = buildConformanceTest(ctx);
  files['docs/connector.md'] = buildDocsPage(ctx);
  files['catalog-entry.json'] = `${JSON.stringify(buildCatalogEntry(ctx), null, 2)}\n`;
  files['evidence/report.json'] = `${JSON.stringify(buildEvidenceJson(ctx), null, 2)}\n`;
  files['GENERATION_REPORT.md'] = buildGenerationReport(ctx);
  files['README.md'] = buildReadme(ctx);
  return files;
}

function buildManifest(ctx: ConnectorEmitContext) {
  return {
    schemaVersion: 1,
    id: ctx.moduleId,
    version: '0.1.0',
    deviceClass: ctx.ir.device.deviceClass ?? 'device.custom',
    entrypoint: './dist/index.js',
    runtime: 'node',
    capabilities: ctx.ir.capabilities.map((capability) => capability.id),
    simulation: { provided: true, simulator: 'generated-connector-simulator' },
    status: 'CANDIDATE',
    supportLevel: ctx.evidenceLevel,
    provenance: {
      generated: true,
      source: 'pinout generateConnector',
      generatorVersion: GENERATOR_VERSION,
      neverAutoInstall: true,
      neverAutoRegister: true,
    },
    name: ctx.ir.device.model ?? ctx.moduleId,
    vendor: ctx.ir.device.vendor,
    model: ctx.ir.device.model,
    pinout: { minimumVersion: '0.0.1-alpha.1' },
  };
}

function buildPackageJson(slug: string) {
  return {
    name: `@pinout-generated/${slug}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { build: 'tsc', test: 'vitest run' },
    dependencies: { '@pinout/core': '*' },
    devDependencies: { typescript: '^5.7.2', vitest: '^2.1.8' },
  };
}

function buildTsConfig() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      skipLibCheck: true,
      declaration: true,
    },
    include: ['src/**/*.ts'],
  };
}

function buildGeneratedMeta(ctx: ConnectorEmitContext): string {
  return `/** PINOUT_GENERATED — do not edit without reviewing GENERATION_REPORT.md */
export const generatedProvenance = ${JSON.stringify(ctx.provenance, null, 2)} as const;

export const generatedIrSummary = {
  deviceClass: ${JSON.stringify(ctx.ir.device.deviceClass ?? 'device.custom')},
  capabilityCount: ${ctx.ir.capabilities.length},
  uncertaintyCount: ${ctx.ir.uncertainties.length},
  evidenceLevel: ${JSON.stringify(ctx.evidenceLevel)} as const,
  status: 'GENERATED' as const,
  transportKinds: ${JSON.stringify(ctx.transportKinds)} as const,
};
`;
}

function buildTypes(ctx: ConnectorEmitContext): string {
  return `/** Generated config types — validate before connecting hardware. */
export interface GeneratedConnectorConfig {
  simulated?: boolean;
  /** Transport-specific options (serial path, broker URL, BLE address, …). */
  transport?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ValidatedGeneratedConnectorConfig {
  simulated: boolean;
  transport: Record<string, unknown>;
}

export function validateGeneratedConnectorConfig(
  input: GeneratedConnectorConfig = {},
): ValidatedGeneratedConnectorConfig {
  return {
    simulated: input.simulated !== false,
    transport: input.transport && typeof input.transport === 'object' ? input.transport : {},
  };
}

export const generatedDeviceMeta = {
  vendor: ${JSON.stringify(ctx.ir.device.vendor ?? 'Generated')},
  model: ${JSON.stringify(ctx.ir.device.model ?? 'Candidate')},
  deviceClass: ${JSON.stringify(ctx.ir.device.deviceClass ?? 'device.custom')},
} as const;
`;
}

function buildCapabilities(ctx: ConnectorEmitContext): string {
  const lines = [
    `import { action, sensorRead } from '@pinout/core';`,
    `import type { CapabilityDescriptor } from '@pinout/core';`,
    ``,
    `/** Capability descriptors — strict schemas; physicalOutput requiresApproval until reviewed. */`,
    `export const generatedCapabilities: CapabilityDescriptor[] = [`,
  ];
  for (const cap of ctx.ir.capabilities) {
    lines.push(capabilityDescriptor(cap, ctx.ir.safety));
    lines.push(',');
  }
  lines.push(`];`);
  lines.push(``);
  lines.push(
    `export const generatedCapabilityNames = generatedCapabilities.map((capability) => capability.name);`,
  );
  lines.push(``);
  return lines.join('\n');
}

function capabilityDescriptor(
  cap: CandidateCapability,
  safety: CandidateSafetyConstraint[],
): string {
  const isRead =
    cap.safetyClass === 'readOnly' ||
    (cap.id.endsWith('.read') && cap.safetyClass !== 'physicalOutput');
  const safetyBlock = {
    physicalOutput: cap.safetyClass === 'physicalOutput',
    reversible: cap.reversible ?? cap.safetyClass !== 'physicalOutput',
    notes:
      cap.reversibilityNotes ??
      (cap.requiresApproval
        ? 'requiresApproval: human-supplied ranges / review required before hardware use.'
        : undefined),
  };

  if (isRead && (!cap.arguments || Object.keys(cap.arguments).length === 0)) {
    const outputProps = schemaPropsFromArgs(
      cap.output ?? { value: { name: 'value', type: 'number' } },
    );
    return `  sensorRead(${JSON.stringify(cap.id)}, ${JSON.stringify(cap.description ?? cap.id)}, {
    type: 'object',
    additionalProperties: false,
    properties: { ${outputProps} },
  })`;
  }

  const args = cap.arguments ?? {};
  const props = schemaPropsFromArgs(args, safety, cap.id);
  const required = Object.entries(args)
    .filter(([, arg]) => arg.required)
    .map(([key]) => `'${key}'`);

  return `  action({
    id: ${JSON.stringify(cap.id)},
    description: ${JSON.stringify(cap.description ?? cap.id)},
    input: {
      type: 'object',
      additionalProperties: false,
      properties: { ${props} },${required.length ? `\n      required: [${required.join(', ')}],` : ''}
    },
    output: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    safety: ${JSON.stringify(safetyBlock)},
  })`;
}

function schemaPropsFromArgs(
  args: Record<string, CandidateArgument>,
  safety?: CandidateSafetyConstraint[],
  capabilityId?: string,
): string {
  return Object.entries(args)
    .map(([key, arg]) => {
      const parts = [`type: '${arg.type}'`];
      if (arg.description) {
        parts.push(`description: ${JSON.stringify(arg.description)}`);
      }
      const range = safety?.find(
        (s) =>
          s.capability === capabilityId &&
          s.argument === key &&
          s.documented &&
          !s.requiresHumanReview &&
          s.type === 'range',
      );
      const min = range?.minimum ?? arg.minimum;
      const max = range?.maximum ?? arg.maximum;
      // Only emit numeric bounds when documented (or enum). Sample-only bounds are stripped upstream.
      if (typeof min === 'number' && range) {
        parts.push(`minimum: ${min}`);
      }
      if (typeof max === 'number' && range) {
        parts.push(`maximum: ${max}`);
      }
      if (arg.enumValues && arg.enumValues.length > 0) {
        parts.push(`enum: ${JSON.stringify(arg.enumValues)}`);
      }
      return `${key}: { ${parts.join(', ')} }`;
    })
    .join(', ');
}

function buildSimulator(ctx: ConnectorEmitContext): string {
  const stateFields = inferSimulatorState(ctx.ir.capabilities);
  return `import type { DeviceBackend } from '@pinout/core';
import { generatedIrSummary } from './generated.js';
import type { ValidatedGeneratedConnectorConfig } from './types.js';

/** In-process simulator stub — evidenceLevel never exceeds COMPILE_TESTED. */
export class GeneratedConnectorSimulator implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private closed = false;
${stateFields.fields}

  constructor(private readonly config: ValidatedGeneratedConnectorConfig) {}

  async invoke(actionName: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new Error('Simulator is closed.');
    }
    switch (actionName) {
${ctx.ir.capabilities.map((cap) => simulatorCase(cap)).join('\n')}
      default:
        throw new Error(\`Unsupported capability '\${actionName}'.\`);
    }
  }

  subscribe(_handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    return () => undefined;
  }

  getOperationalState(): Record<string, unknown> {
    return {
      status: 'ready',
      simulated: true,
      fidelity: 'low',
      evidenceLevel: generatedIrSummary.evidenceLevel,
      transportKinds: generatedIrSummary.transportKinds,
${stateFields.stateReturn}
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
`;
}

function inferSimulatorState(capabilities: CandidateCapability[]): {
  fields: string;
  stateReturn: string;
} {
  const hasTemp = capabilities.some((c) => c.id.includes('temperature') || /temp/i.test(c.id));
  // Always declare energized/armed so actuation stubs typecheck.
  const fields: string[] = [
    '  private temperatureC = 22;',
    '  private energized = false;',
    "  private armed: 'armed' | 'disarmed' = 'disarmed';",
  ];
  const stateReturn: string[] = [
    ...(hasTemp ? ['      temperatureC: this.temperatureC,'] : []),
    '      energized: this.energized,',
    '      armed: this.armed,',
  ];
  return { fields: fields.join('\n'), stateReturn: stateReturn.join('\n') };
}

function simulatorCase(cap: CandidateCapability): string {
  const review =
    cap.requiresApproval || cap.implementationStatus !== 'implemented'
      ? '      // PINOUT_REVIEW_REQUIRED: simulator stub\n'
      : '';
  if (cap.safetyClass === 'readOnly' || cap.id.endsWith('.read') || cap.id.includes('status')) {
    if (cap.id.includes('temperature') || /temp/i.test(cap.id)) {
      return `${review}      case '${cap.id}':
        return { temperatureC: this.temperatureC, unit: 'C', provenance: 'simulated', source: 'simulated' };`;
    }
    return `${review}      case '${cap.id}':
        return { ok: true, capability: '${cap.id}', provenance: 'simulated', armed: this.armed };`;
  }
  if (/arm/i.test(cap.id) && !/disarm/i.test(cap.id)) {
    return `${review}      case '${cap.id}':
        this.armed = 'armed';
        return { armed: 'armed' };`;
  }
  if (/disarm/i.test(cap.id)) {
    return `${review}      case '${cap.id}':
        this.armed = 'disarmed';
        this.energized = false;
        return { armed: 'disarmed' };`;
  }
  if (/\.on$|relay\.on|power\.on/i.test(cap.id)) {
    return `${review}      case '${cap.id}':
        this.energized = true;
        return { on: true, ok: true };`;
  }
  if (/\.off$|relay\.off|power\.off/i.test(cap.id)) {
    return `${review}      case '${cap.id}':
        this.energized = false;
        return { on: false, ok: true };`;
  }
  return `${review}      case '${cap.id}':
        // PINOUT_REVIEW_REQUIRED: verify semantics for ${cap.id}
        return { ok: true, capability: '${cap.id}', payload };`;
}

function buildBackendSkeleton(ctx: ConnectorEmitContext): string {
  const primary = ctx.transportKinds.find((k) => k !== 'simulated') ?? 'unknown';
  return `import type { DeviceBackend } from '@pinout/core';
import { GeneratedConnectorSimulator } from './simulator.js';
import {
  validateGeneratedConnectorConfig,
  type GeneratedConnectorConfig,
  type ValidatedGeneratedConnectorConfig,
} from './types.js';

/**
 * Transport backend skeleton for ${primary}.
 * Generated connectors NEVER open hardware sockets/serial/BLE by default.
 * Protocol path throws until a human wires a real transport (PR4 install).
 */
export class GeneratedConnectorBackend implements DeviceBackend {
  readonly kind: 'simulated' | 'protocol';
  private readonly inner: DeviceBackend;
  private readonly config: ValidatedGeneratedConnectorConfig;

  constructor(config: GeneratedConnectorConfig = {}) {
    this.config = validateGeneratedConnectorConfig(config);
    const forceSim = this.config.simulated !== false;
    if (!forceSim) {
      throw new Error(
        'Generated connector protocol backend is a skeleton — physical transport is disabled until human install/review (never auto-connect).',
      );
    }
    this.kind = 'simulated';
    this.inner = new GeneratedConnectorSimulator(this.config);
  }

  invoke(actionName: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.inner.invoke(actionName, payload);
  }

  subscribe(handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    return this.inner.subscribe(handler);
  }

  getOperationalState(): Record<string, unknown> {
    return this.inner.getOperationalState?.() ?? { status: 'ready' };
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export function createGeneratedConnectorBackend(
  config: GeneratedConnectorConfig = {},
): DeviceBackend {
  return new GeneratedConnectorBackend(config);
}
`;
}

function buildIndex(ctx: ConnectorEmitContext): string {
  const policies = buildDeclarativePolicies(ctx.ir.safety);
  const pendingApprovals = ctx.ir.capabilities
    .filter((cap) => cap.requiresApproval || cap.safetyClass === 'physicalOutput')
    .map((cap) => cap.id);
  return `import { defineModule } from '@pinout/core';
import { generatedCapabilities } from './capabilities.js';
import { createGeneratedConnectorBackend } from './backend.js';
import { generatedDeviceMeta } from './types.js';

/**
 * Default-deny stubs: physicalOutput capabilities that still need human-supplied
 * ranges before hard policies are eligible. Not part of DeclarativePolicyMap —
 * tracked here + GENERATION_REPORT.md for PR4 / operators.
 */
export const generatedRequiresApproval = ${JSON.stringify(pendingApprovals, null, 2)} as const;

export default defineModule({
  id: ${JSON.stringify(ctx.moduleId)},
  version: '0.1.0',
  device: {
    class: generatedDeviceMeta.deviceClass,
    vendor: generatedDeviceMeta.vendor,
    model: generatedDeviceMeta.model,
    description: 'UNVERIFIED generated connector — human review required; never auto-installed.',
  },
  capabilities: generatedCapabilities,
  policies: ${JSON.stringify(policies, null, 2)},
  supportedTransportKinds: ${JSON.stringify(['simulated', ...ctx.transportKinds.filter((k) => k !== 'simulated')])},
  createBackend(config) {
    return createGeneratedConnectorBackend(config);
  },
});
`;
}

/** Only documented, non-review constraints become runtime declarative policies. */
function buildDeclarativePolicies(safety: CandidateSafetyConstraint[]): Record<
  string,
  {
    constraints?: Record<string, { min?: number; max?: number }>;
    requires?: Record<string, string>;
  }
> {
  const policies: Record<
    string,
    {
      constraints?: Record<string, { min?: number; max?: number }>;
      requires?: Record<string, string>;
    }
  > = {};

  for (const constraint of safety) {
    if (constraint.requiresApproval || constraint.requiresHumanReview || !constraint.documented) {
      continue;
    }
    const entry = policies[constraint.capability] ?? {};
    if (constraint.type === 'range' && constraint.argument) {
      entry.constraints ??= {};
      const bounds: { min?: number; max?: number } = {};
      if (constraint.minimum !== undefined) {
        bounds.min = constraint.minimum;
      }
      if (constraint.maximum !== undefined) {
        bounds.max = constraint.maximum;
      }
      entry.constraints[constraint.argument] = bounds;
    }
    if (constraint.type === 'precondition' && constraint.field) {
      entry.requires ??= {};
      entry.requires[constraint.field] = String(constraint.equals);
    }
    policies[constraint.capability] = entry;
  }
  return policies;
}

function buildModuleTest(ctx: ConnectorEmitContext): string {
  return `import { describe, expect, it } from 'vitest';
import moduleDefinition from '../src/index.js';

describe('generated connector module', () => {
  it('exports module definition', () => {
    expect(moduleDefinition.id).toBe(${JSON.stringify(ctx.moduleId)});
    expect(moduleDefinition.capabilityNames.length).toBeGreaterThan(0);
  });

  it('simulator initializes and closes', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    await backend.close();
  });

  it('rejects unknown actions', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    await expect(backend.invoke('__unknown__', {})).rejects.toThrow();
    await backend.close();
  });
});
`;
}

function buildConformanceTest(ctx: ConnectorEmitContext): string {
  const physical = ctx.ir.capabilities.filter((c) => c.safetyClass === 'physicalOutput');
  return `import { describe, expect, it } from 'vitest';
import moduleDefinition from '../src/index.js';
import { generatedCapabilities } from '../src/capabilities.js';

/**
 * Lightweight L0-style conformance for generated connectors.
 * Does not claim physical certification. evidenceLevel ≤ COMPILE_TESTED.
 */
describe('generated connector conformance', () => {
  it('manifest capabilities match exports', () => {
    expect(new Set(moduleDefinition.capabilityNames)).toEqual(
      new Set(generatedCapabilities.map((capability) => capability.name)),
    );
  });

  it('schemas disallow additionalProperties on inputs', () => {
    for (const capability of generatedCapabilities) {
      expect(capability.inputSchema.additionalProperties).not.toBe(true);
    }
  });

  it('physicalOutput capabilities are marked and require review notes', () => {
    const physicalIds = ${JSON.stringify(physical.map((c) => c.id))};
    for (const id of physicalIds) {
      const capability = generatedCapabilities.find((item) => item.name === id);
      expect(capability?.safety.physicalOutput).toBe(true);
    }
  });

  it('invokes each read-only capability on the simulator', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    for (const capability of generatedCapabilities) {
      if (capability.safety.physicalOutput) {
        continue;
      }
      await expect(backend.invoke(capability.name, {})).resolves.toBeTruthy();
    }
    await backend.close();
  });
});
`;
}

function buildDocsPage(ctx: ConnectorEmitContext): string {
  return `# ${ctx.slug} (generated connector)

**UNVERIFIED** · evidenceLevel: \`${ctx.evidenceLevel}\` · never auto-install / auto-register.

## Device

- Vendor: ${ctx.ir.device.vendor ?? 'unknown'}
- Model: ${ctx.ir.device.model ?? 'unknown'}
- Class: ${ctx.ir.device.deviceClass ?? 'unknown'}
- Transports: ${ctx.transportKinds.join(', ')}

## Capabilities

${ctx.ir.capabilities.map((c) => `- \`${c.id}\` (${c.safetyClass ?? 'unknown'}, ${confidenceBand(c.confidence)})`).join('\n')}

## Safety

Physical outputs use **default-deny** policies (\`requiresApproval\`) until a human supplies documented ranges.
See \`GENERATION_REPORT.md\`.

## Next steps

1. Review \`GENERATION_REPORT.md\`
2. Fill policy ranges for physicalOutput capabilities
3. Wire a real transport backend (not shipped by the generator)
4. Install only via the explicit install pipeline (PR4) — generation never connects
`;
}

function buildCatalogEntry(ctx: ConnectorEmitContext) {
  return {
    id: ctx.moduleId,
    name: ctx.ir.device.model ?? ctx.slug,
    vendor: ctx.ir.device.vendor ?? 'Generated',
    deviceClass: ctx.ir.device.deviceClass ?? 'device.custom',
    status: ctx.evidenceLevel,
    supportLevel: ctx.evidenceLevel,
    transports: ctx.transportKinds,
    generated: true,
    notes:
      'Catalog draft only — not published. evidenceLevel never exceeds COMPILE_TESTED from generation.',
  };
}

function buildEvidenceJson(ctx: ConnectorEmitContext) {
  return {
    provenance: ctx.provenance,
    ir: ctx.ir,
    verificationStatus: 'UNVERIFIED',
    evidenceLevel: ctx.evidenceLevel,
    neverAutoInstall: true,
    neverAutoRegister: true,
  };
}

function buildGenerationReport(ctx: ConnectorEmitContext): string {
  const pending = ctx.ir.capabilities
    .filter((c) => c.requiresApproval || c.safetyClass === 'physicalOutput')
    .map((c) => c.id);
  return [
    '# Pinout Connector Generation Report',
    '',
    '**Status: UNVERIFIED** — Generated connector must not drive physical hardware without review.',
    '',
    `**evidenceLevel: ${ctx.evidenceLevel}** (generator never claims higher than COMPILE_TESTED).`,
    '',
    '## Provenance',
    `- Pinout: ${ctx.provenance.pinoutVersion}`,
    `- Generator: ${ctx.provenance.generatorVersion}`,
    `- Provider: ${ctx.provenance.provider}`,
    `- Model: ${ctx.provenance.model}`,
    `- Timestamp: ${ctx.provenance.timestamp}`,
    '',
    '## Device inference',
    `- Vendor: ${ctx.ir.device.vendor ?? 'unknown'}`,
    `- Model: ${ctx.ir.device.model ?? 'unknown'}`,
    `- Class: ${ctx.ir.device.deviceClass ?? 'unknown'}`,
    `- Confidence: ${ctx.ir.device.confidence}`,
    '',
    '## Transports',
    ...ctx.transportKinds.map((kind) => `- ${kind}`),
    '',
    '## Capabilities',
    ...ctx.ir.capabilities.map(
      (c) =>
        `- ${c.id} (${confidenceBand(c.confidence)}, ${c.safetyClass ?? 'unknown'}, ${c.implementationStatus}${c.requiresApproval ? ', requiresApproval' : ''})`,
    ),
    '',
    '## Safety / default-deny',
    ...ctx.ir.safety.map((s) => {
      const tags = [
        s.requiresHumanReview ? 'REVIEW' : '',
        s.requiresApproval ? 'requiresApproval' : '',
        s.documented ? 'documented' : 'undocumented',
      ]
        .filter(Boolean)
        .join(', ');
      return `- ${s.capability}: ${s.type} [${tags}] (confidence ${s.confidence})`;
    }),
    '',
    '## Pending approvals',
    ...(pending.length > 0 ? pending.map((id) => `- ${id}`) : ['- none']),
    '',
    '## Uncertainties',
    ...ctx.ir.uncertainties.map((u) => `- ${u.message}`),
    '',
    '## Reversibility notes',
    ...ctx.ir.capabilities
      .filter((c) => c.reversibilityNotes)
      .map((c) => `- ${c.id}: ${c.reversibilityNotes}`),
    '',
    '## Human review checklist',
    '- [ ] Verify transport',
    '- [ ] Verify capability semantics',
    '- [ ] Supply documented ranges for physicalOutput policies',
    '- [ ] Verify simulator behavior',
    '- [ ] Verify against hardware (separate from generation)',
    '',
    '## Non-goals of this artifact',
    '- Does **not** auto-install',
    '- Does **not** auto-register',
    '- Does **not** open serial/TCP/BLE/MQTT connections',
    '',
  ].join('\n');
}

function buildReadme(ctx: ConnectorEmitContext): string {
  return `# ${ctx.slug} (generated connector)

**UNVERIFIED** candidate (\`${ctx.moduleId}\`) · evidenceLevel \`${ctx.evidenceLevel}\`.

Generated by Pinout Generator ${ctx.provenance.generatorVersion}. Never auto-installed or registered.

\`\`\`bash
npm install && npm run build && npm test
\`\`\`

Read \`GENERATION_REPORT.md\` and \`docs/connector.md\` before any hardware use.
`;
}
