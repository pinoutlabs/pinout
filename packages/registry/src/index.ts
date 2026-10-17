/**
 * @pinout/registry — offline-first module registry v0.
 *
 * Status: IMPLEMENTED (software-tested infrastructure). Local file/directory
 * registries are the primary, fully test-covered path. `https://` index URLs
 * are supported through the injectable `Fetcher` seam; tests use a fake. There
 * is no hosted registry service in this repository.
 */
export {
  RegistryError,
  isRegistryError,
  type RegistryErrorCode,
} from './errors.js';

export {
  REGISTRY_INDEX_SCHEMA_VERSION,
  REGISTRY_INDEX_FILENAME,
  REGISTRY_MODULE_STATUSES,
  MODULE_ID_PATTERN,
  REGISTRY_SEMVER_PATTERN,
  REGISTRY_HASH_PATTERN,
  REGISTRY_SIGNATURE_PATTERN,
  PUBLISHER_ID_PATTERN,
  PUBLISHED_AT_PATTERN,
  validateRegistryIndex,
  parseRegistryIndex,
  parseRegistryIndexText,
  validateRegistryModuleEntry,
  registryEntryKey,
  type RegistryIndex,
  type RegistryModuleEntry,
  type RegistryModuleStatus,
} from './indexFormat.js';

export {
  isValidSemver,
  parseSemver,
  compareSemver,
  parseVersionRange,
  isValidRange,
  satisfiesRange,
  selectBestVersion,
  type ParsedSemver,
  type VersionRange,
} from './semver.js';

export {
  MODULE_MANIFEST_FILENAME,
  HASH_EXCLUDED_DIRECTORIES,
  HASH_EXCLUDED_FILES,
  PACK_EXCLUDED_DIRECTORIES,
  computeManifestHash,
  computeContentHash,
  readModuleManifestJson,
  isPackExcludedDirectory,
  hasExcludedSegment,
  listPackableFiles,
  copyModuleDirectory,
  assertSafeRelativePath,
  safeJoinWithin,
  sanitizeModuleIdForPath,
  moduleDirectoryExists,
} from './content.js';

export {
  RegistryClient,
  nodeFetcher,
  resolveIndexLocation,
  indexDirectory,
  describeRange,
  type Fetcher,
  type FetcherResponse,
  type RegistryClientOptions,
  type RegistryIndexLocation,
  type EntryLocation,
} from './client.js';

export {
  verifyEntry,
  throwIfVerificationFailed,
  type VerifyEntryOptions,
  type TrustedPublisherKey,
  type EntryVerification,
  type EntryVerificationFailure,
  type EntryHashCheck,
  type SignatureVerificationStatus,
} from './verify.js';

export {
  installModule,
  materializeEntry,
  parseInstallTarget,
  moduleInstallDirectoryName,
  parsePayloadDocument,
  type InstallOptions,
  type InstallResult,
  type InstallTarget,
} from './install.js';

export {
  packModule,
  appendEntry,
  upsertEntry,
  containsEntry,
  emptyRegistryIndex,
  createPayloadSigner,
  publicKeyPemFromPrivate,
  type ModuleSigner,
  type PackModuleOptions,
  type PackedModule,
} from './publish.js';

export {
  evaluateModuleConformance,
  formatModuleConformanceReport,
  validateHardwareVerificationRecord,
  type HardwareVerificationRecord,
  type ModuleConformanceOptions,
  type ModuleConformanceReport,
  type ConformanceLane,
  type ConformanceCheckSummary,
} from './conformance.js';
