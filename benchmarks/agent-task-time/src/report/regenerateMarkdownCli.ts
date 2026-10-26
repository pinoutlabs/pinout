#!/usr/bin/env node
/**
 * Rebuild RESULTS.md from summary.json. Never hand-edit result tables.
 *
 *   npx tsx benchmarks/agent-task-time/src/report/regenerateMarkdownCli.ts \
 *     benchmarks/agent-task-time/results/<date>/summary.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertNoSecretLeak } from '../redact.js';
import { renderFromSummaryJson } from './generateMarkdown.js';

function main(): void {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Usage: regenerateMarkdownCli.ts <path-to-summary.json>');
  }
  const summaryPath = resolve(input);
  const text = readFileSync(summaryPath, 'utf8');
  const markdown = renderFromSummaryJson(text);
  assertNoSecretLeak(markdown);
  const outPath = join(dirname(summaryPath), 'RESULTS.md');
  writeFileSync(outPath, markdown, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main();
