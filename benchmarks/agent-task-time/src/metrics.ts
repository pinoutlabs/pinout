import type { AggregateStats, RunRecord } from './types.js';

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lowIndex = Math.floor(rank);
  const highIndex = Math.ceil(rank);
  const low = sorted[lowIndex] ?? 0;
  const high = sorted[highIndex] ?? low;
  return low + (high - low) * (rank - lowIndex);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeRuns(runs: RunRecord[]): AggregateStats {
  const wall = runs.map((run) => run.wallClockMs);
  const llm = runs.map((run) => run.llmTimeMs);
  const tool = runs.map((run) => run.toolTimeMs);
  const turns = runs.map((run) => run.turnCount);
  const tools = runs.map((run) => run.toolCallCount);
  const tokens = runs.map((run) => run.tokens.totalTokens);
  const successCount = runs.filter((run) => run.outcome === 'success').length;
  const failureCount = runs.filter((run) => run.outcome === 'failure').length;
  const timeoutCount = runs.filter((run) => run.outcome === 'timeout').length;
  const errorCount = runs.filter((run) => run.outcome === 'error').length;

  return {
    count: runs.length,
    successCount,
    failureCount,
    timeoutCount,
    errorCount,
    successRate: runs.length === 0 ? 0 : successCount / runs.length,
    wallClockMs: {
      median: percentile(wall, 50),
      p90: percentile(wall, 90),
      mean: mean(wall),
      min: wall.length === 0 ? 0 : Math.min(...wall),
      max: wall.length === 0 ? 0 : Math.max(...wall),
    },
    llmTimeMs: {
      median: percentile(llm, 50),
      p90: percentile(llm, 90),
      mean: mean(llm),
    },
    toolTimeMs: {
      median: percentile(tool, 50),
      p90: percentile(tool, 90),
      mean: mean(tool),
    },
    turnCount: { median: percentile(turns, 50), mean: mean(turns) },
    toolCallCount: { median: percentile(tools, 50), mean: mean(tools) },
    tokens: { medianTotal: percentile(tokens, 50), meanTotal: mean(tokens) },
  };
}

/** Deterministic Fisher-Yates shuffle. */
export function shuffleInPlace<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(next() * (index + 1));
    const tmp = items[index]!;
    items[index] = items[swapIndex]!;
    items[swapIndex] = tmp;
  }
  return items;
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 1000) return `${value.toFixed(0)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
