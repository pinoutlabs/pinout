import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, generatePublisherKeyPair, manifestHash, signModule } from '@pinout/module-host';
import { readModuleManifestJson } from '../src/content.js';
import { RegistryError } from '../src/errors.js';
import type { RegistryModuleEntry } from '../src/indexFormat.js';
import { createPayloadSigner } from '../src/publish.js';
import { throwIfVerificationFailed, verifyEntry } from '../src/verify.js';
import { registryEntryFor, writeStubModule } from './helpers.js';

let dir: string;
let keys: { publicKeyPem: string; privateKeyPem: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinout-registry-verify-'));
  keys = generatePublisherKeyPair();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function signedEntry(directory: string, publisher = 'acme'): RegistryModuleEntry {
  const manifest = readModuleManifestJson(directory);
  const signature = signModule(directory, manifest, publisher, keys.privateKeyPem);
  return registryEntryFor(directory, { publisher, signature: signature.signature });
}

function expectRegistryCode(callback: () => unknown, code: string): void {
  let thrown: unknown = null;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RegistryError);
  expect((thrown as RegistryError).code).toBe(code);
}

describe('verifyEntry — hashes and signatures', () => {
  it('entry signatures are byte-compatible with @pinout/module-host', async () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const manifest = readModuleManifestJson(moduleDir);

    expect(registryEntryFor(moduleDir).manifestHash).toBe(manifestHash(manifest));
    expect(registryEntryFor(moduleDir).contentHash).toBe(contentHash(moduleDir));

    const entry = signedEntry(moduleDir);
    const signer = createPayloadSigner(keys.privateKeyPem);
    const payload = Buffer.from(`${entry.manifestHash}:${entry.contentHash}`, 'utf8');
    expect(await signer(payload)).toBe(entry.signature);
    expect(signModule(moduleDir, manifest, 'acme', keys.privateKeyPem).signature).toBe(
      entry.signature,
    );
  });

  it('accepts unsigned entries by default and reports them as ABSENT', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const report = verifyEntry(moduleDir, registryEntryFor(moduleDir));

    expect(report.ok).toBe(true);
    expect(report.metadata).toBe('MATCH');
    expect(report.hashes.manifest.status).toBe('MATCH');
    expect(report.hashes.content.status).toBe('MATCH');
    expect(report.signature.status).toBe('ABSENT');
    expect(report.signature.publisher).toBeNull();
    expect(report.policy.requireSignature).toBe(false);
    expect(() => throwIfVerificationFailed(report)).not.toThrow();
  });

  it('requireSignature rejects unsigned entries with MODULE_UNTRUSTED', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const report = verifyEntry(moduleDir, registryEntryFor(moduleDir), {
      requireSignature: true,
    });

    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.code)).toContain('MODULE_UNTRUSTED');
    expectRegistryCode(() => throwIfVerificationFailed(report), 'MODULE_UNTRUSTED');
  });

  it('verifies signed entries against a single trusted key', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const entry = signedEntry(moduleDir);
    const report = verifyEntry(moduleDir, entry, { publisherKey: keys.publicKeyPem });

    expect(report.ok).toBe(true);
    expect(report.signature.status).toBe('VALID');
    expect(report.signature.publisher).toBe('acme');
    expect(report.signature.checkedKeys).toBe(1);
  });

  it('honors scoped and unscoped allowlist entries', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const entry = signedEntry(moduleDir);

    const scoped = verifyEntry(moduleDir, entry, {
      allowlist: [{ publisher: 'acme', pem: keys.publicKeyPem }],
    });
    expect(scoped.ok).toBe(true);
    expect(scoped.signature.status).toBe('VALID');

    const wildcard = verifyEntry(moduleDir, entry, {
      allowlist: [{ pem: keys.publicKeyPem }],
    });
    expect(wildcard.ok).toBe(true);
    expect(wildcard.signature.status).toBe('VALID');

    const foreign = generatePublisherKeyPair();
    const wrongPublisher = verifyEntry(moduleDir, entry, {
      allowlist: [{ publisher: 'other', pem: foreign.publicKeyPem }],
    });
    expect(wrongPublisher.ok).toBe(false);
    expect(wrongPublisher.signature.status).toBe('UNTRUSTED');
    expect(wrongPublisher.failures.map((failure) => failure.code)).toContain('MODULE_UNTRUSTED');
    expect(wrongPublisher.failures[0]?.message).toContain('not in the allowlist');
  });

  it('reports INVALID when the signature was made with a different key', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const other = generatePublisherKeyPair();
    const report = verifyEntry(moduleDir, signedEntry(moduleDir), {
      publisherKey: other.publicKeyPem,
    });

    expect(report.ok).toBe(false);
    expect(report.signature.status).toBe('INVALID');
    expect(report.failures.map((failure) => failure.code)).toContain('MODULE_SIGNATURE_INVALID');
  });

  it('reports UNTRUSTED but ok when signed with no key supplied', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const report = verifyEntry(moduleDir, signedEntry(moduleDir));

    expect(report.ok).toBe(true);
    expect(report.signature.status).toBe('UNTRUSTED');
    expect(report.signature.reason).toContain('No key supplied');
  });

  it('fails a signed entry when requireSignature has no trusted key', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const report = verifyEntry(moduleDir, signedEntry(moduleDir), { requireSignature: true });

    expect(report.ok).toBe(false);
    expect(report.signature.status).toBe('UNTRUSTED');
    expect(report.failures.map((failure) => failure.code)).toContain('MODULE_UNTRUSTED');
  });
});

describe('verifyEntry — mismatches and invalid sources', () => {
  it('detects content tampering after packing', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const entry = registryEntryFor(moduleDir);
    writeFileSync(join(moduleDir, 'index.js'), 'export default { hacked: true };\n', 'utf8');

    const report = verifyEntry(moduleDir, entry);
    expect(report.ok).toBe(false);
    expect(report.hashes.content.status).toBe('MISMATCH');
    expect(report.failures[0]?.code).toBe('MODULE_HASH_MISMATCH');
  });

  it('detects manifest hash mismatches', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const entry = registryEntryFor(moduleDir, { manifestHash: 'f'.repeat(64) });

    const report = verifyEntry(moduleDir, entry);
    expect(report.ok).toBe(false);
    expect(report.hashes.manifest.status).toBe('MISMATCH');
    expect(report.hashes.content.status).toBe('MATCH');
    expect(report.failures.map((failure) => failure.code)).toContain('MODULE_HASH_MISMATCH');
  });

  it('detects manifest metadata mismatches', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);

    for (const overrides of [{ name: 'test/other' }, { version: '9.9.9' }]) {
      const report = verifyEntry(moduleDir, registryEntryFor(moduleDir, overrides));
      expect(report.metadata).toBe('MISMATCH');
      expect(report.ok).toBe(false);
      expect(report.failures.map((failure) => failure.code)).toContain('MODULE_METADATA_MISMATCH');
    }
  });

  it('reports a missing manifest as UNKNOWN metadata and a hash failure', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const entry = registryEntryFor(moduleDir);
    const emptyDir = join(dir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    const report = verifyEntry(emptyDir, entry);
    expect(report.ok).toBe(false);
    expect(report.metadata).toBe('UNKNOWN');
    expect(report.manifestId).toBeNull();
    expect(report.manifestVersion).toBeNull();
    expect(report.hashes.manifest.actual).toBeNull();
    expect(report.failures[0]?.message).toContain('Cannot read pinout.module.json');
  });

  it('throws MODULE_SOURCE_INVALID for missing directories', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const entry = registryEntryFor(moduleDir);

    expectRegistryCode(
      () => verifyEntry(join(dir, 'does-not-exist'), entry),
      'MODULE_SOURCE_INVALID',
    );
  });
});
