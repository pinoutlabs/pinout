/**
 * Deterministic module packing helpers.
 *
 * Hash parity rule (critical): `contentHash` and `manifestHash` are *delegated*
 * to `@pinout/module-host`, so a registry entry verifies with the same bytes as
 * `pinout module sign` / `pinout module verify`. Never re-implement the walk.
 *
 * Ignore rules (documented, and asserted by tests):
 *  - `HASH_EXCLUDED_DIRECTORIES` (`node_modules`, `dist`, `.git`, `coverage`,
 *    `.pinout-cache`) and `HASH_EXCLUDED_FILES` (`pinout.module.sig`) are the
 *    exclusions that `@pinout/module-host` applies when hashing. Registry code
 *    must not exclude anything else when hashing because the algorithms are
 *    shared.
 *  - When *copying* a module into a registry or install directory we exclude a
 *    SUBSET of the hash exclusions: `PACK_EXCLUDED_DIRECTORIES`. `dist` is
 *    intentionally copied (generated modules point their entrypoint at
 *    `./dist/index.js` and must stay runnable) even though it is not hashed.
 *  - Copy exclusion must remain a subset of hash exclusion. If a path is
 *    excluded from the copy but included in the hash, verification would fail
 *    after install. `INTEGRATION_NOTES.md` files are therefore copied (and
 *    hashed), not dropped.
 *  - Symbolic links and special files are skipped when copying and are not
 *    hashed by `@pinout/module-host` either.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  contentHash as moduleHostContentHash,
  manifestHash as moduleHostManifestHash,
} from '@pinout/module-host';
import { RegistryError } from './errors.js';

export const MODULE_MANIFEST_FILENAME = 'pinout.module.json';

/** Directories excluded when hashing, mirroring `@pinout/module-host`. */
export const HASH_EXCLUDED_DIRECTORIES: readonly string[] = [
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.pinout-cache',
];

/** Files excluded when hashing, mirroring `@pinout/module-host`. */
export const HASH_EXCLUDED_FILES: readonly string[] = ['pinout.module.sig'];

/** Directories excluded when copying/installing (subset of the hash exclusions). */
export const PACK_EXCLUDED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'coverage',
  '.pinout-cache',
];

/** SHA-256 over canonical JSON (sorted keys) of the manifest. */
export function computeManifestHash(manifest: unknown): string {
  return moduleHostManifestHash(manifest);
}

/** SHA-256 over the canonical module file manifest; same algorithm as module-host. */
export function computeContentHash(directory: string): string {
  return moduleHostContentHash(directory);
}

/** Parse `pinout.module.json` as JSON; shape validation belongs to `@pinout/core`. */
export function readModuleManifestJson(directory: string): unknown {
  const manifestPath = join(directory, MODULE_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Module directory '${directory}' has no ${MODULE_MANIFEST_FILENAME}.`,
    );
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isPackExcludedDirectory(name: string): boolean {
  return PACK_EXCLUDED_DIRECTORIES.includes(name);
}

/** True when any path segment is an excluded directory (e.g. `node_modules`). */
export function hasExcludedSegment(relativePath: string): boolean {
  return splitRelativePath(relativePath).some((segment) => isPackExcludedDirectory(segment));
}

/**
 * Relative POSIX paths of everything that would be copied for a module
 * directory, sorted. `dist` is included; `node_modules`/`.git`/`coverage`/
 * `.pinout-cache` and symlinks are not. Used both for copying and to build
 * remote `payload.json` documents.
 */
export function listPackableFiles(directory: string): string[] {
  const root = resolve(directory);
  const files: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isPackExcludedDirectory(entry.name)) continue;
        walk(join(current, entry.name));
      } else if (entry.isFile()) {
        files.push(toPosix(relative(root, join(current, entry.name))));
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Copy a module directory recursively into `destination` using the pack
 * ignore rules. Returns the copied relative paths. Symbolic links and special
 * files are skipped (they are also not hashed).
 */
export function copyModuleDirectory(source: string, destination: string): string[] {
  const sourceRoot = resolve(source);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new RegistryError(
      'MODULE_SOURCE_INVALID',
      `Module source directory '${source}' does not exist.`,
    );
  }
  mkdirSync(destination, { recursive: true });
  const copied: string[] = [];
  const walk = (current: string, target: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isPackExcludedDirectory(entry.name)) continue;
        const child = join(current, entry.name);
        const childTarget = join(target, entry.name);
        mkdirSync(childTarget, { recursive: true });
        walk(child, childTarget);
      } else if (entry.isFile()) {
        const child = join(current, entry.name);
        copyFileSync(child, join(target, entry.name));
        copied.push(toPosix(relative(resolve(destination), join(target, entry.name))));
      }
    }
  };
  walk(sourceRoot, resolve(destination));
  return copied.sort((a, b) => a.localeCompare(b));
}

/**
 * Reject absolute paths, `..` segments, backslashes, and empty segments.
 * Used for remote payload file lists and install-time path construction.
 */
export function assertSafeRelativePath(relativePath: string, label = 'relative path'): void {
  if (relativePath.length === 0) {
    throw new RegistryError('MODULE_PAYLOAD_INVALID', `${label} must not be empty.`);
  }
  if (isAbsolute(relativePath)) {
    throw new RegistryError('MODULE_PAYLOAD_INVALID', `${label} '${relativePath}' must be relative.`);
  }
  if (relativePath.includes('\\')) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `${label} '${relativePath}' must use forward slashes.`,
    );
  }
  for (const segment of splitRelativePath(relativePath)) {
    if (segment === '.' || segment === '..' || segment.length === 0) {
      throw new RegistryError(
        'MODULE_PAYLOAD_INVALID',
        `${label} '${relativePath}' contains an unsafe segment '${segment}'.`,
      );
    }
  }
}

/**
 * Join `relativePath` under `base` and assert the result stays inside `base`
 * (defense in depth against traversal, checked after normalization).
 */
export function safeJoinWithin(base: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const resolvedBase = resolve(base);
  const target = resolve(resolvedBase, fromPosix(relativePath));
  const rel = relative(resolvedBase, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RegistryError(
      'MODULE_PAYLOAD_INVALID',
      `Path '${relativePath}' escapes the target directory.`,
    );
  }
  return target;
}

/** `vendor/name` -> `vendor__name` (no separators, no traversal). */
export function sanitizeModuleIdForPath(name: string): string {
  return name.replace(/[\\/]/g, '__');
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function fromPosix(value: string): string {
  return value.split('/').join(sep);
}

function splitRelativePath(relativePath: string): string[] {
  return relativePath.split('/');
}

export function moduleDirectoryExists(directory: string): boolean {
  return existsSync(directory) && statSync(directory).isDirectory();
}
