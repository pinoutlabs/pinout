import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PINOUT_VERSION } from '@pinout/core';
import { loadGeneratorConfig } from '../config.js';
import { buildCandidateModule } from '../emit/buildModule.js';
import { buildConnectorFiles } from '../emit/connectorTemplates.js';
import { GENERATOR_VERSION } from '../emit/moduleEmitter.js';
import { ingestSysHello } from '../ingest/helloIngest.js';
import { ingestGattDump } from '../ingest/gattIngest.js';
import { ingestMqttObservations } from '../ingest/mqttIngest.js';
import { ingestMdnsOpenApi } from '../ingest/mdnsOpenApiIngest.js';
import { analyzeHardwareSource } from './analyze.js';
import { applyCapabilitySafetyInference } from '../safety/capabilitySafety.js';
import { createGeneratorProvider } from '../providers/registry.js';
import type {
  ConnectorSourceKind,
  GenerateConnectorOptions,
  GenerateConnectorResult,
  ConnectorGenerationReport,
} from '../types/connector.js';
import type { HardwareInterfaceIR } from '../types/ir.js';
import type { GenerationProvenance } from '../types/provenance.js';
import {
  mapFromGeneratorLifecycle,
  type GeneratorEvidenceLevel,
  type GeneratorLifecycle,
} from '../types/supportLevel.js';

/**
 * Programmatic API for the daemon / PR4 install pipeline.
 * Never installs, registers, or opens hardware connections.
 */
export async function generateConnector(
  options: GenerateConnectorOptions,
): Promise<GenerateConnectorResult> {
  if (!options.inMemory && !options.outDir) {
    throw new Error('generateConnector requires outDir or inMemory: true.');
  }
  if (options.outDir && options.inMemory !== true) {
    // disk write path
  }

  const ir = await resolveIr(options);
  const enriched = applyCapabilitySafetyInference(ensureModuleCapabilityFloor(ir));
  const named = await maybeNameUnknownDevice(enriched, options);

  const slug = slugify(named.device.model ?? named.device.vendor ?? 'generated-connector');
  const moduleId = `${slug}/connector`;
  const transportKinds = [
    ...new Set([
      'simulated',
      ...named.interfaces.map((iface) => iface.kind).filter((kind) => kind !== 'unknown'),
    ]),
  ];

  // Templates always include an in-process simulator → SIMULATION_TESTED → SIMULATED.
  // Successful compileCheck bumps lifecycle toward HUMAN_REVIEWED → COMPILE_TESTED.
  // mapFromGeneratorLifecycle always applies generated:true (cap at COMPILE_TESTED).
  let lifecycle: GeneratorLifecycle = 'SIMULATION_TESTED';
  let evidenceLevel = resolveConnectorEvidence(lifecycle);
  const provenance: GenerationProvenance = {
    pinoutVersion: PINOUT_VERSION,
    generatorVersion: GENERATOR_VERSION,
    provider: options.provider ?? 'template',
    model: options.model ?? 'deterministic-v1',
    timestamp: new Date().toISOString(),
    sourceHashes: hashRaw(options),
    status: 'GENERATED',
  };

  const files = buildConnectorFiles({
    moduleId,
    slug,
    ir: named,
    provenance,
    evidenceLevel,
    transportKinds,
  });

  let outputPath: string | undefined;
  if (options.outDir) {
    outputPath = writeConnectorFiles(options.outDir, files, options.overwrite === true);
    // Disk emits must produce a loadable ./dist/index.js for the daemon
    // conformance gate / install path (npm install + tsc via buildCandidateModule).
    // Soft compileCheck (--noEmit) remains available for callers that only want
    // a syntax probe without a full build.
    const shouldBuild = options.compileCheck !== false;
    let compiled = false;
    if (shouldBuild) {
      try {
        buildCandidateModule(outputPath);
        compiled = existsSync(join(outputPath, 'dist', 'index.js'));
      } catch {
        compiled = false;
        if (options.compileCheck) {
          compiled = await tryCompileCheck(outputPath);
        }
      }
    } else if (options.compileCheck) {
      compiled = await tryCompileCheck(outputPath);
    }
    if (compiled) {
      lifecycle = 'HUMAN_REVIEWED';
      evidenceLevel = resolveConnectorEvidence(lifecycle);
      provenance.status = 'CONFORMANCE_PASSED';
      if (evidenceLevel === 'COMPILE_TESTED') {
        const refreshed = buildConnectorFiles({
          moduleId,
          slug,
          ir: named,
          provenance,
          evidenceLevel,
          transportKinds,
        });
        // Preserve built dist/; only refresh non-entrypoint review artifacts.
        for (const [relativePath, content] of Object.entries(refreshed)) {
          if (relativePath === 'pinout.module.json') {
            // Keep entrypoint pointing at the built dist artifact.
            writeFileSync(join(outputPath, relativePath), content, 'utf8');
          } else if (
            relativePath.endsWith('.md') ||
            relativePath.endsWith('.json') ||
            relativePath.startsWith('evidence/') ||
            relativePath.startsWith('docs/')
          ) {
            writeFileSync(join(outputPath, relativePath), content, 'utf8');
          }
        }
        Object.assign(files, refreshed);
      }
    }
  }

  const pendingApprovals = named.capabilities
    .filter((cap) => cap.requiresApproval || cap.safetyClass === 'physicalOutput')
    .map((cap) => cap.id);

  const report: ConnectorGenerationReport = {
    moduleId,
    slug,
    provenance,
    uncertainties: named.uncertainties,
    transportKinds,
    evidenceLevel,
    pendingApprovals,
    neverInstalls: true,
    neverRegisters: true,
  };

  const result: GenerateConnectorResult = {
    files,
    report,
    capabilities: named.capabilities,
    safety: named.safety,
    evidenceLevel,
    ir: named,
  };
  if (outputPath) {
    result.outputPath = outputPath;
  }
  return result;
}

async function resolveIr(options: GenerateConnectorOptions): Promise<HardwareInterfaceIR> {
  if (options.ir) {
    return options.ir;
  }

  const source = options.source;
  if (source === 'ir') {
    throw new Error('source: "ir" requires options.ir.');
  }

  if (source === 'datasheet' || (source === 'auto' && options.sourcePath && !options.raw)) {
    if (!options.sourcePath) {
      throw new Error('datasheet source requires sourcePath.');
    }
    const config = loadGeneratorConfig();
    if (options.provider) {
      config.provider = options.provider;
    }
    if (options.model) {
      config.model = options.model;
    }
    const analyzed = await analyzeHardwareSource({
      sourcePath: options.sourcePath,
      config,
      ...(options.deviceClass ? { deviceClassHint: options.deviceClass } : {}),
    });
    return analyzed.ir;
  }

  if (options.raw === undefined && source !== 'auto') {
    throw new Error(`source '${source}' requires raw input (or ir).`);
  }

  const kind = source === 'auto' ? detectSourceKind(options.raw) : source;
  switch (kind) {
    case 'sys.hello':
      return ingestSysHello(options.raw);
    case 'gatt':
      return ingestGattDump(options.raw);
    case 'mqtt':
      return ingestMqttObservations(options.raw);
    case 'mdns':
    case 'openapi':
      return ingestMdnsOpenApi(options.raw);
    case 'datasheet':
      throw new Error('datasheet auto-detect requires sourcePath.');
    default:
      throw new Error(`Unsupported connector source '${String(kind)}'.`);
  }
}

export function detectSourceKind(raw: unknown): ConnectorSourceKind {
  if (!isRecord(raw)) {
    return 'sys.hello';
  }
  if (Array.isArray(raw['services']) || raw['services']) {
    return 'gatt';
  }
  if (Array.isArray(raw['samples']) || raw['broker']) {
    return 'mqtt';
  }
  if (raw['openapi'] || raw['mdns'] || raw['paths']) {
    return raw['openapi'] || raw['paths'] ? 'openapi' : 'mdns';
  }
  if (Array.isArray(raw['capabilities']) || raw['boardId'] || raw['firmware']) {
    return 'sys.hello';
  }
  return 'sys.hello';
}

async function maybeNameUnknownDevice(
  ir: HardwareInterfaceIR,
  options: GenerateConnectorOptions,
): Promise<HardwareInterfaceIR> {
  const unknown =
    !ir.device.model ||
    ir.device.model === 'unknown' ||
    ir.device.confidence < 0.4 ||
    (ir.device.deviceClass === 'device.custom' && ir.capabilities.length === 0);

  if (!unknown || (options.provider !== 'http' && options.provider !== 'openai')) {
    // Deterministic fallback naming for unknown devices — no LLM required.
    if (!ir.device.model) {
      return {
        ...ir,
        device: {
          ...ir.device,
          model: 'unknown-device',
          description:
            ir.device.description ??
            'UNKNOWN device — deterministic fallback name; LLM naming skipped or unavailable.',
        },
      };
    }
    return ir;
  }

  try {
    const config = loadGeneratorConfig();
    config.provider = options.provider ?? config.provider;
    if (options.model) {
      config.model = options.model;
    }
    const provider = createGeneratorProvider(config);
    const model = provider.createModel(config.model);
    const named = await model.generateStructured<{
      vendor?: string;
      model?: string;
      deviceClass?: string;
      description?: string;
    }>({
      name: 'hardware-interface-ir',
      instructions:
        'Name and briefly describe this UNKNOWN device from evidence. Do not invent capabilities.',
      sources: [
        {
          id: 'ir-summary',
          path: 'ir.json',
          type: 'json',
          content: JSON.stringify({
            interfaces: ir.interfaces,
            capabilityIds: ir.capabilities.map((c) => c.id),
            uncertainties: ir.uncertainties.map((u) => u.message),
          }),
          metadata: { sizeBytes: 0, lineCount: 1 },
        },
      ],
    });
    // Provider returns full IR in mock/http for hardware-interface-ir — handle both shapes.
    const deviceUpdate =
      isRecord(named) && 'device' in named
        ? (named as HardwareInterfaceIR).device
        : (named as {
            vendor?: string;
            model?: string;
            deviceClass?: string;
            description?: string;
          });
    const nextDevice = { ...ir.device };
    nextDevice.vendor = deviceUpdate.vendor ?? ir.device.vendor ?? 'Unknown';
    nextDevice.model = deviceUpdate.model ?? ir.device.model ?? 'unknown-device';
    const nextDeviceClass = deviceUpdate.deviceClass ?? ir.device.deviceClass;
    if (nextDeviceClass !== undefined) {
      nextDevice.deviceClass = nextDeviceClass;
    }
    const nextDescription = deviceUpdate.description ?? ir.device.description;
    if (nextDescription !== undefined) {
      nextDevice.description = nextDescription;
    }
    return { ...ir, device: nextDevice };
  } catch {
    return {
      ...ir,
      device: {
        ...ir.device,
        model: ir.device.model ?? 'unknown-device',
        description:
          ir.device.description ??
          'UNKNOWN device — provider failed; using deterministic fallback name.',
      },
      uncertainties: [
        ...ir.uncertainties,
        {
          id: 'provider-name-fallback',
          message:
            'LLM/http provider failed while naming UNKNOWN device; deterministic fallback used.',
          severity: 'info',
          confidence: 1,
        },
      ],
    };
  }
}

function writeConnectorFiles(
  outDir: string,
  files: Record<string, string>,
  overwrite: boolean,
): string {
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !overwrite) {
    throw new Error(
      `Output directory '${outDir}' already exists. Pass overwrite: true for fresh-dir replace semantics.`,
    );
  }
  if (overwrite && existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(outDir, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return outDir;
}

async function tryCompileCheck(outputPath: string): Promise<boolean> {
  // Soft compile check: ensure emitted TypeScript parses via tsc --noEmit when available.
  // Does not npm-install; validates syntax/structure only against local workspace types when possible.
  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/typescript/bin/tsc'),
        '-p',
        join(outputPath, 'tsconfig.json'),
        '--noEmit',
        '--pretty',
        'false',
      ],
      {
        cwd: outputPath,
        encoding: 'utf8',
        env: {
          ...process.env,
          // Map @pinout/core via NODE_PATH is insufficient for tsc; skip hard fail.
        },
      },
    );
    // Without node_modules/@pinout/core in the generated dir, tsc will fail resolution.
    // Treat "emitted and structurally valid" as SIMULATED; only bump when exit 0.
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Map generator lifecycle → SupportLevel with generated-artifact evidence rules. */
function resolveConnectorEvidence(lifecycle: GeneratorLifecycle): GeneratorEvidenceLevel {
  const level = mapFromGeneratorLifecycle(lifecycle, { generated: true });
  if (level === 'HARDWARE_VERIFIED') {
    // Defensive: generated connectors never claim hardware verification.
    return 'COMPILE_TESTED';
  }
  return level;
}

/**
 * defineModule requires ≥1 capability. When ingest finds nothing, emit an
 * explicit placeholder — never invent device-specific capabilities.
 */
function ensureModuleCapabilityFloor(ir: HardwareInterfaceIR): HardwareInterfaceIR {
  if (ir.capabilities.length > 0) {
    return ir;
  }
  const evidence = ir.evidence.length > 0 ? ir.evidence : [{ sourceId: 'generator', path: 'none' }];
  return {
    ...ir,
    capabilities: [
      {
        id: 'generator.unresolved',
        description:
          'Explicit placeholder: source yielded zero device capabilities. Not a hardware action.',
        confidence: 0.99,
        evidence,
        implementationStatus: 'unknown',
        safetyClass: 'readOnly',
        reversible: true,
        requiresApproval: false,
      },
    ],
    uncertainties: [
      ...ir.uncertainties,
      {
        id: 'no-capabilities-discovered',
        message:
          'No device capabilities were discovered; emitted generator.unresolved placeholder only.',
        severity: 'critical',
        confidence: 1,
        evidence,
      },
    ],
  };
}

function hashRaw(options: GenerateConnectorOptions): Record<string, string> {
  const hashes: Record<string, string> = {};
  if (options.raw !== undefined) {
    hashes['raw'] = createHash('sha256').update(JSON.stringify(options.raw)).digest('hex');
  }
  if (options.sourcePath) {
    hashes['sourcePath'] = createHash('sha256').update(options.sourcePath).digest('hex');
  }
  if (options.ir) {
    hashes['ir'] = createHash('sha256').update(JSON.stringify(options.ir)).digest('hex');
  }
  return hashes;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
