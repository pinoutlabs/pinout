/**
 * Registry entry verification.
 *
 * Recomputes hashes with the exact algorithms from `@pinout/module-host` and
 * checks the Ed25519 signature that registry entries carry, under a trust
 * policy (`requireSignature`, publisher allowlist).
 *
 * Why `node:crypto` is used directly for the entry signature: `@pinout/module-host`
 * verifies signatures only from a `pinout.module.sig` file inside a directory
 * (`verifyModule`). Registry entries carry the signature in the index, so the
 * verify primitive is applied to the payload bytes here. The payload and key
 * handling are byte-compatible with module-host (`Ed25519(null, ...)` over
 * `${manifestHash}:${contentHash}`, base64 signature), and
 * `packages/registry/tests/verify.test.ts` asserts that interop explicitly.
 */
import { statSync } from 'node:fs';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import {
  computeContentHash,
  computeManifestHash,
  MODULE_MANIFEST_FILENAME,
  readModuleManifestJson,
} from './content.js';
import { RegistryError, type RegistryErrorCode } from './errors.js';
import type { RegistryModuleEntry } from './indexFormat.js';

export interface TrustedPublisherKey {
  /** When set, the key only applies to this publisher id. */
  publisher?: string;
  /** PEM-encoded Ed25519 public key. */
  pem: string;
}

export interface VerifyEntryOptions {
  /** Single trusted PEM key applied regardless of publisher id. */
  publisherKey?: string;
  /** Candidate keys, optionally restricted to specific publisher ids. */
  allowlist?: TrustedPublisherKey[];
  /** When true, unsigned or untrusted entries fail verification. */
  requireSignature?: boolean;
}

export type SignatureVerificationStatus = 'ABSENT' | 'VALID' | 'INVALID' | 'UNTRUSTED';

export interface EntryHashCheck {
  expected: string;
  /** Null when the value could not be computed (for example unparsable manifest). */
  actual: string | null;
  status: 'MATCH' | 'MISMATCH';
}

export interface EntryVerificationFailure {
  code: RegistryErrorCode;
  message: string;
}

export interface EntryVerification {
  ok: boolean;
  directory: string;
  name: string;
  version: string;
  manifestId: string | null;
  manifestVersion: string | null;
  metadata: 'MATCH' | 'MISMATCH' | 'UNKNOWN';
  hashes: {
    manifest: EntryHashCheck;
    content: EntryHashCheck;
  };
  signature: {
    status: SignatureVerificationStatus;
    publisher: string | null;
    checkedKeys: number;
    reason: string;
  };
  policy: {
    requireSignature: boolean;
    allowlistSize: number;
  };
  failures: EntryVerificationFailure[];
}

/**
 * Verify a module directory against a registry entry. Returns a structured
 * report; use `throwIfVerificationFailed` to turn failures into errors.
 */
export function verifyEntry(
  directory: string,
  entry: RegistryModuleEntry,
  options: VerifyEntryOptions = {},
): EntryVerification {
  if (!directoryExists(directory)) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Module directory '${directory}' does not exist.`,
    );
  }
  const failures: EntryVerificationFailure[] = [];
  const requireSignature = options.requireSignature === true;
  const allowlist = options.allowlist ?? [];

  let parsedManifest: unknown = null;
  let manifestError: string | null = null;
  try {
    parsedManifest = readModuleManifestJson(directory);
  } catch (error) {
    manifestError = error instanceof Error ? error.message : String(error);
  }

  const manifestId = readManifestString(parsedManifest, 'id');
  const manifestVersion = readManifestString(parsedManifest, 'version');
  let metadata: EntryVerification['metadata'] = 'UNKNOWN';
  if (parsedManifest !== null) {
    metadata =
      manifestId === entry.name && manifestVersion === entry.version ? 'MATCH' : 'MISMATCH';
    if (metadata === 'MISMATCH') {
      failures.push({
        code: 'MODULE_METADATA_MISMATCH',
        message: `Manifest declares '${manifestId ?? '(missing)'}@${manifestVersion ?? '(missing)'}' but the registry entry is '${entry.name}@${entry.version}'.`,
      });
    }
  } else {
    failures.push({
      code: 'MODULE_HASH_MISMATCH',
      message: `Cannot read ${MODULE_MANIFEST_FILENAME} in '${directory}': ${manifestError ?? 'unknown error'}`,
    });
  }

  const actualManifestHash = parsedManifest === null ? null : computeManifestHash(parsedManifest);
  const manifestCheck: EntryHashCheck = {
    expected: entry.manifestHash,
    actual: actualManifestHash,
    status: actualManifestHash === entry.manifestHash ? 'MATCH' : 'MISMATCH',
  };
  if (manifestCheck.status === 'MISMATCH') {
    failures.push({
      code: 'MODULE_HASH_MISMATCH',
      message: `Manifest hash mismatch for '${entry.name}@${entry.version}': expected ${entry.manifestHash}, actual ${actualManifestHash ?? '(unavailable)'}.`,
    });
  }

  let actualContentHash: string;
  try {
    actualContentHash = computeContentHash(directory);
  } catch (error) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Failed to hash module directory '${directory}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const contentCheck: EntryHashCheck = {
    expected: entry.contentHash,
    actual: actualContentHash,
    status: actualContentHash === entry.contentHash ? 'MATCH' : 'MISMATCH',
  };
  if (contentCheck.status === 'MISMATCH') {
    failures.push({
      code: 'MODULE_HASH_MISMATCH',
      message: `Content hash mismatch for '${entry.name}@${entry.version}': expected ${entry.contentHash}, actual ${actualContentHash}.`,
    });
  }

  const signature = verifySignature(entry, options, allowlist, requireSignature, failures);

  return {
    ok: failures.length === 0,
    directory,
    name: entry.name,
    version: entry.version,
    manifestId,
    manifestVersion,
    metadata,
    hashes: { manifest: manifestCheck, content: contentCheck },
    signature,
    policy: { requireSignature, allowlistSize: allowlist.length },
    failures,
  };
}

export function throwIfVerificationFailed(verification: EntryVerification): void {
  const first = verification.failures[0];
  if (!first) return;
  throw new RegistryError(first.code, first.message, {
    directory: verification.directory,
    name: verification.name,
    version: verification.version,
    failures: verification.failures,
  });
}

function verifySignature(
  entry: RegistryModuleEntry,
  options: VerifyEntryOptions,
  allowlist: TrustedPublisherKey[],
  requireSignature: boolean,
  failures: EntryVerificationFailure[],
): EntryVerification['signature'] {
  const publisher = entry.publisher ?? null;
  if (entry.signature === undefined) {
    if (requireSignature) {
      failures.push({
        code: 'MODULE_UNTRUSTED',
        message: `'${entry.name}@${entry.version}' is unsigned and --require-signature is in effect.`,
      });
    }
    return {
      status: 'ABSENT',
      publisher,
      checkedKeys: 0,
      reason: requireSignature
        ? 'Signature required but the entry is unsigned.'
        : 'Entry is unsigned; unsigned modules work locally but are never shown as verified.',
    };
  }

  const candidates: Array<{ label: string; pem: string }> = [];
  if (options.publisherKey) candidates.push({ label: 'publisher-key', pem: options.publisherKey });
  for (const trusted of allowlist) {
    if (trusted.publisher !== undefined && trusted.publisher !== publisher) continue;
    candidates.push({ label: trusted.publisher ?? '(any)', pem: trusted.pem });
  }

  const publisherAllowlisted =
    publisher !== null &&
    allowlist.some((trusted) => trusted.publisher === undefined || trusted.publisher === publisher);
  if (
    publisher !== null &&
    allowlist.length > 0 &&
    !publisherAllowlisted &&
    options.publisherKey === undefined
  ) {
    failures.push({
      code: 'MODULE_UNTRUSTED',
      message: `Publisher '${publisher}' is not in the allowlist; refusing '${entry.name}@${entry.version}'.`,
    });
    return {
      status: 'UNTRUSTED',
      publisher,
      checkedKeys: 0,
      reason: `Publisher '${publisher}' is not in the allowlist.`,
    };
  }

  if (candidates.length === 0) {
    const reason = `No key supplied for publisher '${publisher ?? '(unknown)'}'; signature cannot be trusted.`;
    if (requireSignature) {
      failures.push({
        code: 'MODULE_UNTRUSTED',
        message: `'${entry.name}@${entry.version}' is signed but no trusted key was supplied (${reason})`,
      });
    }
    return { status: 'UNTRUSTED', publisher, checkedKeys: 0, reason };
  }

  const payload = Buffer.from(`${entry.manifestHash}:${entry.contentHash}`, 'utf8');
  const signatureBytes = Buffer.from(entry.signature, 'base64');
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const valid = edVerify(null, payload, createPublicKey(candidate.pem), signatureBytes);
      if (valid) {
        return {
          status: 'VALID',
          publisher,
          checkedKeys: candidates.length,
          reason: `Signature verified with key '${candidate.label}'.`,
        };
      }
      errors.push(`key '${candidate.label}' did not verify`);
    } catch (error) {
      errors.push(
        `key '${candidate.label}' could not be used: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  failures.push({
    code: 'MODULE_SIGNATURE_INVALID',
    message: `Signature for '${entry.name}@${entry.version}' did not verify (${errors.join('; ')}).`,
  });
  return {
    status: 'INVALID',
    publisher,
    checkedKeys: candidates.length,
    reason: `Signature did not verify against ${candidates.length} supplied key(s).`,
  };
}

function readManifestString(manifest: unknown, key: string): string | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const value = (manifest as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function directoryExists(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}
