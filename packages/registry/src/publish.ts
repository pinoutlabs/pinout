/**
 * Registry publishing (v0) — pure and key-store free.
 *
 * `packModule` never reads key stores: signing is an injected function
 * `(payload: Uint8Array) => string | Promise<string>` that must return a base64
 * Ed25519 signature over `${manifestHash}:${contentHash}` (the module-host
 * payload). `createPayloadSigner` builds that function from a PEM passed in by
 * the caller (the CLI reads `--sign-key`).
 *
 * `appendEntry` / `upsertEntry` are pure: they return a new validated index
 * object; the caller writes the file.
 */
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { resolve } from 'node:path';
import { parseModuleManifest, type PinoutModuleManifest } from '@pinout/core';
import {
  computeContentHash,
  computeManifestHash,
  listPackableFiles,
  readModuleManifestJson,
} from './content.js';
import { RegistryError } from './errors.js';
import {
  REGISTRY_SIGNATURE_PATTERN,
  registryEntryKey,
  validateRegistryIndex,
  type RegistryIndex,
  type RegistryModuleEntry,
  type RegistryModuleStatus,
  REGISTRY_MODULE_STATUSES,
} from './indexFormat.js';

export type ModuleSigner = (payload: Uint8Array) => string | Promise<string>;

export interface PackModuleOptions {
  /** Publisher id; required when `signer` is provided. */
  publisher?: string;
  /** Injected signer over the payload bytes; returns base64. */
  signer?: ModuleSigner;
  /** Defaults to now; pass explicitly for reproducible packs. */
  publishedAt?: string;
  /** Payload location; defaults to `modules/<id-with-dashes>@<version>`. */
  url?: string;
  /** Target labels; defaults to the manifest `runtime`. */
  targets?: string[];
  /** Defaults to the manifest description/name. */
  description?: string;
  /** Never inflate: defaults to `UNVERIFIED`. */
  status?: RegistryModuleStatus;
}

export interface PackedModule {
  entry: RegistryModuleEntry;
  /** Relative POSIX paths included in the pack (see `./content.ts`). */
  files: string[];
}

export async function packModule(
  directory: string,
  options: PackModuleOptions = {},
): Promise<PackedModule> {
  const moduleDir = resolve(directory);
  const rawManifest = readModuleManifestJson(moduleDir);
  let manifest: PinoutModuleManifest;
  try {
    manifest = parseModuleManifest(rawManifest);
  } catch (error) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Module manifest in '${moduleDir}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { directory: moduleDir },
      { cause: error instanceof Error ? error : undefined },
    );
  }

  if (options.publisher !== undefined && options.signer === undefined) {
    throw new RegistryError(
      'MODULE_PACK_INVALID',
      'A publisher id was provided without a signer; signatures and publishers must be published together.',
    );
  }
  if (options.signer !== undefined && options.publisher === undefined) {
    throw new RegistryError(
      'MODULE_PACK_INVALID',
      'A signer was provided without a publisher id.',
    );
  }
  if (options.status !== undefined && !REGISTRY_MODULE_STATUSES.includes(options.status)) {
    throw new RegistryError(
      'MODULE_PACK_INVALID',
      `Unsupported status '${String(options.status)}'; use ${REGISTRY_MODULE_STATUSES.join(', ')}.`,
    );
  }

  const manifestHash = computeManifestHash(manifest);
  const contentHash = computeContentHash(moduleDir);

  const description =
    options.description ?? manifest.description ?? manifest.name ?? `${manifest.id} module`;
  const targets = options.targets ?? [manifest.runtime];
  const url = options.url ?? `modules/${manifest.id.replace('/', '-')}@${manifest.version}`;
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const status: RegistryModuleStatus = options.status ?? 'UNVERIFIED';

  const entry: RegistryModuleEntry = {
    name: manifest.id,
    version: manifest.version,
    description,
    manifestHash,
    contentHash,
    status,
    targets: [...targets],
    url,
    publishedAt,
  };

  if (options.signer !== undefined && options.publisher !== undefined) {
    const signature = await options.signer(Buffer.from(`${manifestHash}:${contentHash}`, 'utf8'));
    if (typeof signature !== 'string' || !REGISTRY_SIGNATURE_PATTERN.test(signature)) {
      throw new RegistryError(
        'MODULE_PACK_INVALID',
        'The signer must return the base64 encoding of a 64-byte Ed25519 signature.',
      );
    }
    entry.publisher = options.publisher;
    entry.signature = signature;
  }

  validateEntryInIsolation(entry);
  return { entry, files: listPackableFiles(moduleDir) };
}

/** Append an entry to an index, returning a new validated index object. */
export function appendEntry(index: RegistryIndex, entry: RegistryModuleEntry): RegistryIndex {
  if (containsEntry(index, entry)) {
    throw new RegistryError(
      'MODULE_ALREADY_PUBLISHED',
      `Registry already contains '${registryEntryKey(entry.name, entry.version)}'.`,
      { name: entry.name, version: entry.version },
    );
  }
  const next: RegistryIndex = { ...index, modules: [...index.modules, entry] };
  validateRegistryIndex(next);
  return next;
}

/** Insert or replace an entry with the same `(name, version)`. */
export function upsertEntry(index: RegistryIndex, entry: RegistryModuleEntry): RegistryIndex {
  const key = registryEntryKey(entry.name, entry.version);
  const modules = index.modules.filter(
    (existing) => registryEntryKey(existing.name, existing.version) !== key,
  );
  modules.push(entry);
  const next: RegistryIndex = { ...index, modules };
  validateRegistryIndex(next);
  return next;
}

/** True when the index already contains the same `(name, version)`. */
export function containsEntry(index: RegistryIndex, entry: RegistryModuleEntry): boolean {
  const key = registryEntryKey(entry.name, entry.version);
  return index.modules.some(
    (existing) => registryEntryKey(existing.name, existing.version) === key,
  );
}

export function emptyRegistryIndex(name?: string): RegistryIndex {
  const index: RegistryIndex = { schemaVersion: 1, modules: [] };
  if (name !== undefined) index.name = name;
  return index;
}

export function createPayloadSigner(privateKeyPem: string): ModuleSigner {
  const key = createPrivateKey(privateKeyPem);
  return (payload) => edSign(null, Buffer.from(payload), key).toString('base64');
}

/** Derive the SPKI PEM public key for a private key (for self-verification). */
export function publicKeyPemFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

function validateEntryInIsolation(entry: RegistryModuleEntry): void {
  validateRegistryIndex({ schemaVersion: 1, modules: [entry] });
}
