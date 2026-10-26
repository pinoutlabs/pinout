import { formatMs, formatRate } from '../metrics.js';
import type { SummaryReport } from '../types.js';

export function renderResultsMarkdown(
  summary: SummaryReport,
  options: { includeTitle?: boolean } = {},
): string {
  const includeTitle = options.includeTitle !== false;
  const lines: string[] = [];
  if (includeTitle) {
    lines.push('# Agent task-time benchmark results');
    lines.push('');
  }
  lines.push(`> Evidence: **${summary.evidence}**`);
  lines.push('');
  if (summary.scripted || summary.evidence === 'HARNESS_TEST_NOT_LLM') {
    lines.push(
      '> **HARNESS_TEST_NOT_LLM** - this table was produced by the scripted harness self-test. It is not an LLM benchmark result.',
    );
    lines.push('');
  }
  lines.push(`- Generated at: \`${summary.generatedAt}\``);
  lines.push(`- Harness git SHA: \`${summary.harnessGitSha}\``);
  lines.push(`- OS: \`${summary.os}\``);
  lines.push(`- Node: \`${summary.nodeVersion}\``);
  lines.push(`- Provider: \`${summary.provider}\``);
  lines.push(`- Model requested: \`${summary.modelRequested}\``);
  lines.push(`- Model reported by API: \`${summary.modelReported}\``);
  lines.push(`- Temperature: \`${summary.temperature}\``);
  lines.push(`- Device mode: \`${summary.deviceMode}\``);
  lines.push(`- Scheduled runs per cell: \`${summary.runsPerCell}\``);
  lines.push(`- Note: ${summary.note}`);
  lines.push('');
  lines.push('## Summary table');
  lines.push('');
  lines.push(
    '| Arm | Task | Profile | N | Success | Median wall | p90 wall | Median LLM | Median tool | Median turns | Median tool calls | Median tokens |',
  );
  lines.push(
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  for (const cell of summary.cells) {
    const stats = cell.stats;
    lines.push(
      `| ${cell.arm} | ${cell.taskId} | ${cell.profileId} | ${stats.count} | ${formatRate(stats.successRate)} | ${formatMs(stats.wallClockMs.median)} | ${formatMs(stats.wallClockMs.p90)} | ${formatMs(stats.llmTimeMs.median)} | ${formatMs(stats.toolTimeMs.median)} | ${stats.turnCount.median.toFixed(1)} | ${stats.toolCallCount.median.toFixed(1)} | ${stats.tokens.medianTotal.toFixed(0)} |`,
    );
  }

  lines.push('');
  lines.push('## Outcome counts');
  lines.push('');
  lines.push('| Arm | Task | Profile | success | failure | timeout | error |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const cell of summary.cells) {
    const stats = cell.stats;
    lines.push(
      `| ${cell.arm} | ${cell.taskId} | ${cell.profileId} | ${stats.successCount} | ${stats.failureCount} | ${stats.timeoutCount} | ${stats.errorCount} |`,
    );
  }

  lines.push('');
  lines.push('Failures and timeouts are retained in `runs/*.json` and are never dropped.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Rebuild RESULTS.md from an existing summary.json (never hand-edit results). */
export function renderFromSummaryJson(summaryJsonText: string): string {
  const summary = JSON.parse(summaryJsonText) as SummaryReport;
  return renderResultsMarkdown(summary);
}
