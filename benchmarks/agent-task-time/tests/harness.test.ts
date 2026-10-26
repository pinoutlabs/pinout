import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHarness } from '../src/harness.js';
import type { BenchConfig } from '../src/types.js';

function baseConfig(overrides: Partial<BenchConfig> = {}): BenchConfig {
  const resultsDir = mkdtempSync(join(tmpdir(), 'pinout-bench-results-'));
  return {
    provider: 'scripted',
    model: 'HARNESS_TEST_NOT_LLM',
    temperatureExplicitlySet: false,
    temperatureRecorded: 'model default',
    runs: 1,
    timeoutMs: 30_000,
    maxTurns: 20,
    deviceMode: 'simulated',
    profiles: ['esp32'],
    tasks: ['blinkLed'],
    arms: ['raw', 'pinout'],
    dryRun: true,
    scriptedAgent: true,
    resultsDir,
    seed: 7,
    promptUsdPerMillion: 0.15,
    completionUsdPerMillion: 0.6,
    confirmPhysical: false,
    baudRate: 115200,
    skipPreflight: false,
    ...overrides,
  };
}

describe('harness dry-run / scripted agent', () => {
  it('completes both arms and stamps HARNESS_TEST_NOT_LLM', async () => {
    const { summary, outputDir } = await runHarness(baseConfig());
    expect(summary.evidence).toBe('HARNESS_TEST_NOT_LLM');
    expect(summary.scripted).toBe(true);
    expect(summary.temperature).toBe('model default');
    expect(summary.runs.length).toBe(2);
    expect(summary.runs.every((run) => run.success)).toBe(true);
    expect(summary.note).toMatch(/HARNESS_TEST_NOT_LLM/);

    const summaryJson = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf8'));
    expect(summaryJson.evidence).toBe('HARNESS_TEST_NOT_LLM');
    const markdown = readFileSync(join(outputDir, 'RESULTS.md'), 'utf8');
    expect(markdown).toMatch(/HARNESS_TEST_NOT_LLM/);
    expect(markdown.includes('\u2014')).toBe(false);

    const runFiles = readdirSync(join(outputDir, 'runs'));
    expect(runFiles.some((name) => name.endsWith('.json'))).toBe(true);
    expect(runFiles.some((name) => name.endsWith('.transcript.jsonl'))).toBe(true);
  }, 60_000);

  it('covers servo and sensor tasks across profiles with scripted agent', async () => {
    const { summary } = await runHarness(
      baseConfig({
        profiles: ['esp32', 'pico', 'uno'],
        tasks: ['blinkLed', 'servoSweep', 'readSensor'],
        runs: 1,
      }),
    );
    expect(summary.runs.length).toBe(3 * 3 * 2);
    expect(summary.runs.every((run) => run.outcome === 'success')).toBe(true);
    expect(summary.cells.length).toBe(18);
  }, 120_000);

  it('respects max-tokens by stopping further scheduled runs', async () => {
    const { summary } = await runHarness(
      baseConfig({
        profiles: ['esp32'],
        tasks: ['blinkLed', 'servoSweep'],
        arms: ['raw', 'pinout'],
        runs: 3,
        maxTokens: 200,
      }),
    );
    expect(summary.runs.length).toBeLessThan(12);
    expect(summary.note).toMatch(/max-tokens limit reached|Max tokens cap/);
  });

  it('respects budget-usd by stopping further scheduled runs', async () => {
    const { summary } = await runHarness(
      baseConfig({
        profiles: ['esp32'],
        tasks: ['blinkLed', 'servoSweep'],
        arms: ['raw', 'pinout'],
        runs: 3,
        budgetUsd: 0.00005,
        promptUsdPerMillion: 5,
        completionUsdPerMillion: 15,
      }),
    );
    expect(summary.runs.length).toBeLessThan(12);
    expect(summary.note).toMatch(/budget-usd limit reached|Budget USD cap/);
  });
});
