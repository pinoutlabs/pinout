import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePublisherKeyPair, signModule, verifyModule } from '@pinout/module-host';
import { RegistryClient, type Fetcher } from '../src/client.js';
import { copyModuleDirectory, readModuleManifestJson } from '../src/content.js';
import { RegistryError } from '../src/errors.js';
import type { RegistryModuleEntry } from '../src/indexFormat.js';
import {
  installModule,
  moduleInstallDirectoryName,
  parseInstallTarget,
  parsePayloadDocument,
} from '../src/install.js';
import { publicKeyPemFromPrivate } from '../src/publish.js';
import { registryEntryFor, writeRegistryIndex, writeStubModule } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinout-registry-install-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempEntries(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir).filter((name) => name.startsWith('.tmp-'));
}

function payloadDocument(files: string[]): string {
  return `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`;
}

/** Module directory + matching entry published as a local payload directory. */
function publishLocalModule(name = 'source'): {
  moduleDir: string;
  registryDir: string;
  entry: RegistryModuleEntry;
} {
  const moduleDir = join(dir, name);
  writeStubModule(moduleDir);
  const entry = registryEntryFor(moduleDir);
  const registryDir = join(dir, 'registry');
  copyModuleDirectory(moduleDir, join(registryDir, entry.url));
  writeRegistryIndex(registryDir, [entry]);
  return { moduleDir, registryDir, entry };
}

describe('install targets', () => {
  it('parses name[@range] with the default range', () => {
    expect(parseInstallTarget('test/thermo')).toEqual({ name: 'test/thermo', range: '*' });
    expect(parseInstallTarget('test/thermo@^0.1.0')).toEqual({
      name: 'test/thermo',
      range: '^0.1.0',
    });
    expect(parseInstallTarget('test/thermo@')).toEqual({ name: 'test/thermo', range: '*' });
    expect(() => parseInstallTarget('   ')).toThrow(RegistryError);
    expect(() => parseInstallTarget('@1.0.0')).toThrow(RegistryError);
  });

  it('builds vendor__name@version directory names and rejects invalid ids', () => {
    expect(moduleInstallDirectoryName('test/thermo', '1.0.0')).toBe('test__thermo@1.0.0');
    expect(() => moduleInstallDirectoryName('thermo', '1.0.0')).toThrow(RegistryError);
    expect(() => moduleInstallDirectoryName('test/thermo', '1.0')).toThrow(RegistryError);
  });
});

describe('installModule — local directories', () => {
  it('installs a local directory entry under vendor__name@version', async () => {
    const { registryDir, entry } = publishLocalModule();
    const outDir = join(dir, 'installed');
    const result = await installModule(new RegistryClient({ source: registryDir }), 'test/thermo', {
      outDir,
    });

    expect(result.path).toBe(join(outDir, 'test__thermo@0.1.0'));
    expect(result.path).toBe(join(outDir, moduleInstallDirectoryName(entry.name, entry.version)));
    expect(result.files).toEqual(['index.js', 'pinout.module.json']);
    expect(result.verification.ok).toBe(true);
    expect(existsSync(join(result.path, 'pinout.module.json'))).toBe(true);
    expect(existsSync(join(result.path, 'index.js'))).toBe(true);
    expect(existsSync(join(result.path, 'pinout.module.sig'))).toBe(false);
  });

  it('refuses existing installs unless force is passed; force replaces cleanly', async () => {
    const { registryDir } = publishLocalModule();
    const outDir = join(dir, 'installed');
    const client = new RegistryClient({ source: registryDir });
    const first = await installModule(client, 'test/thermo@0.1.0', { outDir });
    writeFileSync(join(first.path, 'stale.txt'), 'stale\n', 'utf8');

    await expect(installModule(client, 'test/thermo', { outDir })).rejects.toMatchObject({
      code: 'MODULE_ALREADY_PRESENT',
    });
    expect(existsSync(join(first.path, 'stale.txt'))).toBe(true);

    const forced = await installModule(client, 'test/thermo', { outDir, force: true });
    expect(existsSync(join(forced.path, 'stale.txt'))).toBe(false);
    expect(forced.verification.ok).toBe(true);
  });

  it('cleans up the temp directory when verification fails', async () => {
    const { registryDir, entry } = publishLocalModule();
    writeRegistryIndex(registryDir, [{ ...entry, contentHash: 'f'.repeat(64) }]);
    const outDir = join(dir, 'installed');

    await expect(
      installModule(new RegistryClient({ source: registryDir }), 'test/thermo', { outDir }),
    ).rejects.toMatchObject({ code: 'MODULE_HASH_MISMATCH' });

    expect(tempEntries(outDir)).toEqual([]);
    expect(existsSync(join(outDir, 'test__thermo@0.1.0'))).toBe(false);
  });

  it('reports missing payload sources as MODULE_SOURCE_INVALID', async () => {
    const { registryDir, entry } = publishLocalModule();
    writeRegistryIndex(registryDir, [{ ...entry, url: 'modules/absent@0.1.0' }]);

    await expect(
      installModule(new RegistryClient({ source: registryDir }), 'test/thermo', {
        outDir: join(dir, 'installed'),
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SOURCE_INVALID' });
  });
});

describe('installModule — payload documents', () => {
  it('installs from a local payload.json document', async () => {
    const moduleDir = join(dir, 'source');
    writeStubModule(moduleDir);
    mkdirSync(join(moduleDir, 'lib'), { recursive: true });
    writeFileSync(join(moduleDir, 'lib/extra.txt'), 'extra\n', 'utf8');
    const entry = registryEntryFor(moduleDir, { url: 'modules/wrapped/payload.json' });

    const payloadDir = join(dir, 'registry/modules/wrapped');
    copyModuleDirectory(moduleDir, payloadDir);
    writeFileSync(
      join(payloadDir, 'payload.json'),
      payloadDocument(['pinout.module.json', 'index.js', 'lib/extra.txt']),
      'utf8',
    );
    const registryDir = join(dir, 'registry');
    writeRegistryIndex(registryDir, [entry]);

    const result = await installModule(
      new RegistryClient({ source: registryDir }),
      'test/thermo',
      { outDir: join(dir, 'installed') },
    );
    expect(result.files).toEqual(['index.js', 'lib/extra.txt', 'pinout.module.json']);
    expect(result.verification.ok).toBe(true);
    expect(existsSync(join(result.path, 'payload.json'))).toBe(false);
    expect(readFileSync(join(result.path, 'lib/extra.txt'), 'utf8')).toBe('extra\n');
  });

  it('rejects malformed payload documents', () => {
    expect(() => parsePayloadDocument('{oops', 'test')).toThrow(RegistryError);
    expect(() => parsePayloadDocument('[]', 'test')).toThrow(RegistryError);
    expect(() => parsePayloadDocument('null', 'test')).toThrow(RegistryError);
    expect(() =>
      parsePayloadDocument('{"schemaVersion":1,"files":["pinout.module.json"],"extra":1}', 'test'),
    ).toThrow(RegistryError);
    expect(() =>
      parsePayloadDocument('{"schemaVersion":2,"files":["pinout.module.json"]}', 'test'),
    ).toThrow(RegistryError);
    expect(() => parsePayloadDocument('{"schemaVersion":1,"files":[]}', 'test')).toThrow(
      RegistryError,
    );
    expect(() =>
      parsePayloadDocument('{"schemaVersion":1,"files":["pinout.module.json","../evil"]}', 'test'),
    ).toThrow(RegistryError);
    expect(() =>
      parsePayloadDocument('{"schemaVersion":1,"files":["pinout.module.json",7]}', 'test'),
    ).toThrow(RegistryError);
    expect(() => parsePayloadDocument('{"schemaVersion":1,"files":["index.js"]}', 'test')).toThrow(
      /must include pinout\.module\.json/,
    );
  });

  it('rejects excluded paths and missing files listed by the document', async () => {
    const moduleDir = join(dir, 'source');
    writeStubModule(moduleDir);
    const payloadDir = join(dir, 'registry/modules/excluded');
    copyModuleDirectory(moduleDir, payloadDir);

    const registryDir = join(dir, 'registry');
    const excludedEntry = registryEntryFor(moduleDir, {
      url: 'modules/excluded/payload.json',
    });
    writeFileSync(
      join(payloadDir, 'payload.json'),
      payloadDocument(['pinout.module.json', 'node_modules/x.js']),
      'utf8',
    );
    writeRegistryIndex(registryDir, [excludedEntry]);
    await expect(
      installModule(new RegistryClient({ source: registryDir }), 'test/thermo', {
        outDir: join(dir, 'installed'),
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PAYLOAD_INVALID' });

    writeFileSync(
      join(payloadDir, 'payload.json'),
      payloadDocument(['pinout.module.json', 'missing.txt']),
      'utf8',
    );
    const missingEntry = registryEntryFor(moduleDir, { url: 'modules/excluded/payload.json' });
    writeRegistryIndex(registryDir, [missingEntry]);
    await expect(
      installModule(new RegistryClient({ source: registryDir }), 'test/thermo', {
        outDir: join(dir, 'installed'),
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SOURCE_INVALID' });
  });

  it('fetches remote payload documents and files through the fetcher seam', async () => {
    const indexUrl = 'https://registry.test/registry.json';
    const moduleDir = join(dir, 'remote-source');
    writeStubModule(moduleDir);
    const blob = Uint8Array.from([0, 1, 2, 3, 255]);
    mkdirSync(join(moduleDir, 'bin'), { recursive: true });
    writeFileSync(join(moduleDir, 'bin/blob.bin'), blob);
    const entry = registryEntryFor(moduleDir);
    const base = `https://registry.test/${entry.url}`;
    const routes: Record<string, string> = {
      [indexUrl]: `${JSON.stringify({ schemaVersion: 1, modules: [entry] }, null, 2)}\n`,
      [`${base}/payload.json`]: payloadDocument([
        'pinout.module.json',
        'index.js',
        'bin/blob.bin',
      ]),
      [`${base}/pinout.module.json`]: readFileSync(
        join(moduleDir, 'pinout.module.json'),
        'utf8',
      ),
      [`${base}/index.js`]: readFileSync(join(moduleDir, 'index.js'), 'utf8'),
    };
    const requested: string[] = [];
    const fetcher: Fetcher = async (url) => {
      requested.push(url);
      if (url.endsWith('.bin')) {
        const bytes = blob.buffer.slice(
          blob.byteOffset,
          blob.byteOffset + blob.byteLength,
        ) as ArrayBuffer;
        return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => bytes };
      }
      const body = routes[url];
      if (body === undefined) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => body };
    };

    const result = await installModule(new RegistryClient({ source: indexUrl, fetcher }), 'test/thermo', {
      outDir: join(dir, 'installed'),
    });
    expect(result.verification.ok).toBe(true);
    expect(requested).toContain(`${base}/payload.json`);
    expect(requested).toContain(`${base}/bin/blob.bin`);
    expect(readFileSync(join(result.path, 'bin/blob.bin')).equals(Buffer.from(blob))).toBe(true);
  });

  it('cleans up after a failed remote file fetch', async () => {
    const indexUrl = 'https://registry.test/registry.json';
    const moduleDir = join(dir, 'remote-source');
    writeStubModule(moduleDir);
    const entry = registryEntryFor(moduleDir);
    const base = `https://registry.test/${entry.url}`;
    const routes: Record<string, string> = {
      [indexUrl]: `${JSON.stringify({ schemaVersion: 1, modules: [entry] }, null, 2)}\n`,
      [`${base}/payload.json`]: payloadDocument(['pinout.module.json', 'index.js']),
      [`${base}/pinout.module.json`]: readFileSync(
        join(moduleDir, 'pinout.module.json'),
        'utf8',
      ),
    };
    const fetcher: Fetcher = async (url) => {
      const body = routes[url];
      if (body === undefined) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => body };
    };
    const outDir = join(dir, 'installed');

    await expect(
      installModule(new RegistryClient({ source: indexUrl, fetcher }), 'test/thermo', { outDir }),
    ).rejects.toMatchObject({ code: 'REGISTRY_FETCH_FAILED' });
    expect(tempEntries(outDir)).toEqual([]);
    expect(existsSync(join(outDir, 'test__thermo@0.1.0'))).toBe(false);
  });

  it('rejects remote entries that resolve to unsupported URLs', async () => {
    const indexUrl = 'https://registry.test/registry.json';
    const moduleDir = join(dir, 'remote-source');
    writeStubModule(moduleDir);
    const entry = registryEntryFor(moduleDir, { url: 'ftp://files.test/module' });
    const fetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        `${JSON.stringify({ schemaVersion: 1, modules: [entry] }, null, 2)}\n`,
    });

    await expect(
      installModule(new RegistryClient({ source: indexUrl, fetcher }), 'test/thermo', {
        outDir: join(dir, 'installed'),
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SOURCE_INVALID' });
  });
});

describe('installModule — signatures', () => {
  it('writes a pinout.module.sig that @pinout/module-host verifies', async () => {
    const moduleDir = join(dir, 'source');
    writeStubModule(moduleDir);
    const keys = generatePublisherKeyPair();
    const entry = registryEntryFor(moduleDir);
    const signature = signModule(moduleDir, readModuleManifestJson(moduleDir), 'acme', keys.privateKeyPem);
    const signedEntry: RegistryModuleEntry = {
      ...entry,
      publisher: 'acme',
      signature: signature.signature,
    };
    const registryDir = join(dir, 'registry');
    copyModuleDirectory(moduleDir, join(registryDir, entry.url));
    writeRegistryIndex(registryDir, [signedEntry]);

    expect(publicKeyPemFromPrivate(keys.privateKeyPem)).toBe(keys.publicKeyPem);
    const result = await installModule(
      new RegistryClient({ source: registryDir }),
      'test/thermo',
      { outDir: join(dir, 'installed'), publisherKey: keys.publicKeyPem },
    );

    const written = JSON.parse(
      readFileSync(join(result.path, 'pinout.module.sig'), 'utf8'),
    ) as Record<string, unknown>;
    expect(written).toEqual({
      version: 1,
      publisher: 'acme',
      algorithm: 'ed25519',
      manifestHash: entry.manifestHash,
      contentHash: entry.contentHash,
      signature: signature.signature,
    });
    expect(verifyModule(result.path, { acme: keys.publicKeyPem }).status).toBe('VERIFIED');
  });

  it('honors requireSignature and allowlist trust policies', async () => {
    const moduleDir = join(dir, 'source');
    writeStubModule(moduleDir);
    const keys = generatePublisherKeyPair();
    const entry = registryEntryFor(moduleDir);
    const signature = signModule(moduleDir, readModuleManifestJson(moduleDir), 'acme', keys.privateKeyPem);
    const signedEntry: RegistryModuleEntry = {
      ...entry,
      publisher: 'acme',
      signature: signature.signature,
    };
    const registryDir = join(dir, 'registry');
    copyModuleDirectory(moduleDir, join(registryDir, entry.url));
    writeRegistryIndex(registryDir, [signedEntry]);
    const client = new RegistryClient({ source: registryDir });

    await expect(
      installModule(client, 'test/thermo', {
        outDir: join(dir, 'required'),
        requireSignature: true,
      }),
    ).rejects.toMatchObject({ code: 'MODULE_UNTRUSTED' });

    const foreign = generatePublisherKeyPair();
    await expect(
      installModule(client, 'test/thermo', {
        outDir: join(dir, 'foreign'),
        allowlist: [{ publisher: 'acme', pem: foreign.publicKeyPem }],
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SIGNATURE_INVALID' });

    await expect(
      installModule(client, 'test/thermo', {
        outDir: join(dir, 'scoped'),
        allowlist: [{ publisher: 'other', pem: keys.publicKeyPem }],
      }),
    ).rejects.toMatchObject({ code: 'MODULE_UNTRUSTED' });

    const ok = await installModule(client, 'test/thermo', {
      outDir: join(dir, 'trusted'),
      requireSignature: true,
      allowlist: [{ publisher: 'acme', pem: keys.publicKeyPem }],
    });
    expect(ok.verification.signature.status).toBe('VALID');
  });
});
