/**
 * Module installation (registry v0).
 *
 * Flow: resolve entry -> materialize payload into a temp directory inside
 * `outDir` -> verify hashes/signature under the trust policy -> atomically
 * rename to `outDir/<vendor>__<name>@<version>`.
 *
 * Payload rules (documented):
 *  - Local directory sources are copied with the pack ignore rules.
 *  - Local file sources must be a payload document (`payload.json`), whose
 *    `files` list is resolved relative to the document.
 *  - Remote sources fetch `<entry-url>/payload.json` (or the URL itself when it
 *    ends in `.json`), then each listed file relative to it.
 *  - Entry names and versions are validated against the index patterns before
 *    any path is constructed; payload paths are re-checked for traversal.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { ModuleSignature } from '@pinout/module-host';
import {
  assertSafeRelativePath,
  copyModuleDirectory,
  hasExcludedSegment,
  MODULE_MANIFEST_FILENAME,
  safeJoinWithin,
  sanitizeModuleIdForPath,
} from './content.js';
import { RegistryError } from './errors.js';
import type { Fetcher, FetcherResponse, RegistryClient } from './client.js';
import {
  MODULE_ID_PATTERN,
  REGISTRY_SEMVER_PATTERN,
  type RegistryModuleEntry,
} from './indexFormat.js';
import {
  throwIfVerificationFailed,
  verifyEntry,
  type EntryVerification,
  type TrustedPublisherKey,
} from './verify.js';

export interface InstallTarget {
  name: string;
  range: string;
}

export interface InstallOptions {
  /** Directory that receives `<vendor>__<name>@<version>`. */
  outDir: string;
  /** Replace an existing installation. */
  force?: boolean;
  /** Fail when the entry is unsigned or untrusted. */
  requireSignature?: boolean;
  /** Single trusted PEM key. */
  publisherKey?: string;
  /** Candidate publisher keys, optionally restricted by publisher id. */
  allowlist?: TrustedPublisherKey[];
}

export interface InstallResult {
  path: string;
  entry: RegistryModuleEntry;
  verification: EntryVerification;
  files: string[];
}

export function parseInstallTarget(target: string): InstallTarget {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new RegistryError('MODULE_SOURCE_INVALID', 'Install target must not be empty.');
  }
  const at = trimmed.indexOf('@');
  if (at === -1) return { name: trimmed, range: '*' };
  const name = trimmed.slice(0, at);
  if (name.length === 0) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Install target '${target}' is missing the module name before '@'.`,
    );
  }
  const range = trimmed.slice(at + 1);
  return { name, range: range.length === 0 ? '*' : range };
}

/** `vendor/name@1.2.3` -> `vendor__name@1.2.3` (validated, no separators). */
export function moduleInstallDirectoryName(name: string, version: string): string {
  if (!MODULE_ID_PATTERN.test(name)) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Refusing to install invalid module id '${name}' (expected 'vendor/name').`,
    );
  }
  if (!REGISTRY_SEMVER_PATTERN.test(version)) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Refusing to install invalid version '${version}' (expected full semantic version).`,
    );
  }
  return `${sanitizeModuleIdForPath(name)}@${version}`;
}

export async function installModule(
  client: RegistryClient,
  target: string | InstallTarget,
  options: InstallOptions,
): Promise<InstallResult> {
  const resolvedTarget: InstallTarget =
    typeof target === 'string' ? parseInstallTarget(target) : { ...target };
  const entry = await client.resolve(resolvedTarget.name, resolvedTarget.range);
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const finalPath = join(outDir, moduleInstallDirectoryName(entry.name, entry.version));
  if (existsSync(finalPath) && options.force !== true) {
    throw new RegistryError(
      'MODULE_ALREADY_PRESENT',
      `'${entry.name}@${entry.version}' is already installed at '${finalPath}'. Pass force to replace it.`,
      { path: finalPath },
    );
  }
  const tempPath = join(outDir, `.tmp-${randomUUID()}`);
  try {
    const files = await materializeEntry(client, entry, tempPath);
    const verification = verifyEntry(tempPath, entry, {
      ...(options.publisherKey !== undefined ? { publisherKey: options.publisherKey } : {}),
      ...(options.allowlist !== undefined ? { allowlist: options.allowlist } : {}),
      requireSignature: options.requireSignature === true,
    });
    throwIfVerificationFailed(verification);
    writeSignatureFile(tempPath, entry);
    if (existsSync(finalPath)) {
      rmSync(finalPath, { recursive: true, force: true });
    }
    renameSync(tempPath, finalPath);
    return { path: finalPath, entry, verification, files };
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true });
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(
      'MODULE_INSTALL_FAILED',
      `Failed to install '${entry.name}@${entry.version}': ${error instanceof Error ? error.message : String(error)}`,
      { name: entry.name, version: entry.version },
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export async function materializeEntry(
  client: RegistryClient,
  entry: RegistryModuleEntry,
  destination: string,
): Promise<string[]> {
  mkdirSync(destination, { recursive: true });
  const location = client.resolveEntryLocation(entry);
  if (location.kind === 'local') {
    const stats = statSyncSafe(location.path);
    if (stats?.isDirectory()) {
      if (!existsSync(join(location.path, MODULE_MANIFEST_FILENAME))) {
        throw new RegistryError(
          'MODULE_SOURCE_INVALID',
          `Module source '${location.path}' has no ${MODULE_MANIFEST_FILENAME}.`,
        );
      }
      return copyModuleDirectory(location.path, destination);
    }
    if (stats?.isFile()) {
      const document = parsePayloadDocument(readFileSync(location.path, 'utf8'), location.path);
      return materializePayloadDocument(
        document,
        dirname(location.path),
        null,
        destination,
        client.fetcher,
      );
    }
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Module payload '${location.path}' does not exist.`,
    );
  }

  if (!/^https?:\/\//.test(location.url)) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Remote registry entry '${entry.name}' resolved to unsupported URL '${location.url}'.`,
    );
  }
  const base = location.url.endsWith('.json')
    ? location.url
    : `${location.url.replace(/\/+$/, '')}/payload.json`;
  const fetcher = client.fetcher;
  const response = await fetcher(base);
  if (!response.ok) {
    throw new RegistryError(
      'REGISTRY_FETCH_FAILED',
      `Failed to fetch module payload '${base}' (status ${response.status}).`,
      { url: base, status: response.status },
    );
  }
  const document = parsePayloadDocument(await response.text(), base);
  const directoryUrl = new URL('.', base).toString();
  return materializePayloadDocument(document, null, directoryUrl, destination, fetcher);
}

interface PayloadDocument {
  schemaVersion: 1;
  files: string[];
}

export function parsePayloadDocument(text: string, label: string): PayloadDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `Payload document '${label}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `Payload document '${label}' must be an object.`,
    );
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'schemaVersion' && key !== 'files');
  if (unknown.length > 0) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `Payload document '${label}' has unknown field '${unknown[0]}'.`,
    );
  }
  if (record['schemaVersion'] !== 1) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `Payload document '${label}' must have schemaVersion 1.`,
    );
  }
  const files = record['files'];
  if (!Array.isArray(files) || files.length === 0) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `Payload document '${label}' must list at least one file.`,
    );
  }
  for (const [index, file] of files.entries()) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new RegistryError(
        'MODULE_PAYLOAD_INVALID',
        `Payload document '${label}' files[${index}] must be a non-empty string.`,
      );
    }
    assertSafeRelativePath(file, `Payload document '${label}' files[${index}]`);
  }
  if (!files.includes(MODULE_MANIFEST_FILENAME)) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `Payload document '${label}' must include ${MODULE_MANIFEST_FILENAME}.`,
    );
  }
  return { schemaVersion: 1, files: [...(files as string[])] };
}

async function materializePayloadDocument(
  document: PayloadDocument,
  localBaseDir: string | null,
  remoteBaseUrl: string | null,
  destination: string,
  fetcher: Fetcher,
): Promise<string[]> {
  const written: string[] = [];
  for (const relativePath of document.files) {
    assertSafeRelativePath(relativePath, 'payload file');
    if (hasExcludedSegment(relativePath)) {
      throw new RegistryError(
        'MODULE_PAYLOAD_INVALID',
        `Payload lists excluded path '${relativePath}'.`,
      );
    }
    const target = safeJoinWithin(destination, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    if (localBaseDir !== null) {
      const source = safeJoinWithin(localBaseDir, relativePath);
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new RegistryError(
          'MODULE_SOURCE_INVALID',
          `Payload file '${relativePath}' is missing at '${source}'.`,
        );
      }
      copyFileSync(source, target);
    } else {
      if (remoteBaseUrl === null) {
        throw new RegistryError('MODULE_PAYLOAD_INVALID', 'Internal error: no remote base URL.');
      }
      const url = new URL(relativePath, remoteBaseUrl).toString();
      let response: FetcherResponse;
      try {
        response = await fetcher(url);
      } catch (error) {
        throw new RegistryError(
          'REGISTRY_FETCH_FAILED',
          `Failed to fetch '${url}': ${error instanceof Error ? error.message : String(error)}`,
          { url },
        );
      }
      if (!response.ok) {
        throw new RegistryError(
          'REGISTRY_FETCH_FAILED',
          `Failed to fetch '${url}' (status ${response.status}).`,
          { url, status: response.status },
        );
      }
      if (response.arrayBuffer) {
        writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
      } else {
        writeFileSync(target, await response.text(), 'utf8');
      }
    }
    written.push(relativePath);
  }
  return written.sort((a, b) => a.localeCompare(b));
}

function writeSignatureFile(directory: string, entry: RegistryModuleEntry): void {
  if (entry.signature === undefined || entry.publisher === undefined) return;
  const signature: ModuleSignature = {
    version: 1,
    publisher: entry.publisher,
    algorithm: 'ed25519',
    manifestHash: entry.manifestHash,
    contentHash: entry.contentHash,
    signature: entry.signature,
  };
  writeFileSync(
    join(directory, 'pinout.module.sig'),
    `${JSON.stringify(signature, null, 2)}\n`,
    'utf8',
  );
}

function statSyncSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
