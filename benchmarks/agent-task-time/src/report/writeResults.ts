import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoSecretLeak, redactJsonValue, redactSecrets } from '../redact.js';
import { renderResultsMarkdown } from './generateMarkdown.js';
import type { BenchConfig, RunRecord, SummaryReport } from '../types.js';

export function writeRunArtifacts(outputDir: string, run: RunRecord): void {
  mkdirSync(join(outputDir, 'runs'), { recursive: true });
  const safeRun = redactJsonValue(run);
  const jsonPath = join(outputDir, 'runs', `${run.runId}.json`);
  const transcriptPath = join(outputDir, 'runs', `${run.runId}.transcript.jsonl`);
  const jsonText = `${JSON.stringify(safeRun, null, 2)}\n`;
  assertNoSecretLeak(jsonText);
  writeFileSync(jsonPath, jsonText, 'utf8');

  const lines = run.transcript.map((turn) =>
    JSON.stringify({
      turnIndex: turn.turnIndex,
      role: turn.role,
      toolName: turn.toolName,
      toolCallId: turn.toolCallId,
      llmLatencyMs: turn.llmLatencyMs,
      toolLatencyMs: turn.toolLatencyMs,
      usage: turn.usage,
      content: redactSecrets(turn.content),
    }),
  );
  const transcriptText = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
  assertNoSecretLeak(transcriptText);
  writeFileSync(transcriptPath, transcriptText, 'utf8');
}

export function writeSuiteArtifacts(
  outputDir: string,
  summary: SummaryReport,
  config: BenchConfig,
): void {
  mkdirSync(outputDir, { recursive: true });
  const safeSummary = redactJsonValue(stripApiKey(summary));
  const summaryPath = join(outputDir, 'summary.json');
  const markdownPath = join(outputDir, 'RESULTS.md');
  const configPath = join(outputDir, 'config.redacted.json');

  const summaryText = `${JSON.stringify(safeSummary, null, 2)}\n`;
  assertNoSecretLeak(summaryText);
  writeFileSync(summaryPath, summaryText, 'utf8');

  const markdown = renderResultsMarkdown(safeSummary);
  assertNoSecretLeak(markdown);
  writeFileSync(markdownPath, markdown, 'utf8');

  const redactedConfig = {
    provider: config.provider,
    model: config.model,
    temperatureRequested: config.temperatureRequested ?? null,
    temperatureExplicitlySet: config.temperatureExplicitlySet,
    temperatureRecorded: config.temperatureRecorded,
    temperatureSend: config.temperatureSend ?? null,
    runs: config.runs,
    timeoutMs: config.timeoutMs,
    maxTurns: config.maxTurns,
    deviceMode: config.deviceMode,
    profiles: config.profiles,
    tasks: config.tasks,
    arms: config.arms,
    dryRun: config.dryRun,
    scriptedAgent: config.scriptedAgent,
    seed: config.seed,
    budgetUsd: config.budgetUsd,
    maxTokens: config.maxTokens,
    promptUsdPerMillion: config.promptUsdPerMillion,
    completionUsdPerMillion: config.completionUsdPerMillion,
    apiBaseUrl: config.apiBaseUrl,
    confirmPhysical: config.confirmPhysical,
    serialPort: config.serialPort,
    baudRate: config.baudRate,
    daemonUrl: config.daemonUrl,
    apiKeyPresent: Boolean(config.apiKey),
    apiKey: '[REDACTED]',
    daemonToken: config.daemonToken ? '[REDACTED]' : null,
  };
  const configText = `${JSON.stringify(redactedConfig, null, 2)}\n`;
  assertNoSecretLeak(configText);
  writeFileSync(configPath, configText, 'utf8');

  // Machine-readable pointer for README regeneration helpers.
  writeFileSync(
    join(outputDir, 'README_SNIPPET.md'),
    renderResultsMarkdown(safeSummary, { includeTitle: false }),
    'utf8',
  );
}

function stripApiKey(summary: SummaryReport): SummaryReport {
  return summary;
}
