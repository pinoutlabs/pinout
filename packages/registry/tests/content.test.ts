import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, manifestHash } from '@pinout/module-host';
import {
  assertSafeRelativePath,
  computeContentHash,
  computeManifestHash,
  copyModuleDirectory,
  hasExcludedSegment,
  listPackableFiles,
  MODULE_MANIFEST_FILENAME,
  readModuleManifestJson,
  safeJoinWithin,
} from '../src/content.js';
import { RegistryError } from '../src/errors.js';
import { writeStubModule } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinout-registry-content-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('content hashing parity', () => {
  it('manifestHash matches @pinout/module-host byte-for-byte', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const manifest = readModuleManifestJson(moduleDir);
    expect(computeManifestHash(manifest)).toBe(manifestHash(manifest));
  });

  it('contentHash matches @pinout/module-host and is deterministic', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    expect(computeContentHash(moduleDir)).toBe(contentHash(moduleDir));
    expect(computeContentHash(moduleDir)).toBe(computeContentHash(moduleDir));
  });

  it('hashes ignore node_modules, dist, .git, coverage, cache, and signature files', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    const before = computeContentHash(moduleDir);

    writeFileSync(join(moduleDir, 'pinout.module.sig'), '{}\n', 'utf8');
    mkdirSync(join(moduleDir, 'dist'), { recursive: true });
    writeFileSync(join(moduleDir, 'dist/index.js'), 'built\n', 'utf8');
    mkdirSync(join(moduleDir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(moduleDir, 'node_modules/pkg/index.js'), 'dep\n', 'utf8');
    mkdirSync(join(moduleDir, '.git'), { recursive: true });
    writeFileSync(join(moduleDir, '.git/HEAD'), 'ref\n', 'utf8');
    mkdirSync(join(moduleDir, 'coverage'), { recursive: true });
    writeFileSync(join(moduleDir, 'coverage/lcov.info'), 'x\n', 'utf8');
    mkdirSync(join(moduleDir, '.pinout-cache'), { recursive: true });
    writeFileSync(join(moduleDir, '.pinout-cache/x'), 'x\n', 'utf8');

    expect(computeContentHash(moduleDir)).toBe(before);

    writeFileSync(join(moduleDir, 'extra.js'), 'export const x = 1;\n', 'utf8');
    expect(computeContentHash(moduleDir)).not.toBe(before);
  });

  it('listPackableFiles excludes junk but keeps dist, evidence, and notes', () => {
    const moduleDir = join(dir, 'module');
    writeStubModule(moduleDir);
    mkdirSync(join(moduleDir, 'dist'), { recursive: true });
    writeFileSync(join(moduleDir, 'dist/index.js'), 'built\n', 'utf8');
    mkdirSync(join(moduleDir, 'evidence'), { recursive: true });
    writeFileSync(join(moduleDir, 'evidence/report.json'), '{}\n', 'utf8');
    writeFileSync(join(moduleDir, 'INTEGRATION_NOTES.md'), 'notes\n', 'utf8');
    mkdirSync(join(moduleDir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(moduleDir, 'node_modules/pkg/index.js'), 'dep\n', 'utf8');
    mkdirSync(join(moduleDir, '.git'), { recursive: true });
    writeFileSync(join(moduleDir, '.git/HEAD'), 'ref\n', 'utf8');

    const files = listPackableFiles(moduleDir);
    expect(files).toContain(MODULE_MANIFEST_FILENAME);
    expect(files).toContain('dist/index.js');
    expect(files).toContain('evidence/report.json');
    expect(files).toContain('INTEGRATION_NOTES.md');
    expect(files.some((file) => file.startsWith('node_modules/'))).toBe(false);
    expect(files.some((file) => file.startsWith('.git/'))).toBe(false);
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
  });

  it('copyModuleDirectory keeps dist and produces hash-equal copies', () => {
    const source = join(dir, 'source');
    writeStubModule(source);
    mkdirSync(join(source, 'dist'), { recursive: true });
    writeFileSync(join(source, 'dist/index.js'), 'built\n', 'utf8');
    mkdirSync(join(source, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(source, 'node_modules/pkg/index.js'), 'dep\n', 'utf8');
    writeFileSync(join(source, 'INTEGRATION_NOTES.md'), 'notes\n', 'utf8');

    const destination = join(dir, 'destination');
    const copied = copyModuleDirectory(source, destination);
    expect(copied).toContain('dist/index.js');
    expect(copied).toContain('INTEGRATION_NOTES.md');
    expect(copied.some((file) => file.startsWith('node_modules/'))).toBe(false);
    expect(computeContentHash(destination)).toBe(computeContentHash(source));
    expect(readFileSync(join(destination, 'dist/index.js'), 'utf8')).toBe('built\n');
  });

  it('copyModuleDirectory refuses missing sources', () => {
    expect(() => copyModuleDirectory(join(dir, 'nope'), join(dir, 'out'))).toThrow(RegistryError);
  });
});

describe('path safety', () => {
  it('accepts safe relative paths', () => {
    expect(() => assertSafeRelativePath('dist/index.js')).not.toThrow();
    expect(() => assertSafeRelativePath('a/b/c.json')).not.toThrow();
  });

  it('rejects traversal, absolute, backslash, and empty segments', () => {
    for (const unsafe of ['../evil', 'a/../b', '/etc/passwd', 'a\\b', 'a//b', '', './a']) {
      expect(() => assertSafeRelativePath(unsafe)).toThrow(RegistryError);
    }
  });

  it('safeJoinWithin keeps paths inside the base and rejects escapes', () => {
    const base = join(dir, 'base');
    expect(safeJoinWithin(base, 'a/b.txt')).toBe(join(base, 'a/b.txt'));
    expect(() => safeJoinWithin(base, '../outside.txt')).toThrow(RegistryError);
  });

  it('hasExcludedSegment finds excluded segments at any depth', () => {
    expect(hasExcludedSegment('node_modules/x.js')).toBe(true);
    expect(hasExcludedSegment('a/.git/config')).toBe(true);
    expect(hasExcludedSegment('dist/index.js')).toBe(false);
  });
});
