/**
 * Registry index format v0 (strict).
 *
 * The index is a boring JSON document. Everything is required unless marked
 * optional, and unknown fields are rejected so format changes are deliberate:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "name": "acme-registry",
 *   "updatedAt": "2026-10-17T00:00:00.000Z",
 *   "modules": [
 *     {
 *       "name": "vendor/module",
 *       "version": "1.2.3",
 *       "description": "Human description",
 *       "publisher": "vendor",
 *       "manifestHash": "<64 lowercase hex sha256>",
 *       "contentHash": "<64 lowercase hex sha256>",
 *       "signature": "<base64 Ed25519 of `${manifestHash}:${contentHash}`>",
 *       "status": "L2",
 *       "targets": ["node"],
 *       "url": "modules/vendor-module-1.2.3",
 *       "publishedAt": "2026-10-17T00:00:00.000Z"
 *     }
 *   ]
 * }
 * ```
 *
 * Hash algorithms and the signature payload are defined by
 * `@pinout/module-host` (`contentHash` / `manifestHash` / Ed25519 over
 * `manifestHash:contentHash`), so registry hashes interoperate byte-for-byte
 * with `pinout module verify` / `pinout module sign`.
 */
import { CONFORMANCE_LEVELS, type ConformanceLevel } from '@pinout/module-host';
import { RegistryError } from './errors.js';

export const REGISTRY_INDEX_SCHEMA_VERSION = 1;
export const REGISTRY_INDEX_FILENAME = 'registry.json';

/** `UNVERIFIED` means "packed, no conformance evidence claimed" — never inflate. */
export type RegistryModuleStatus = ConformanceLevel | 'UNVERIFIED';

export const REGISTRY_MODULE_STATUSES: readonly RegistryModuleStatus[] = [
  ...CONFORMANCE_LEVELS,
  'UNVERIFIED',
];

/** Module ids mirror `@pinout/core`: `vendor/name`, lowercase, hyphens. */
export const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
/** Full semver only; see `./semver.ts` for the supported subset. */
export const REGISTRY_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
/** SHA-256 hex digest, lowercase (same algorithms as `@pinout/module-host`). */
export const REGISTRY_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** Base64 of a 64-byte Ed25519 signature (88 chars, `==` padded). */
export const REGISTRY_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
export const PUBLISHER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** ISO-8601 UTC timestamps only, e.g. `2026-10-17T12:00:00.000Z`. */
export const PUBLISHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export interface RegistryModuleEntry {
  /** Module id (`vendor/name`). */
  name: string;
  /** Full semantic version. */
  version: string;
  description: string;
  /** Publisher id; required when `signature` is present. */
  publisher?: string;
  /** SHA-256 of the canonical manifest JSON (see `./content.ts`). */
  manifestHash: string;
  /** SHA-256 of the canonical module file manifest (see `./content.ts`). */
  contentHash: string;
  /** Base64 Ed25519 signature over `${manifestHash}:${contentHash}`. */
  signature?: string;
  status: RegistryModuleStatus;
  /** Free-form target labels, e.g. `node`, `python`, `esp32`. */
  targets: string[];
  /** Payload location: absolute URL, `file:` URL, absolute path, or path relative to the index. */
  url: string;
  /** ISO-8601 UTC publish timestamp. */
  publishedAt: string;
}

export interface RegistryIndex {
  schemaVersion: typeof REGISTRY_INDEX_SCHEMA_VERSION;
  modules: RegistryModuleEntry[];
  /** Optional registry display name. */
  name?: string;
  /** Optional ISO-8601 UTC timestamp of the last index update. */
  updatedAt?: string;
}

export function registryEntryKey(name: string, version: string): string {
  return `${name}@${version}`;
}

const INDEX_FIELDS = new Set(['schemaVersion', 'modules', 'name', 'updatedAt']);
const ENTRY_FIELDS = new Set([
  'name',
  'version',
  'description',
  'publisher',
  'manifestHash',
  'contentHash',
  'signature',
  'status',
  'targets',
  'url',
  'publishedAt',
]);

export function validateRegistryIndex(value: unknown): asserts value is RegistryIndex {
  const record = expectRecord(value, 'Registry index');
  rejectUnknownFields(record, INDEX_FIELDS, 'registry index');
  if (record['schemaVersion'] !== REGISTRY_INDEX_SCHEMA_VERSION) {
    throw invalid(
      `Unsupported registry index schemaVersion '${String(record['schemaVersion'])}' (expected ${REGISTRY_INDEX_SCHEMA_VERSION}).`,
    );
  }
  const modules = record['modules'];
  if (!Array.isArray(modules)) {
    throw invalid("Registry index field 'modules' must be an array.");
  }
  if (record['name'] !== undefined) expectString(record['name'], 'registry index field name');
  if (record['updatedAt'] !== undefined)
    expectTimestamp(record['updatedAt'], 'registry index field updatedAt');
  const seen = new Set<string>();
  modules.forEach((entry, position) => {
    const validated = validateEntry(entry, position);
    const key = registryEntryKey(validated.name, validated.version);
    if (seen.has(key)) {
      throw invalid(`Duplicate registry entry '${key}'. Each (name, version) pair may appear once.`);
    }
    seen.add(key);
  });
}

export function parseRegistryIndex(raw: unknown): RegistryIndex {
  validateRegistryIndex(raw);
  return raw;
}

/** Parse index JSON text; JSON syntax errors become `REGISTRY_INDEX_INVALID`. */
export function parseRegistryIndexText(text: string, label = 'registry index'): RegistryIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRegistryIndex(parsed);
}

export function validateRegistryModuleEntry(entry: unknown, position: number): RegistryModuleEntry {
  return validateEntry(entry, position);
}

function validateEntry(value: unknown, position: number): RegistryModuleEntry {
  const label = `registry index module[${position}]`;
  const record = expectRecord(value, label);
  rejectUnknownFields(record, ENTRY_FIELDS, label);
  const name = expectString(record['name'], `${label} field name`);
  if (!MODULE_ID_PATTERN.test(name)) {
    throw invalid(`${label} has invalid module id '${name}' (expected 'vendor/name').`);
  }
  const version = expectString(record['version'], `${label} field version`);
  if (!REGISTRY_SEMVER_PATTERN.test(version)) {
    throw invalid(`${label} has invalid version '${version}' (expected full semantic version).`);
  }
  const description = expectString(record['description'], `${label} field description`);
  if (description.trim().length === 0) {
    throw invalid(`${label} field description must not be blank.`);
  }
  const manifestHash = expectString(record['manifestHash'], `${label} field manifestHash`);
  if (!REGISTRY_HASH_PATTERN.test(manifestHash)) {
    throw invalid(`${label} field manifestHash must be a lowercase sha256 hex digest.`);
  }
  const contentHash = expectString(record['contentHash'], `${label} field contentHash`);
  if (!REGISTRY_HASH_PATTERN.test(contentHash)) {
    throw invalid(`${label} field contentHash must be a lowercase sha256 hex digest.`);
  }
  const status = expectString(record['status'], `${label} field status`);
  if (!(REGISTRY_MODULE_STATUSES as readonly string[]).includes(status)) {
    throw invalid(
      `${label} field status must be one of ${REGISTRY_MODULE_STATUSES.join(', ')} (got '${status}').`,
    );
  }
  const targets = record['targets'];
  if (!Array.isArray(targets) || targets.length === 0) {
    throw invalid(`${label} field targets must be a non-empty array of strings.`);
  }
  targets.forEach((target, index) => {
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw invalid(`${label} field targets[${index}] must be a non-empty string.`);
    }
  });
  const url = expectString(record['url'], `${label} field url`);
  const publishedAt = expectString(record['publishedAt'], `${label} field publishedAt`);
  expectTimestamp(publishedAt, `${label} field publishedAt`);

  const publisher = record['publisher'] === undefined ? undefined : readPublisher(record['publisher'], label);
  const signature =
    record['signature'] === undefined ? undefined : readSignature(record['signature'], label);
  if (signature !== undefined && publisher === undefined) {
    throw invalid(`${label} provides a signature but no publisher; they must be published together.`);
  }
  if (publisher !== undefined && signature === undefined) {
    throw invalid(`${label} provides a publisher but no signature; they must be published together.`);
  }

  const result: RegistryModuleEntry = {
    name,
    version,
    description,
    manifestHash,
    contentHash,
    status: status as RegistryModuleStatus,
    targets: [...(targets as string[])],
    url,
    publishedAt,
  };
  if (publisher !== undefined) result.publisher = publisher;
  if (signature !== undefined) result.signature = signature;
  return result;
}

function readPublisher(value: unknown, label: string): string {
  const publisher = expectString(value, `${label} field publisher`);
  if (!PUBLISHER_ID_PATTERN.test(publisher)) {
    throw invalid(
      `${label} field publisher must match ${PUBLISHER_ID_PATTERN.source} (got '${publisher}').`,
    );
  }
  return publisher;
}

function readSignature(value: unknown, label: string): string {
  const signature = expectString(value, `${label} field signature`);
  if (!REGISTRY_SIGNATURE_PATTERN.test(signature)) {
    throw invalid(
      `${label} field signature must be the base64 encoding of a 64-byte Ed25519 signature.`,
    );
  }
  return signature;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${label} must be a non-empty string.`);
  }
  return value;
}

function expectTimestamp(value: unknown, label: string): string {
  const text = expectString(value, label);
  if (!PUBLISHED_AT_PATTERN.test(text)) {
    throw invalid(`${label} must be an ISO-8601 UTC timestamp like 2026-10-17T12:00:00.000Z.`);
  }
  if (Number.isNaN(Date.parse(text))) {
    throw invalid(`${label} is not a real date: '${text}'.`);
  }
  return text;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw invalid(
      `Unknown field '${unknown[0]}' in ${label}. The format is strict; update the schema deliberately.`,
    );
  }
}

function invalid(message: string): RegistryError {
  return new RegistryError('REGISTRY_INDEX_INVALID', message);
}
