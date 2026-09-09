import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeHardwareSource,
  evaluateIrAgainstExpected,
  generateCandidateModule,
  ingestSource,
} from '../src/index.js';
import {
  actuatorExpected,
  ambiguousExpected,
  heatboxExpected,
  repoRoot,
} from './expectedFixtures.js';

const heatboxPath = join(repoRoot, 'fixtures/generator/heatbox-sdk');
const actuatorPath = join(repoRoot, 'fixtures/generator/actuator-sdk');
const ambiguousPath = join(repoRoot, 'fixtures/generator/ambiguous-sdk');

describe('source ingestion', () => {
  it('ingests directory with supported files', () => {
    const docs = ingestSource(heatboxPath);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.some((d) => d.path.endsWith('manual.md'))).toBe(true);
  });

  it('ignores node_modules and binary files', () => {
    const docs = ingestSource(repoRoot);
    expect(docs.every((d) => !d.path.includes('node_modules'))).toBe(true);
  });
});

describe('fixture evaluation', () => {
  it('extracts heatbox capabilities and documented safety', async () => {
    const { ir } = await analyzeHardwareSource({ sourcePath: heatboxPath });
    const metrics = evaluateIrAgainstExpected(ir, heatboxExpected);
    expect(metrics.capabilityRecall).toBeGreaterThan(0.8);
    expect(metrics.constraintAccuracy).toBe(1);
    expect(metrics.falseSafetyConstraints).toBe(0);
    expect(ir.capabilities.some((c) => c.id === 'temperature.set')).toBe(true);
  });

  it('extracts actuator motion capabilities', async () => {
    const { ir } = await analyzeHardwareSource({ sourcePath: actuatorPath });
    const metrics = evaluateIrAgainstExpected(ir, actuatorExpected);
    expect(metrics.capabilityRecall).toBeGreaterThan(0.7);
    expect(ir.capabilities.some((c) => c.id === 'motion.move_to')).toBe(true);
  });

  it('surfaces uncertainties for ambiguous SDK', async () => {
    const { ir } = await analyzeHardwareSource({ sourcePath: ambiguousPath });
    const metrics = evaluateIrAgainstExpected(ir, ambiguousExpected);
    expect(metrics.uncertaintyDetected).toBe(true);
    expect(metrics.falseSafetyConstraints).toBe(0);
    expect(ir.uncertainties.length).toBeGreaterThan(0);
  });
});

describe('module generation', () => {
  it('generates valid module from heatbox fixture', async () => {
    const output = mkdtempSync(join(tmpdir(), 'pinout-gen-heatbox-'));
    try {
      const result = await generateCandidateModule({
        sourcePath: heatboxPath,
        outputPath: output,
        runConformance: false,
      });
      expect(result.moduleId).toBeTruthy();
      expect(result.message).toContain('UNVERIFIED');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 60_000); // Shells out to real npm install + tsc; allow slower CI machines.

  it('refuses overwrite without flag', async () => {
    const output = mkdtempSync(join(tmpdir(), 'pinout-gen-dup-'));
    await generateCandidateModule({ sourcePath: heatboxPath, outputPath: output });
    await expect(
      generateCandidateModule({ sourcePath: heatboxPath, outputPath: output }),
    ).rejects.toThrow(/already exists/);
    rmSync(output, { recursive: true, force: true });
  }, 60_000);
});

describe('plan output', () => {
  it('includes capabilities and unknowns in plan', async () => {
    const result = await generateCandidateModule({ sourcePath: heatboxPath, planOnly: true });
    expect(result.plan).toContain('temperature.set');
    expect(result.plan).toContain('Capabilities');
  });
});
