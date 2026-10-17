import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistryClient } from '../src/client.js';
import type { Fetcher } from '../src/client.js';
import { RegistryError } from '../src/errors.js';
import type { RegistryModuleEntry } from '../src/indexFormat.js';

const HASH = 'a'.repeat(64);

function entry(overrides: Partial<RegistryModuleEntry> & { name: string; version: string }): RegistryModuleEntry {
  return {
    description: `${overrides.name} module`,
    manifestHash: HASH,
    contentHash: HASH,
    status: 'UNVERIFIED',
    targets: ['node'],
    url: `modules/${overrides.name.replace('/', '-')}@${overrides.version}`,
    publishedAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

function indexDocument(modules: RegistryModuleEntry[]): string {
  return `${JSON.stringify({ schemaVersion: 1, name: 'test-registry', modules }, null, 2)}\n`;
}

function fakeFetcher(routes: Record<string, string>): { fetcher: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const fetcher: Fetcher = async (url) => {
    requested.push(url);
    const body = routes[url];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetcher, requested };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinout-registry-client-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RegistryClient — local sources (offline)', () => {
  it('resolves versions with the supported range grammar', async () => {
    const registryDir = join(dir, 'registry');
    const index = [
      entry({ name: 'test/thermo', version: '0.1.0' }),
      entry({ name: 'test/thermo', version: '0.2.0' }),
      entry({ name: 'test/thermo', version: '1.0.0' }),
      entry({ name: 'test/relay', version: '1.2.3' }),
    ];
    mkdirSafe(registryDir);
    writeFileSync(join(registryDir, 'registry.json'), indexDocument(index), 'utf8');
    const client = new RegistryClient({ source: registryDir });

    expect((await client.resolve('test/thermo')).version).toBe('1.0.0');
    expect((await client.resolve('test/thermo', '^0.1.0')).version).toBe('0.2.0');
    expect((await client.resolve('test/thermo', '~0.1.0')).version).toBe('0.1.0');
    expect((await client.resolve('test/thermo', '0.1.0')).version).toBe('0.1.0');
  });

  it('reports missing modules and unsatisfiable ranges', async () => {
    const registryDir = join(dir, 'registry');
    mkdirSafe(registryDir);
    writeFileSync(
      join(registryDir, 'registry.json'),
      indexDocument([entry({ name: 'test/thermo', version: '0.1.0' })]),
      'utf8',
    );
    const client = new RegistryClient({ source: registryDir });
    await expect(client.resolve('test/missing')).rejects.toMatchObject({
      code: 'MODULE_NOT_FOUND',
    });
    await expect(client.resolve('test/thermo', '^2.0.0')).rejects.toMatchObject({
      code: 'MODULE_NOT_FOUND',
    });
    await expect(client.resolve('test/thermo', '>=1.0.0')).rejects.toMatchObject({
      code: 'RANGE_INVALID',
    });
  });

  it('lists, sorts, and searches deterministically', async () => {
    const registryDir = join(dir, 'registry');
    mkdirSafe(registryDir);
    writeFileSync(
      join(registryDir, 'registry.json'),
      indexDocument([
        entry({ name: 'test/thermo', version: '0.1.0' }),
        entry({ name: 'test/thermo', version: '0.2.0' }),
        entry({ name: 'acme/relay', version: '1.0.0', description: 'Industrial relay board' }),
      ]),
      'utf8',
    );
    const client = new RegistryClient({ source: registryDir });
    const listed = await client.list();
    expect(listed.map((item) => `${item.name}@${item.version}`)).toEqual([
      'acme/relay@1.0.0',
      'test/thermo@0.2.0',
      'test/thermo@0.1.0',
    ]);
    expect((await client.search('relay')).map((item) => item.name)).toEqual(['acme/relay']);
    expect(await client.search('nothing-matches')).toEqual([]);
    expect((await client.search('')).length).toBe(3);
  });

  it('accepts a direct index file path and a file: URL', async () => {
    const indexPath = join(dir, 'custom-index.json');
    writeFileSync(indexPath, indexDocument([entry({ name: 'test/thermo', version: '1.0.0' })]), 'utf8');
    expect((await new RegistryClient({ source: indexPath }).list()).length).toBe(1);
    expect((await new RegistryClient({ source: `file://${indexPath}` }).list()).length).toBe(1);
  });

  it('throws REGISTRY_NOT_FOUND for missing sources and missing indexes', async () => {
    expect(() => new RegistryClient({ source: join(dir, 'nope') })).toThrow(RegistryError);
    const emptyDir = join(dir, 'empty');
    mkdirSafe(emptyDir);
    const client = new RegistryClient({ source: emptyDir });
    await expect(client.loadIndex()).rejects.toMatchObject({ code: 'REGISTRY_NOT_FOUND' });
  });

  it('surfaces invalid index JSON as REGISTRY_INDEX_INVALID', async () => {
    const registryDir = join(dir, 'registry');
    mkdirSafe(registryDir);
    writeFileSync(join(registryDir, 'registry.json'), '{not json', 'utf8');
    const client = new RegistryClient({ source: registryDir });
    await expect(client.loadIndex()).rejects.toMatchObject({ code: 'REGISTRY_INDEX_INVALID' });
  });

  it('resolves entry locations relative to the index', async () => {
    const registryDir = join(dir, 'registry');
    mkdirSafe(registryDir);
    const localEntry = entry({ name: 'test/thermo', version: '1.0.0' });
    writeFileSync(join(registryDir, 'registry.json'), indexDocument([localEntry]), 'utf8');
    const client = new RegistryClient({ source: registryDir });
    expect(client.resolveEntryLocation(localEntry)).toEqual({
      kind: 'local',
      path: join(registryDir, 'modules/test-thermo@1.0.0'),
    });

    const absolute = entry({
      name: 'test/abs',
      version: '1.0.0',
      url: join(dir, 'elsewhere'),
    });
    expect(client.resolveEntryLocation(absolute)).toEqual({
      kind: 'local',
      path: join(dir, 'elsewhere'),
    });

    const fileUrl = entry({
      name: 'test/file',
      version: '1.0.0',
      url: `file://${join(dir, 'file-payload')}`,
    });
    expect(client.resolveEntryLocation(fileUrl)).toEqual({
      kind: 'local',
      path: join(dir, 'file-payload'),
    });
  });

  it('caches the index until refresh()', async () => {
    const registryDir = join(dir, 'registry');
    mkdirSafe(registryDir);
    const indexPath = join(registryDir, 'registry.json');
    writeFileSync(indexPath, indexDocument([entry({ name: 'test/thermo', version: '1.0.0' })]), 'utf8');
    const client = new RegistryClient({ source: registryDir });
    await client.loadIndex();
    writeFileSync(indexPath, indexDocument([]), 'utf8');
    expect((await client.list()).length).toBe(1);
    client.refresh();
    expect((await client.list()).length).toBe(0);
  });
});

describe('RegistryClient — remote sources through the Fetcher seam', () => {
  const indexUrl = 'https://registry.test/registry.json';

  it('lists and resolves entries from a fake https index', async () => {
    const { fetcher, requested } = fakeFetcher({
      [indexUrl]: indexDocument([
        entry({ name: 'test/thermo', version: '1.0.0' }),
        entry({ name: 'test/thermo', version: '1.1.0' }),
      ]),
    });
    const client = new RegistryClient({ source: indexUrl, fetcher });
    expect((await client.list()).length).toBe(2);
    expect((await client.resolve('test/thermo', '^1.0.0')).version).toBe('1.1.0');
    expect(requested.length).toBe(1);
  });

  it('resolves relative entry urls against the index url', () => {
    const client = new RegistryClient({
      source: 'https://registry.test/registry.json',
      fetcher: fakeFetcher({}).fetcher,
    });
    expect(client.resolveEntryLocation(entry({ name: 'test/thermo', version: '1.0.0' }))).toEqual({
      kind: 'remote',
      url: 'https://registry.test/modules/test-thermo@1.0.0',
    });
    expect(
      client.resolveEntryLocation(
        entry({ name: 'test/thermo', version: '1.0.0', url: 'https://cdn.test/a/b' }),
      ),
    ).toEqual({ kind: 'remote', url: 'https://cdn.test/a/b' });
  });

  it('maps fetch failures to structured errors', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('connection refused');
    };
    const client = new RegistryClient({ source: indexUrl, fetcher });
    await expect(client.loadIndex()).rejects.toMatchObject({ code: 'REGISTRY_FETCH_FAILED' });

    const notFound = new RegistryClient({
      source: indexUrl,
      fetcher: async () => ({ ok: false, status: 404, text: async () => '' }),
    });
    await expect(notFound.loadIndex()).rejects.toMatchObject({ code: 'REGISTRY_NOT_FOUND' });
  });
});

function mkdirSafe(path: string): void {
  mkdirSync(path, { recursive: true });
}
