import { describe, expect, it } from 'vitest';
import {
  parseRegistryIndex,
  parseRegistryIndexText,
  registryEntryKey,
  validateRegistryIndex,
} from '../src/indexFormat.js';
import { RegistryError } from '../src/errors.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SIGNATURE = `${'A'.repeat(86)}==`;

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test/thermo',
    version: '0.1.0',
    description: 'Test module',
    manifestHash: HASH_A,
    contentHash: HASH_B,
    status: 'UNVERIFIED',
    targets: ['node'],
    url: 'modules/test-thermo@0.1.0',
    publishedAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

function validIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, modules: [validEntry()], ...overrides };
}

function expectInvalid(value: unknown): RegistryError {
  try {
    parseRegistryIndex(value);
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe('REGISTRY_INDEX_INVALID');
    return error as RegistryError;
  }
  throw new Error('Expected parseRegistryIndex to throw.');
}

describe('registry index format v0', () => {
  it('parses a minimal valid index', () => {
    const index = parseRegistryIndex(validIndex());
    expect(index.schemaVersion).toBe(1);
    expect(index.modules).toHaveLength(1);
    expect(index.modules[0]?.name).toBe('test/thermo');
  });

  it('accepts signed entries with a publisher', () => {
    const index = parseRegistryIndex(
      validIndex({
        modules: [validEntry({ publisher: 'acme', signature: SIGNATURE })],
      }),
    );
    expect(index.modules[0]?.publisher).toBe('acme');
    expect(index.modules[0]?.signature).toBe(SIGNATURE);
  });

  it('accepts optional index metadata', () => {
    const index = parseRegistryIndex(
      validIndex({ name: 'acme-registry', updatedAt: '2026-10-17T01:02:03Z' }),
    );
    expect(index.name).toBe('acme-registry');
  });

  it('rejects unknown top-level fields', () => {
    expectInvalid({ ...validIndex(), extra: true });
  });

  it('rejects unknown entry fields', () => {
    expectInvalid(validIndex({ modules: [validEntry({ sneaky: 1 })] }));
  });

  it('rejects unsupported schemaVersion', () => {
    expectInvalid(validIndex({ schemaVersion: 2 }));
    expectInvalid(validIndex({ schemaVersion: '1' }));
  });

  it('rejects missing modules and non-array modules', () => {
    expectInvalid({ schemaVersion: 1 });
    expectInvalid(validIndex({ modules: {} }));
  });

  it('rejects duplicate (name, version) entries', () => {
    const error = expectInvalid(
      validIndex({ modules: [validEntry(), validEntry({ description: 'Other' })] }),
    );
    expect(error.message).toContain('Duplicate');
  });

  it('rejects malformed module ids', () => {
    for (const name of ['thermo', 'Test/thermo', 'test/thermo/extra', 'test thermo']) {
      expectInvalid(validIndex({ modules: [validEntry({ name })] }));
    }
  });

  it('rejects malformed versions', () => {
    expectInvalid(validIndex({ modules: [validEntry({ version: '1.0' })] }));
    expectInvalid(validIndex({ modules: [validEntry({ version: 'v1.0.0' })] }));
  });

  it('rejects malformed hashes', () => {
    expectInvalid(validIndex({ modules: [validEntry({ manifestHash: 'abc' })] }));
    expectInvalid(validIndex({ modules: [validEntry({ contentHash: 'A'.repeat(64) })] }));
    expectInvalid(validIndex({ modules: [validEntry({ contentHash: 'z'.repeat(64) })] }));
  });

  it('rejects a signature without a publisher and vice versa', () => {
    expectInvalid(validIndex({ modules: [validEntry({ signature: SIGNATURE })] }));
    expectInvalid(validIndex({ modules: [validEntry({ publisher: 'acme' })] }));
  });

  it('rejects malformed signatures and publisher ids', () => {
    expectInvalid(
      validIndex({ modules: [validEntry({ publisher: 'acme', signature: 'not-base64' })] }),
    );
    expectInvalid(
      validIndex({
        modules: [validEntry({ publisher: 'has space', signature: SIGNATURE })],
      }),
    );
  });

  it('rejects unsupported status labels', () => {
    expectInvalid(validIndex({ modules: [validEntry({ status: 'SIMULATED' })] }));
    expectInvalid(validIndex({ modules: [validEntry({ status: 'L6' })] }));
  });

  it('accepts every conformance level and UNVERIFIED', () => {
    for (const status of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'UNVERIFIED']) {
      const index = parseRegistryIndex(validIndex({ modules: [validEntry({ status })] }));
      expect(index.modules[0]?.status).toBe(status);
    }
  });

  it('rejects empty or non-string targets', () => {
    expectInvalid(validIndex({ modules: [validEntry({ targets: [] })] }));
    expectInvalid(validIndex({ modules: [validEntry({ targets: ['node', 7] })] }));
    expectInvalid(validIndex({ modules: [validEntry({ targets: [''] })] }));
  });

  it('rejects non-UTC or malformed timestamps', () => {
    expectInvalid(validIndex({ modules: [validEntry({ publishedAt: '2026-10-17' })] }));
    expectInvalid(
      validIndex({
        modules: [validEntry({ publishedAt: '2026-10-17T00:00:00+01:00' })],
      }),
    );
    expectInvalid(
      validIndex({ modules: [validEntry({ publishedAt: '2026-13-17T00:00:00.000Z' })] }),
    );
  });

  it('rejects blank descriptions and missing required fields', () => {
    expectInvalid(validIndex({ modules: [validEntry({ description: '   ' })] }));
    const withoutUrl = validEntry();
    delete withoutUrl['url'];
    expectInvalid(validIndex({ modules: [withoutUrl] }));
  });

  it('validateRegistryIndex throws RegistryError and narrows', () => {
    const raw: unknown = validIndex();
    expect(() => validateRegistryIndex(raw)).not.toThrow();
    const withoutSchema = validIndex();
    delete withoutSchema['schemaVersion'];
    expect(() => validateRegistryIndex(withoutSchema)).toThrow(RegistryError);
  });

  it('parseRegistryIndexText reports JSON syntax errors', () => {
    expect(() => parseRegistryIndexText('{oops')).toThrow(RegistryError);
  });

  it('registryEntryKey is stable', () => {
    expect(registryEntryKey('test/thermo', '0.1.0')).toBe('test/thermo@0.1.0');
  });
});
