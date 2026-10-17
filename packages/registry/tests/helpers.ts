import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeContentHash, computeManifestHash, readModuleManifestJson } from '../src/content.js';
import type { RegistryModuleEntry } from '../src/indexFormat.js';

export interface ModuleFixtureOptions {
  id?: string;
  version?: string;
  entrypointFile?: string;
  extraManifest?: Record<string, unknown>;
}

export function writeManifest(
  root: string,
  options: ModuleFixtureOptions = {},
): Record<string, unknown> {
  const id = options.id ?? 'test/thermo';
  const version = options.version ?? '0.1.0';
  const entrypointFile = options.entrypointFile ?? 'index.js';
  mkdirSync(root, { recursive: true });
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    version,
    deviceClass: 'sensor.custom',
    entrypoint: `./${entrypointFile}`,
    runtime: 'node',
    capabilities: ['sensor.read'],
    simulation: { provided: true },
    status: 'TESTED',
    name: 'Test Thermo',
    description: 'Registry test fixture',
    ...options.extraManifest,
  };
  writeFileSync(join(root, 'pinout.module.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/** Manifest + a stub entrypoint; hashing/packing material only (never loaded). */
export function writeStubModule(root: string, options: ModuleFixtureOptions = {}): void {
  writeManifest(root, options);
  const entrypointFile = options.entrypointFile ?? 'index.js';
  writeFileSync(join(root, entrypointFile), 'export default {};\n', 'utf8');
}

/** Manifest + an entrypoint that loads and passes the core conformance kit. */
export function writeRunnableModule(
  root: string,
  options: { id?: string; version?: string } = {},
): void {
  writeManifest(root, options);
  writeFileSync(
    join(root, 'index.js'),
    runnableModuleSource(options.id ?? 'test/thermo', options.version ?? '0.1.0'),
    'utf8',
  );
}

export function runnableModuleSource(id: string, version: string): string {
  return `const capability = {
  name: 'sensor.read',
  description: 'Read the sensor.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
    additionalProperties: false,
  },
  safety: { physicalOutput: false, reversible: true },
};

const definition = {
  id: '${id}',
  version: '${version}',
  deviceClass: 'sensor.custom',
  capabilities: [capability],
  capabilityNames: ['sensor.read'],
  policies: [],
  supportedTransportKinds: ['simulated'],
  createSimulatedBackend() {
    return {
      kind: 'simulated',
      async invoke(action) {
        if (action !== 'sensor.read') {
          throw new Error('unknown capability ' + action);
        }
        return { value: 21.5 };
      },
      async close() {},
      subscribe() {
        return () => {};
      },
    };
  },
};

export default definition;
`;
}

export const FIXED_PUBLISHED_AT = '2026-10-17T00:00:00.000Z';

/**
 * Build a registry entry whose hashes match the given module directory.
 * Signature/publisher are left out unless explicitly overridden.
 */
export function registryEntryFor(
  directory: string,
  overrides: Partial<RegistryModuleEntry> = {},
): RegistryModuleEntry {
  const manifest = readModuleManifestJson(directory) as Record<string, unknown>;
  const id = String(manifest['id']);
  const version = String(manifest['version']);
  const description =
    typeof manifest['description'] === 'string' ? manifest['description'] : `${id} module`;
  const runtime = typeof manifest['runtime'] === 'string' ? manifest['runtime'] : 'node';
  return {
    name: id,
    version,
    description,
    manifestHash: computeManifestHash(manifest),
    contentHash: computeContentHash(directory),
    status: 'UNVERIFIED',
    targets: [runtime],
    url: `modules/${id.replace('/', '-')}@${version}`,
    publishedAt: FIXED_PUBLISHED_AT,
    ...overrides,
  };
}

/** Write a `registry.json` index document and return its path. */
export function writeRegistryIndex(
  registryDir: string,
  entries: RegistryModuleEntry[],
  options: { name?: string } = {},
): string {
  mkdirSync(registryDir, { recursive: true });
  const document: Record<string, unknown> = { schemaVersion: 1, modules: entries };
  if (options.name !== undefined) document['name'] = options.name;
  const indexPath = join(registryDir, 'registry.json');
  writeFileSync(indexPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return indexPath;
}

