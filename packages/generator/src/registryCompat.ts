/**
 * Registry compatibility checks for generated module directories.
 *
 * This helper validates the *layout* a generated candidate module must have to
 * be packable by `@pinout/registry`. It intentionally does NOT import the
 * registry package: `@pinout/registry` depends on `@pinout/core` (and the
 * generator depends on the registry), so importing it here could create a
 * cycle. The rules below are a deliberate copy of the pack contract; they are
 * asserted by `packages/generator/tests/registryCompat.test.ts` and the
 * duplications are tracked in `packages/registry/INTEGRATION_NOTES.md`.
 *
 * Pack contract (registry v0):
 *  - `pinout.module.json` must exist and parse (strict shape validation happens
 *    in the registry/`@pinout/core`).
 *  - `evidence/report.json` is emitted by `pinout generate`; it is part of the
 *    module content and must be present for generated modules.
 *  - Directories `node_modules`, `.git`, `coverage`, and `.pinout-cache` are
 *    never packed. `dist` is copied when installing (generated modules point
 *    their entrypoint at `./dist/index.js`) but is excluded from content
 *    hashing by `@pinout/module-host`, so it may be absent at pack time.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const GENERATED_MODULE_REQUIRED_ENTRIES: readonly string[] = [
  'pinout.module.json',
  'evidence/report.json',
];

/** Directories the registry never packs (mirrors `PACK_EXCLUDED_DIRECTORIES`). */
export const REGISTRY_PACK_EXCLUDED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'coverage',
  '.pinout-cache',
];

export interface GeneratedModuleManifestSummary {
  id: string | null;
  version: string | null;
  entrypoint: string | null;
  status: string | null;
}

export interface GeneratedModuleLayoutReport {
  directory: string;
  packable: boolean;
  requiredEntries: string[];
  missingEntries: string[];
  manifest: GeneratedModuleManifestSummary | null;
  /** True when the manifest entrypoint file exists (may be false before build). */
  entrypointPresent: boolean;
  entrypoint: string | null;
  notes: string[];
}

export function validateGeneratedModuleLayout(directory: string): GeneratedModuleLayoutReport {
  const root = resolve(directory);
  const notes: string[] = [];
  const missingEntries: string[] = [];
  const requiredEntries = [...GENERATED_MODULE_REQUIRED_ENTRIES];

  if (!existsPath(root) || !statSync(root).isDirectory()) {
    return {
      directory: root,
      packable: false,
      requiredEntries,
      missingEntries: requiredEntries,
      manifest: null,
      entrypointPresent: false,
      entrypoint: null,
      notes: [`Directory '${root}' does not exist.`],
    };
  }

  for (const relativePath of requiredEntries) {
    if (!existsSync(join(root, relativePath))) {
      missingEntries.push(relativePath);
    }
  }

  let manifest: GeneratedModuleManifestSummary | null = null;
  const manifestPath = join(root, 'pinout.module.json');
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest = {
        id: readString(raw['id']),
        version: readString(raw['version']),
        entrypoint: readString(raw['entrypoint']),
        status: readString(raw['status']),
      };
      if (manifest.id === null || manifest.version === null) {
        notes.push('Manifest is missing id/version; the registry will reject the pack.');
      }
    } catch (error) {
      notes.push(
        `pinout.module.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const entrypoint = manifest?.entrypoint ?? null;
  let entrypointPresent = false;
  if (entrypoint !== null) {
    entrypointPresent = existsSync(join(root, entrypoint));
    if (!entrypointPresent) {
      notes.push(
        `Entrypoint '${entrypoint}' is not built yet; run the module build before packing. (dist is copied but excluded from content hashing.)`,
      );
    }
  }

  notes.push(
    `Registry excludes ${REGISTRY_PACK_EXCLUDED_DIRECTORIES.join(', ')} from packs; evidence files are packed and hashed.`,
  );

  return {
    directory: root,
    packable:
      missingEntries.length === 0 &&
      manifest !== null &&
      manifest.id !== null &&
      manifest.version !== null,
    requiredEntries,
    missingEntries,
    manifest,
    entrypointPresent,
    entrypoint,
    notes,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function existsPath(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
