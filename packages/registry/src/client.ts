/**
 * Registry client (v0) — offline-first.
 *
 * Primary source: a local directory containing `registry.json` (or a direct
 * path to an index file, or a `file:` URL). Secondary source: an `https://`
 * index URL loaded through the `Fetcher` seam (`fetch` is never called unless a
 * remote source is used, so tests are deterministic and offline).
 *
 * Entry `url` values may be absolute URLs, `file:` URLs, absolute paths, or
 * paths relative to the index location. `resolveEntryLocation` performs that
 * resolution without touching the network or the filesystem.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RegistryError } from './errors.js';
import {
  isValidRange,
  selectBestVersion,
  compareSemver,
  parseVersionRange,
} from './semver.js';
import {
  parseRegistryIndexText,
  REGISTRY_INDEX_FILENAME,
  type RegistryIndex,
  type RegistryModuleEntry,
} from './indexFormat.js';

export interface FetcherResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Optional; when present, install uses it so payloads keep exact bytes. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type Fetcher = (url: string) => Promise<FetcherResponse>;

/** Default fetcher: `file:` URLs via node:fs, everything else via global fetch. */
export const nodeFetcher: Fetcher = async (url) => {
  if (url.startsWith('file:')) {
    try {
      const text = await readFile(fileURLToPath(url), 'utf8');
      return { ok: true, status: 200, text: async () => text };
    } catch {
      return {
        ok: false,
        status: 404,
        text: async () => '',
      };
    }
  }
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
};

export type RegistryIndexLocation =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; url: string };

export type EntryLocation = { kind: 'local'; path: string } | { kind: 'remote'; url: string };

export interface RegistryClientOptions {
  /** Local directory, index file path, `file:` URL, or `http(s)://` index URL. */
  source: string;
  fetcher?: Fetcher;
  /** Base directory for relative sources (defaults to `process.cwd()`). */
  cwd?: string;
}

export class RegistryClient {
  readonly source: string;
  readonly indexLocation: RegistryIndexLocation;
  readonly fetcher: Fetcher;
  private indexPromise: Promise<RegistryIndex> | null = null;

  constructor(options: RegistryClientOptions) {
    this.source = options.source;
    this.fetcher = options.fetcher ?? nodeFetcher;
    this.indexLocation = resolveIndexLocation(options.source, options.cwd ?? process.cwd());
  }

  /** Load and strictly validate the index (cached until `refresh()`). */
  loadIndex(): Promise<RegistryIndex> {
    if (!this.indexPromise) {
      this.indexPromise = this.fetchIndex().catch((error: unknown) => {
        this.indexPromise = null;
        throw error;
      });
    }
    return this.indexPromise;
  }

  refresh(): void {
    this.indexPromise = null;
  }

  async list(): Promise<RegistryModuleEntry[]> {
    const index = await this.loadIndex();
    return [...index.modules].sort(compareEntries);
  }

  async search(query: string): Promise<RegistryModuleEntry[]> {
    const needle = query.trim().toLowerCase();
    const entries = await this.list();
    if (needle.length === 0) return entries;
    return entries.filter((entry) => {
      const haystack = [
        entry.name,
        entry.version,
        entry.description,
        entry.publisher ?? '',
        ...entry.targets,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  /**
   * Resolve `name@range` to the highest matching entry.
   * Supported ranges: `*`, `x.y.z`, `^x.y.z`, `~x.y.z` (see `./semver.ts`).
   */
  async resolve(name: string, range = '*'): Promise<RegistryModuleEntry> {
    if (!isValidRange(range)) {
      throw new RegistryError(
        'RANGE_INVALID',
        `Unsupported version range '${range}'. Supported: '*', 'x.y.z', '^x.y.z', '~x.y.z'.`,
      );
    }
    const entries = await this.loadIndex();
    const matching = entries.modules.filter((entry) => entry.name === name);
    if (matching.length === 0) {
      throw new RegistryError(
        'MODULE_NOT_FOUND',
        `Module '${name}' is not present in registry '${this.source}'.`,
        { name, source: this.source },
      );
    }
    const best = selectBestVersion(
      matching.map((entry) => entry.version),
      range,
    );
    if (best === null) {
      throw new RegistryError(
        'MODULE_NOT_FOUND',
        `No version of '${name}' satisfies '${range}' in registry '${this.source}'.`,
        { name, range, source: this.source },
      );
    }
    const selected = matching.find((entry) => entry.version === best);
    if (!selected) {
      throw new RegistryError('MODULE_NOT_FOUND', `Internal resolution error for '${name}'.`);
    }
    return selected;
  }

  /** Resolve an entry's payload location (no filesystem or network access). */
  resolveEntryLocation(entry: RegistryModuleEntry): EntryLocation {
    const location = this.indexLocation;
    if (location.kind === 'remote') {
      return { kind: 'remote', url: new URL(entry.url, location.url).toString() };
    }
    const raw = entry.url;
    if (raw.startsWith('file:')) return { kind: 'local', path: fileURLToPath(raw) };
    if (isAbsolute(raw)) return { kind: 'local', path: raw };
    return { kind: 'local', path: resolve(dirname(location.path), raw) };
  }

  private async fetchIndex(): Promise<RegistryIndex> {
    const url =
      this.indexLocation.kind === 'local'
        ? pathToFileURL(this.indexLocation.path).href
        : this.indexLocation.url;
    let response: FetcherResponse;
    try {
      response = await this.fetcher(url);
    } catch (error) {
      throw new RegistryError(
        'REGISTRY_FETCH_FAILED',
        `Failed to fetch registry index '${url}': ${error instanceof Error ? error.message : String(error)}`,
        { url },
        { cause: error instanceof Error ? error : undefined },
      );
    }
    if (!response.ok) {
      throw new RegistryError(
        'REGISTRY_NOT_FOUND',
        `Registry index '${url}' is not available (status ${response.status}).`,
        { url, status: response.status },
      );
    }
    const text = await response.text();
    return parseRegistryIndexText(text, `Registry index '${url}'`);
  }
}

export function resolveIndexLocation(source: string, cwd = process.cwd()): RegistryIndexLocation {
  if (source.trim().length === 0) {
    throw new RegistryError('REGISTRY_NOT_FOUND', 'Registry source must not be empty.');
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { kind: 'remote', url: source };
  }
  const localPath = localPathFromSource(source, cwd);
  if (!existsSync(localPath)) {
    throw new RegistryError(
      'REGISTRY_NOT_FOUND',
      `Registry source '${source}' does not exist (looked for '${localPath}').`,
      { source, path: localPath },
    );
  }
  const stats = statSync(localPath);
  if (stats.isDirectory()) {
    return { kind: 'local', path: join(localPath, REGISTRY_INDEX_FILENAME) };
  }
  if (stats.isFile()) {
    return { kind: 'local', path: localPath };
  }
  throw new RegistryError(
    'REGISTRY_NOT_FOUND',
    `Registry source '${source}' is neither a file nor a directory.`,
  );
}

/** For publish: the directory that relative payload paths are resolved against. */
export function indexDirectory(location: RegistryIndexLocation): string | null {
  return location.kind === 'local' ? dirname(location.path) : null;
}

function localPathFromSource(source: string, cwd: string): string {
  const raw = source.startsWith('file:') ? fileURLToPath(source) : source;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function compareEntries(a: RegistryModuleEntry, b: RegistryModuleEntry): number {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return compareSemver(b.version, a.version);
}

/** Human-readable range description for CLI messages. */
export function describeRange(range: string): string {
  const parsed = parseVersionRange(range);
  if (!parsed) return `invalid range '${range}'`;
  switch (parsed.kind) {
    case 'any':
      return 'any version';
    case 'exact':
      return `version ${parsed.version}`;
    case 'caret':
      return `compatible with ${parsed.version}`;
    case 'tilde':
      return `patch-compatible with ${parsed.version}`;
  }
}
