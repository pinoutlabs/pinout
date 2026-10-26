import { describe, expect, it } from 'vitest';
import { mean, percentile, shuffleInPlace, summarizeRuns } from '../src/metrics.js';
import type { RunRecord } from '../src/types.js';

function fakeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: 'r',
    evidence: 'SIMULATED',
    arm: 'raw',
    taskId: 'blinkLed',
    profileId: 'esp32',
    deviceMode: 'simulated',
    outcome: 'success',
    success: true,
    checker: { success: true, reason: 'ok', observed: {} },
    wallClockMs: 100,
    llmTimeMs: 40,
    toolTimeMs: 10,
    turnCount: 3,
    toolCallCount: 2,
    tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    timeoutMs: 1000,
    provider: 'test',
    modelRequested: 'm',
    modelReported: 'm',
    temperature: 'model default',
    toolNames: [],
    harnessGitSha: 'abc',
    os: 'linux',
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    transcript: [],
    scripted: false,
    ...overrides,
  };
}

describe('metrics', () => {
  it('computes percentile and mean', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(mean([1, 2, 3])).toBe(2);
  });

  it('shuffle is deterministic for a seed', () => {
    const a = shuffleInPlace([1, 2, 3, 4, 5], 42);
    const b = shuffleInPlace([1, 2, 3, 4, 5], 42);
    expect(a).toEqual(b);
  });

  it('summarizeRuns keeps failure counts', () => {
    const stats = summarizeRuns([
      fakeRun({ outcome: 'success', success: true, wallClockMs: 100 }),
      fakeRun({ outcome: 'failure', success: false, wallClockMs: 200 }),
      fakeRun({ outcome: 'timeout', success: false, wallClockMs: 300 }),
    ]);
    expect(stats.count).toBe(3);
    expect(stats.successCount).toBe(1);
    expect(stats.failureCount).toBe(1);
    expect(stats.timeoutCount).toBe(1);
    expect(stats.successRate).toBeCloseTo(1 / 3);
    expect(stats.wallClockMs.median).toBe(200);
  });
});
