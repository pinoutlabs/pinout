import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contentHash as moduleHostContentHash,
  generatePublisherKeyPair,
  manifestHash as moduleHostManifestHash,
  signModule,
} from '@pinout/module-host';
import { copyModuleDirectory, readModuleManifestJson } from '../src/content.js';
import { RegistryError } from '../src/errors.js';
import type { RegistryModuleStatus } from '../src/indexFormat.js';
import {
  appendEntry,
  containsEntry,
  createPayloadSigner,
  emptyRegistryIndex,
  packModule,
  publicKeyPemFromPrivate,
  upsertEntry,
} from '../src/publish.js';
import { verifyEntry } from '../src/verify.js';
import { FIXED_PUBLISHED_AT, writeManifest, writeStubModule } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinout-registry-publish-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('packModule', () => {
  it('packs manifest defaults with module-host hash parity', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const packed = await packModule(moduleDir, { publishedAt: FIXED_PUBLISHED_AT });

    expect(packed.entry).toMatchObject({
      name: 'test/thermo',
      version: '0.1.0',
      description: 'Registry test fixture',
      status: 'UNVERIFIED',
      targets: ['node'],
      url: 'modules/test-thermo@0.1.0',
      publishedAt: FIXED_PUBLISHED_AT,
    });
    expect(packed.entry.publisher).toBeUndefined();
    expect(packed.entry.signature).toBeUndefined();
    expect(packed.entry.manifestHash).toBe(
      moduleHostManifestHash(readModuleManifestJson(moduleDir)),
    );
    expect(packed.entry.contentHash).toBe(moduleHostContentHash(moduleDir));
    expect(packed.files).toEqual(['index.js', 'pinout.module.json']);
  });

  it('honors explicit description, targets, url, and status options', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const packed = await packModule(moduleDir, {
      publishedAt: FIXED_PUBLISHED_AT,
      description: 'Custom description',
      targets: ['esp32', 'node'],
      url: 'https://cdn.example/modules/test-thermo@0.1.0',
      status: 'L2',
    });

    expect(packed.entry.description).toBe('Custom description');
    expect(packed.entry.targets).toEqual(['esp32', 'node']);
    expect(packed.entry.url).toBe('https://cdn.example/modules/test-thermo@0.1.0');
    expect(packed.entry.status).toBe('L2');
  });

  it('signs with an injected signer over the module-host payload bytes', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const keys = generatePublisherKeyPair();
    const payloads: Uint8Array[] = [];
    const signer = createPayloadSigner(keys.privateKeyPem);
    const packed = await packModule(moduleDir, {
      publishedAt: FIXED_PUBLISHED_AT,
      publisher: 'acme',
      signer: async (payload) => {
        payloads.push(payload);
        return signer(payload);
      },
    });

    expect(payloads).toHaveLength(1);
    expect(Buffer.from(payloads[0]!).toString('utf8')).toBe(
      `${packed.entry.manifestHash}:${packed.entry.contentHash}`,
    );
    const moduleHostSignature = signModule(
      moduleDir,
      readModuleManifestJson(moduleDir),
      'acme',
      keys.privateKeyPem,
    );
    expect(packed.entry.publisher).toBe('acme');
    expect(packed.entry.signature).toBe(moduleHostSignature.signature);

    const report = verifyEntry(moduleDir, packed.entry, { publisherKey: keys.publicKeyPem });
    expect(report.ok).toBe(true);
    expect(report.signature.status).toBe('VALID');
  });

  it('supports a synchronous signer', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const keys = generatePublisherKeyPair();
    const signer = createPayloadSigner(keys.privateKeyPem);
    const packed = await packModule(moduleDir, {
      publishedAt: FIXED_PUBLISHED_AT,
      publisher: 'acme',
      signer: (payload) => signer(payload) as string,
    });
    expect(packed.entry.signature).toBeDefined();
  });

  it('rejects inconsistent signer/publisher options and bad signatures', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const signer = () => 'A'.repeat(86) + '==';

    await expect(
      packModule(moduleDir, { publishedAt: FIXED_PUBLISHED_AT, publisher: 'acme' }),
    ).rejects.toMatchObject({ code: 'MODULE_PACK_INVALID' });
    await expect(
      packModule(moduleDir, { publishedAt: FIXED_PUBLISHED_AT, signer }),
    ).rejects.toMatchObject({ code: 'MODULE_PACK_INVALID' });
    await expect(
      packModule(moduleDir, {
        publishedAt: FIXED_PUBLISHED_AT,
        publisher: 'acme',
        signer: () => 'not-base64',
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PACK_INVALID' });
    await expect(
      packModule(moduleDir, {
        publishedAt: FIXED_PUBLISHED_AT,
        status: 'SIMULATED' as unknown as RegistryModuleStatus,
      }),
    ).rejects.toMatchObject({ code: 'MODULE_PACK_INVALID' });
  });

  it('rejects missing and invalid manifests as MODULE_SOURCE_INVALID', async () => {
    const emptyDir = join(dir, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    await expect(packModule(emptyDir)).rejects.toMatchObject({
      code: 'MODULE_SOURCE_INVALID',
    });

    const brokenJson = join(dir, 'broken-json');
    mkdirSync(brokenJson, { recursive: true });
    writeFileSync(join(brokenJson, 'pinout.module.json'), '{oops', 'utf8');
    await expect(packModule(brokenJson)).rejects.toMatchObject({
      code: 'MODULE_SOURCE_INVALID',
    });

    const unknownField = join(dir, 'unknown-field');
    writeManifest(unknownField, { extraManifest: { sneaky: true } });
    await expect(packModule(unknownField)).rejects.toMatchObject({
      code: 'MODULE_SOURCE_INVALID',
    });
  });

  it('copying a packed module preserves the content hash', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const packed = await packModule(moduleDir, { publishedAt: FIXED_PUBLISHED_AT });
    const destination = join(dir, 'copy');
    copyModuleDirectory(moduleDir, destination);
    expect(moduleHostContentHash(destination)).toBe(packed.entry.contentHash);
  });

  it('derives the public PEM from the private key', () => {
    const keys = generatePublisherKeyPair();
    expect(publicKeyPemFromPrivate(keys.privateKeyPem)).toBe(keys.publicKeyPem);
  });
});

describe('index manipulation', () => {
  it('appendEntry/upsertEntry/containsEntry are pure and validated', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const packed = await packModule(moduleDir, { publishedAt: FIXED_PUBLISHED_AT });

    const base = emptyRegistryIndex('acme-registry');
    expect(base).toEqual({ schemaVersion: 1, modules: [], name: 'acme-registry' });
    expect(emptyRegistryIndex()).toEqual({ schemaVersion: 1, modules: [] });

    const withOne = appendEntry(base, packed.entry);
    expect(base.modules).toHaveLength(0);
    expect(withOne.modules).toHaveLength(1);
    expect(containsEntry(withOne, packed.entry)).toBe(true);
    expect(containsEntry(base, packed.entry)).toBe(false);

    let duplicate: unknown = null;
    try {
      appendEntry(withOne, packed.entry);
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(RegistryError);
    expect((duplicate as RegistryError).code).toBe('MODULE_ALREADY_PUBLISHED');

    const replacement = { ...packed.entry, description: 'Replaced description' };
    const upserted = upsertEntry(withOne, replacement);
    expect(upserted.modules).toHaveLength(1);
    expect(upserted.modules[0]?.description).toBe('Replaced description');
    expect(withOne.modules[0]?.description).toBe('Registry test fixture');

    const invalid = {
      ...packed.entry,
      publisher: 'acme',
      signature: 'not-base64',
    };
    expect(() => appendEntry(base, invalid)).toThrow(RegistryError);
    expect(() => appendEntry(base, invalid)).toThrowError(/signature/);
  });
});
