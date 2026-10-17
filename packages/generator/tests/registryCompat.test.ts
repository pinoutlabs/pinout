import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateCandidateModule } from '../src/index.js';
import {
  GENERATED_MODULE_REQUIRED_ENTRIES,
  REGISTRY_PACK_EXCLUDED_DIRECTORIES,
  validateGeneratedModuleLayout,
} from '../src/registryCompat.js';
import { repoRoot } from './expectedFixtures.js';

const heatboxPath = join(repoRoot, 'fixtures/generator/heatbox-sdk');

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('validateGeneratedModuleLayout — generated candidates', () => {
  it('reports a generated candidate module as packable', async () => {
    const output = tempDir('pinout-gen-registry-');
    try {
      await generateCandidateModule({
        sourcePath: heatboxPath,
        outputPath: output,
        runConformance: false,
      });
      const report = validateGeneratedModuleLayout(output);

      expect(report.packable).toBe(true);
      expect(report.requiredEntries).toEqual([...GENERATED_MODULE_REQUIRED_ENTRIES]);
      expect(report.missingEntries).toEqual([]);
      expect(report.manifest?.id).toBeTruthy();
      expect(report.manifest?.version).toBeTruthy();
      expect(report.manifest?.entrypoint).toBe('./dist/index.js');
      expect(report.entrypointPresent).toBe(true);
      expect(report.notes.length).toBeGreaterThan(0);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 120_000); // Shells out to real npm install + tsc; allow slowest CI machines.
});

describe('validateGeneratedModuleLayout — incomplete layouts', () => {
  it('flags a missing evidence/report.json as not packable', () => {
    const dir = tempDir('pinout-gen-incomplete-');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'pinout.module.json'),
        `${JSON.stringify({ schemaVersion: 1, id: 'gen/incomplete', version: '0.1.0' })}\n`,
        'utf8',
      );
      const report = validateGeneratedModuleLayout(dir);

      expect(report.packable).toBe(false);
      expect(report.missingEntries).toEqual(['evidence/report.json']);
      expect(report.manifest?.id).toBe('gen/incomplete');
      expect(report.entrypoint).toBeNull();
      expect(report.entrypointPresent).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a manifest without id/version and adds an explanatory note', () => {
    const dir = tempDir('pinout-gen-noidentity-');
    try {
      mkdirSync(join(dir, 'evidence'), { recursive: true });
      writeFileSync(join(dir, 'pinout.module.json'), '{}\n', 'utf8');
      writeFileSync(join(dir, 'evidence/report.json'), '{}\n', 'utf8');
      const report = validateGeneratedModuleLayout(dir);

      expect(report.packable).toBe(false);
      expect(report.missingEntries).toEqual([]);
      expect(report.manifest).not.toBeNull();
      expect(report.notes.some((note) => note.includes('missing id/version'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports nonexistent directories as fully missing', () => {
    const dir = join(tempDir('pinout-gen-missing-'), 'does-not-exist');
    const report = validateGeneratedModuleLayout(dir);

    expect(report.packable).toBe(false);
    expect(report.missingEntries).toEqual([...GENERATED_MODULE_REQUIRED_ENTRIES]);
    expect(report.manifest).toBeNull();
    expect(report.notes[0]).toContain('does not exist');
  });

  it('keeps the pack exclusion list in sync with the registry contract', () => {
    expect([...REGISTRY_PACK_EXCLUDED_DIRECTORIES]).toEqual([
      'node_modules',
      '.git',
      'coverage',
      '.pinout-cache',
    ]);
  });
});
