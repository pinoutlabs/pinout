import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HardwareInterfaceIR,
  CandidateCapability,
  CandidateSafetyConstraint,
} from '../types/ir.js';
import type { GenerationProvenance } from '../types/provenance.js';
import { confidenceBand } from '../types/ir.js';

export const GENERATOR_VERSION = '0.2.0';

export interface EmitModuleOptions {
  outputPath: string;
  ir: HardwareInterfaceIR;
  provenance: GenerationProvenance;
  overwrite?: boolean;
}

export interface EmitModuleResult {
  outputPath: string;
  moduleId: string;
  files: string[];
}

export function emitCandidateModule(options: EmitModuleOptions): EmitModuleResult {
  if (
    existsSync(options.outputPath) &&
    readdirSync(options.outputPath).length > 0 &&
    !options.overwrite
  ) {
    throw new Error(
      `Output directory '${options.outputPath}' already exists. Pass overwrite: true to replace.`,
    );
  }

  const slug = slugify(options.ir.device.model ?? options.ir.device.vendor ?? 'generated-device');
  const moduleId = `${slug}/device`;
  const root = options.outputPath;

  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  mkdirSync(join(root, 'evidence'), { recursive: true });

  const files: string[] = [];
  const write = (relativePath: string, content: string): void => {
    writeFileSync(join(root, relativePath), content, 'utf8');
    files.push(relativePath);
  };

  write('pinout.module.json', `${JSON.stringify(buildManifest(moduleId, options.ir), null, 2)}\n`);
  write('package.json', `${JSON.stringify(buildPackageJson(slug), null, 2)}\n`);
  write('tsconfig.json', `${JSON.stringify(buildTsConfig(), null, 2)}\n`);
  write('src/generated.ts', buildGeneratedMeta(options.ir, options.provenance));
  write('src/backend.ts', buildBackend(options.ir));
  write('src/index.ts', buildIndex(moduleId, options.ir));
  write('test/module.test.ts', buildModuleTest(moduleId));
  write('test/generated.test.ts', buildGeneratedTests(options.ir));
  write(
    'evidence/report.json',
    `${JSON.stringify(buildEvidenceJson(options.ir, options.provenance), null, 2)}\n`,
  );
  write('GENERATION_REPORT.md', buildGenerationReport(options.ir, options.provenance));
  write('README.md', buildReadme(slug, moduleId, options.provenance));

  return { outputPath: root, moduleId, files };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function buildManifest(moduleId: string, ir: HardwareInterfaceIR) {
  return {
    schemaVersion: 1,
    id: moduleId,
    version: '0.1.0',
    deviceClass: ir.device.deviceClass ?? 'sensor.custom',
    entrypoint: './dist/index.js',
    runtime: 'node',
    capabilities: ir.capabilities.map((capability) => capability.id),
    simulation: { provided: true, simulator: 'generated-placeholder' },
    status: 'CANDIDATE',
    provenance: { generated: true, source: 'pinout generate' },
    name: ir.device.model ?? moduleId,
    vendor: ir.device.vendor,
    model: ir.device.model,
    pinout: { minimumVersion: '0.0.1-alpha.1' },
  };
}

function buildPackageJson(slug: string) {
  return {
    name: slug,
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
    },
    include: ['src/**/*.ts'],
  };
}

function buildGeneratedMeta(ir: HardwareInterfaceIR, provenance: GenerationProvenance): string {
  return `/** PINOUT_GENERATED — do not edit without reviewing GENERATION_REPORT.md */
export const generatedProvenance = ${JSON.stringify(provenance, null, 2)} as const;

export const generatedIrSummary = {
  deviceClass: ${JSON.stringify(ir.device.deviceClass ?? 'sensor.custom')},
  capabilityCount: ${ir.capabilities.length},
  uncertaintyCount: ${ir.uncertainties.length},
  status: 'GENERATED' as const,
};
`;
}

function buildBackend(ir: HardwareInterfaceIR): string {
  const hasTemp = ir.capabilities.some((c) => c.id.startsWith('temperature.'));
  const hasDoor = ir.capabilities.some((c) => c.id.startsWith('door.'));
  const hasMotion = ir.capabilities.some((c) => c.id.startsWith('motion.'));
  const hasExperiment = ir.capabilities.some((c) => c.id.startsWith('experiment.'));

  const stateLines: string[] = ["status: 'ready'", 'simulated: true', "fidelity: 'low'"];
  if (hasTemp) {
    stateLines.push('temperature: this.temperature', 'targetTemperature: this.targetTemperature');
  }
  if (hasDoor) {
    stateLines.push('door: this.door');
  }
  if (hasMotion) {
    stateLines.push('position: this.position', 'homed: this.homed');
  }
  if (hasExperiment) {
    stateLines.push("experiment: 'idle'");
  }

  return `import type { DeviceBackend } from '@pinout/core';
import { generatedIrSummary } from './generated.js';

export class GeneratedBackend implements DeviceBackend {
  readonly kind = 'simulated' as const;
  private closed = false;
${hasTemp ? '  private temperature = 22;\n  private targetTemperature = 22;' : ''}
${hasDoor ? "  private door: 'open' | 'closed' = 'closed';" : ''}
${hasMotion ? '  private position = { x: 0, y: 0, z: 0 };\n  private homed = true;' : ''}

  constructor(private readonly config: Record<string, unknown> = {}) {}

  async invoke(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new Error('Backend is closed.');
    }
    switch (action) {
${ir.capabilities.map((cap) => backendCase(cap, ir.safety)).join('\n')}
      default:
        throw new Error(\`Unsupported capability '\${action}'.\`);
    }
  }

  subscribe(_handler: (event: string, payload: Record<string, unknown>) => void): () => void {
    return () => undefined;
  }

  getOperationalState(): Record<string, unknown> {
    return {
      ${stateLines.join(',\n      ')},
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
`;
}

function backendCase(cap: CandidateCapability, safety: CandidateSafetyConstraint[]): string {
  const review =
    cap.implementationStatus === 'unknown' || cap.implementationStatus === 'skeleton'
      ? '      // PINOUT_REVIEW_REQUIRED: skeleton implementation\n'
      : '';

  if (cap.id === 'temperature.read') {
    return `${review}      case 'temperature.read':
        return { temperature: this.temperature, unit: 'celsius' };`;
  }
  if (cap.id === 'temperature.set') {
    const range = safety.find(
      (s) => s.capability === 'temperature.set' && s.documented && s.type === 'range',
    );
    const min = range?.minimum ?? 0;
    const max = range?.maximum ?? 100;
    return `${review}      case 'temperature.set': {
        const value = payload.temperature;
        if (typeof value !== 'number') throw new Error('temperature must be a number');
        if (value < ${min} || value > ${max}) {
          throw new Error('temperature out of generated simulator range');
        }
        this.targetTemperature = value;
        this.temperature = value;
        return { temperature: value, targetTemperature: value };
      }`;
  }
  if (cap.id === 'door.open') {
    return `${review}      case 'door.open':
        this.door = 'open';
        return { door: 'open' };`;
  }
  if (cap.id === 'door.close') {
    return `${review}      case 'door.close':
        this.door = 'closed';
        return { door: 'closed' };`;
  }
  if (cap.id === 'experiment.start') {
    return `${review}      case 'experiment.start':
        if (this.door !== 'closed') throw new Error('door must be closed');
        return { experiment: 'running' };`;
  }
  if (cap.id === 'experiment.stop') {
    return `${review}      case 'experiment.stop':
        return { experiment: 'idle' };`;
  }
  if (cap.id === 'motion.home') {
    return `${review}      case 'motion.home':
        this.position = { x: 0, y: 0, z: 0 };
        this.homed = true;
        return { homed: true, position: this.position };`;
  }
  if (cap.id === 'motion.move_to') {
    return `${review}      case 'motion.move_to':
        this.position = {
          x: Number(payload.x ?? 0),
          y: Number(payload.y ?? 0),
          z: Number(payload.z ?? 0),
        };
        return { position: this.position };`;
  }
  if (cap.id === 'motion.stop') {
    return `${review}      case 'motion.stop':
        return { stopped: true };`;
  }
  if (cap.id === 'status.read') {
    return `${review}      case 'status.read':
        return { status: 'ready', simulated: true, generator: generatedIrSummary.status };`;
  }
  return `${review}      case '${cap.id}':
        // PINOUT_REVIEW_REQUIRED: verify semantics for ${cap.id}
        return { ok: true, capability: '${cap.id}' };`;
}

function buildIndex(moduleId: string, ir: HardwareInterfaceIR): string {
  const policies = buildDeclarativePolicies(ir.safety);
  const capabilities = ir.capabilities.map(capabilityDescriptor).join(',\n');

  return `import { defineModule, action, sensorRead } from '@pinout/core';
import { GeneratedBackend } from './backend.js';

export default defineModule({
  id: '${moduleId}',
  version: '0.1.0',
  device: {
    class: '${ir.device.deviceClass ?? 'sensor.custom'}',
    vendor: ${JSON.stringify(ir.device.vendor ?? 'Generated')},
    model: ${JSON.stringify(ir.device.model ?? 'Candidate')},
    description: 'UNVERIFIED generated module — human review required',
  },
  capabilities: [
${capabilities}
  ],
  policies: ${JSON.stringify(policies, null, 2)},
  supportedTransportKinds: ['simulated'],
  createBackend(config) {
    return new GeneratedBackend(config);
  },
});
`;
}

function capabilityDescriptor(cap: CandidateCapability): string {
  if (cap.id.endsWith('.read') && !cap.arguments) {
    return `    sensorRead('${cap.id}', ${JSON.stringify(cap.description ?? cap.id)}, {
      type: 'object',
      additionalProperties: true,
      properties: { value: { type: 'number' } },
    })`;
  }
  const props = cap.arguments
    ? Object.entries(cap.arguments)
        .map(
          ([key, arg]) =>
            `${key}: { type: '${arg.type}', description: ${JSON.stringify(arg.description ?? key)} }`,
        )
        .join(', ')
    : '';
  const required = cap.arguments
    ? Object.entries(cap.arguments)
        .filter(([, arg]) => arg.required)
        .map(([key]) => `'${key}'`)
        .join(', ')
    : '';
  return `    action({
      id: '${cap.id}',
      description: ${JSON.stringify(cap.description ?? cap.id)},
      input: { type: 'object', additionalProperties: false, properties: { ${props} }${required ? `, required: [${required}]` : ''} },
      output: { type: 'object', additionalProperties: true },
    })`;
}

function buildDeclarativePolicies(safety: CandidateSafetyConstraint[]) {
  const policies: Record<
    string,
    {
      constraints?: Record<string, { min?: number; max?: number }>;
      requires?: Record<string, string>;
    }
  > = {};
  for (const constraint of safety) {
    if (constraint.requiresHumanReview || !constraint.documented) {
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

function buildModuleTest(moduleId: string): string {
  return `import { describe, expect, it } from 'vitest';
import moduleDefinition from '../src/index.js';

describe('generated module', () => {
  it('exports module definition', () => {
    expect(moduleDefinition.id).toBe('${moduleId}');
    expect(moduleDefinition.capabilityNames.length).toBeGreaterThan(0);
  });

  it('backend initializes and closes', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    await backend.close();
  });
});
`;
}

function buildGeneratedTests(ir: HardwareInterfaceIR): string {
  const tempRange = ir.safety.find((s) => s.capability === 'temperature.set' && s.documented);
  const lines = [
    `import { describe, expect, it } from 'vitest';`,
    `import moduleDefinition from '../src/index.js';`,
    ``,
    `describe('generated behavior tests', () => {`,
  ];

  if (ir.capabilities.some((c) => c.id === 'temperature.set') && tempRange) {
    lines.push(`  it('temperature.set accepts in-range value', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    const mid = ${Math.floor(((tempRange.minimum ?? 10) + (tempRange.maximum ?? 80)) / 2)};
    await expect(backend.invoke('temperature.set', { temperature: mid })).resolves.toMatchObject({ temperature: mid });
    await backend.close();
  });`);
    lines.push(`  it('temperature.set rejects out-of-range value', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    await expect(backend.invoke('temperature.set', { temperature: 200 })).rejects.toThrow();
    await backend.close();
  });`);
  }

  if (ir.capabilities.some((c) => c.id === 'experiment.start')) {
    lines.push(`  it('experiment.start fails when door open', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    if (moduleDefinition.capabilityNames.includes('door.open')) {
      await backend.invoke('door.open', {});
    }
    await expect(backend.invoke('experiment.start', {})).rejects.toThrow();
    await backend.close();
  });`);
  }

  lines.push(`  it('rejects unknown actions', async () => {
    const backend = moduleDefinition.createSimulatedBackend!({});
    await expect(backend.invoke('__unknown__', {})).rejects.toThrow();
    await backend.close();
  });`);
  lines.push(`});`);
  return lines.join('\n');
}

function buildEvidenceJson(ir: HardwareInterfaceIR, provenance: GenerationProvenance) {
  return { provenance, ir, verificationStatus: 'UNVERIFIED' };
}

function buildGenerationReport(ir: HardwareInterfaceIR, provenance: GenerationProvenance): string {
  const lines = [
    '# Pinout Generation Report',
    '',
    '**Status: UNVERIFIED** — This module was automatically generated and must not drive physical hardware without review.',
    '',
    '## Provenance',
    `- Pinout: ${provenance.pinoutVersion}`,
    `- Generator: ${provenance.generatorVersion}`,
    `- Provider: ${provenance.provider}`,
    `- Model: ${provenance.model}`,
    `- Timestamp: ${provenance.timestamp}`,
    '',
    '## Sources analyzed',
    ...Object.keys(provenance.sourceHashes).map((path) => `- ${path}`),
    '',
    '## Device inference',
    `- Vendor: ${ir.device.vendor ?? 'unknown'}`,
    `- Model: ${ir.device.model ?? 'unknown'}`,
    `- Class: ${ir.device.deviceClass ?? 'unknown'}`,
    `- Confidence: ${ir.device.confidence}`,
    '',
    '## Capabilities',
    ...ir.capabilities.map(
      (c) => `- ${c.id} (${confidenceBand(c.confidence)}, ${c.implementationStatus})`,
    ),
    '',
    '## Safety constraints',
    ...ir.safety.map((s) => {
      const tag = s.requiresHumanReview ? ' [REVIEW REQUIRED]' : '';
      return `- ${s.capability}: ${s.type}${tag} (confidence ${s.confidence})`;
    }),
    '',
    '## Unresolved questions',
    ...ir.uncertainties.map((u) => `- ${u.message}`),
    '',
    '## Human review checklist',
    '- [ ] Verify transport',
    '- [ ] Verify capability semantics',
    '- [ ] Verify units',
    '- [ ] Verify safety constraints',
    '- [ ] Verify simulator behavior',
    '- [ ] Verify against hardware',
    '',
    '## Next steps',
    '```bash',
    'npm install && npm run build',
    'pinout module test .',
    '```',
    '',
    'Physical execution is disabled until explicitly installed and configured.',
  ];
  return lines.join('\n');
}

function buildReadme(slug: string, moduleId: string, provenance: GenerationProvenance): string {
  return `# ${slug} (generated)

**UNVERIFIED** candidate Pinout module (\`${moduleId}\`).

Generated by Pinout Generator ${provenance.generatorVersion} using provider \`${provenance.provider}\`.

Read \`GENERATION_REPORT.md\` before installation.

\`\`\`bash
npm install && npm run build
pinout module test .
\`\`\`
`;
}
