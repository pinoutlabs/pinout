/**
 * Structured registry errors (registry v0).
 *
 * Every failure in the registry package is a `RegistryError` with a stable
 * `code`. Codes are part of the public contract so CLI/MCP/tests can branch on
 * them without parsing prose. This mirrors the `PinoutError` code style used by
 * `@pinout/core`.
 */
import { PinoutError } from '@pinout/core';

export type RegistryErrorCode =
  /** Registry index is missing, not JSON, or fails strict schema validation. */
  | 'REGISTRY_INDEX_INVALID'
  /** Registry source or requested module/version was not found. */
  | 'REGISTRY_NOT_FOUND'
  /** Fetching a registry document over the Fetcher seam failed. */
  | 'REGISTRY_FETCH_FAILED'
  /** Publishing requires a writable local index; remote indexes are read-only. */
  | 'REGISTRY_READ_ONLY'
  /** Version range string is not part of the supported grammar. */
  | 'RANGE_INVALID'
  /** No entry in the registry matches the requested module name. */
  | 'MODULE_NOT_FOUND'
  /** Module directory or payload source is missing or malformed. */
  | 'MODULE_SOURCE_INVALID'
  /** `packModule` options are inconsistent (for example publisher without signer). */
  | 'MODULE_PACK_INVALID'
  /** Remote/local payload document (`payload.json`) is malformed. */
  | 'MODULE_PAYLOAD_INVALID'
  /** Recomputed hash does not match the registry entry. */
  | 'MODULE_HASH_MISMATCH'
  /** Directory manifest id/version does not match the registry entry. */
  | 'MODULE_METADATA_MISMATCH'
  /** Ed25519 signature did not verify against the supplied key. */
  | 'MODULE_SIGNATURE_INVALID'
  /** Signature requirement or publisher allowlist rejected the entry. */
  | 'MODULE_UNTRUSTED'
  /** Destination already exists and `--force` was not passed. */
  | 'MODULE_ALREADY_PRESENT'
  /** Index already contains `(name, version)`. */
  | 'MODULE_ALREADY_PUBLISHED'
  /** Filesystem/copy failure while installing. */
  | 'MODULE_INSTALL_FAILED'
  /** Module did not reach the required conformance level. */
  | 'CONFORMANCE_FAILED';

export class RegistryError extends PinoutError {
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: RegistryErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.details = details;
  }
}

export function isRegistryError(value: unknown): value is RegistryError {
  return value instanceof RegistryError;
}
