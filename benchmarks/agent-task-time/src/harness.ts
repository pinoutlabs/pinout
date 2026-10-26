import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform, release, arch } from 'node:os';
import { createRawArmTools } from './arms/rawArm.js';
import { createPinoutArmTools } from './arms/pinoutArm.js';
import { BenchDevice } from './devices/benchDevice.js';
import { createLlmClient, type LlmClient } from './llm/client.js';
import { createScriptedClient } from './llm/scriptedAgent.js';
import { encodeToolNameForLlm, resolveEncodedToolName } from './llm/toolNames.js';
import { shuffleInPlace, summarizeRuns } from './metrics.js';
import { redactSecrets } from './redact.js';
import { writeRunArtifacts, writeSuiteArtifacts } from './report/writeResults.js';
import { getTask } from './tasks/definitions.js';
import type {
  AgentTool,
  ArmId,
  BenchConfig,
  EvidenceLabel,
  LlmMessage,
  LlmUsage,
  ProfileId,
  RunRecord,
  SummaryReport,
  TaskId,
  TurnRecord,
} from './types.js';

interface ScheduledCell {
  arm: ArmId;
  taskId: TaskId;
  profileId: ProfileId;
  repeatIndex: number;
}

export interface HarnessResult {
  summary: SummaryReport;
  outputDir: string;
}

export async function runHarness(config: BenchConfig): Promise<HarnessResult> {
  const harnessGitSha = readGitSha();
  const startedSuite = new Date();
  const dateStamp = startedSuite.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const outputDir = join(config.resultsDir, dateStamp);
  const evidence: EvidenceLabel = config.scriptedAgent
    ? 'HARNESS_TEST_NOT_LLM'
    : config.deviceMode === 'real'
      ? 'REAL_HARDWARE'
      : 'SIMULATED';

  const schedule = buildSchedule(config);
  const runs: RunRecord[] = [];
  let cumulativeTokens = 0;
  let estimatedSpendUsd = 0;
  let stopReason: string | undefined;
  let modelReported = config.scriptedAgent ? 'HARNESS_TEST_NOT_LLM' : config.model;

  for (const cell of schedule) {
    if (stopReason) break;
    if (config.budgetUsd !== undefined && estimatedSpendUsd >= config.budgetUsd) {
      stopReason = `budget-usd limit reached (estimated $${estimatedSpendUsd.toFixed(4)} >= $${config.budgetUsd})`;
      break;
    }
    if (config.maxTokens !== undefined && cumulativeTokens >= config.maxTokens) {
      stopReason = `max-tokens limit reached (${cumulativeTokens} >= ${config.maxTokens})`;
      break;
    }

    const run = await executeRun(config, cell, evidence, harnessGitSha);
    if (run.modelReported && run.modelReported !== 'unknown') {
      modelReported = run.modelReported;
    }
    runs.push(run);
    cumulativeTokens += run.tokens.totalTokens;
    estimatedSpendUsd += estimateUsd(run.tokens, config);
    writeRunArtifacts(outputDir, run);

    console.log(
      redactSecrets(
        [
          `[${evidence}]`,
          run.arm,
          run.taskId,
          run.profileId,
          `#${cell.repeatIndex + 1}`,
          run.outcome,
          `${run.wallClockMs.toFixed(0)}ms`,
          run.success ? 'PASS' : 'FAIL',
        ].join(' '),
      ),
    );
  }

  const cells = aggregateCells(runs);
  const summary: SummaryReport = {
    evidence,
    generatedAt: new Date().toISOString(),
    harnessGitSha,
    os: `${platform()} ${release()} ${arch()}`,
    nodeVersion: process.version,
    provider: config.scriptedAgent ? 'scripted' : config.provider,
    modelRequested: config.model,
    modelReported,
    temperature: config.temperature,
    runsPerCell: config.runs,
    deviceMode: config.deviceMode,
    scripted: config.scriptedAgent,
    note: buildNote(evidence, stopReason, cumulativeTokens, estimatedSpendUsd, config),
    cells,
    runs: runs.map((run) => redactRunForSummary(run)),
  };

  writeSuiteArtifacts(outputDir, summary, config);
  return { summary, outputDir };
}

function buildSchedule(config: BenchConfig): ScheduledCell[] {
  const cells: ScheduledCell[] = [];
  for (const profileId of config.profiles) {
    for (const taskId of config.tasks) {
      for (let repeatIndex = 0; repeatIndex < config.runs; repeatIndex += 1) {
        for (const arm of config.arms) {
          cells.push({ arm, taskId, profileId, repeatIndex });
        }
      }
    }
  }
  return shuffleInPlace(cells, config.seed);
}

async function executeRun(
  config: BenchConfig,
  cell: ScheduledCell,
  evidence: EvidenceLabel,
  harnessGitSha: string,
): Promise<RunRecord> {
  const runId = [
    cell.arm,
    cell.taskId,
    cell.profileId,
    `r${String(cell.repeatIndex + 1).padStart(2, '0')}`,
    Date.now().toString(36),
  ].join('_');
  const startedAt = new Date();
  const wallStarted = performance.now();
  const task = getTask(cell.taskId);
  const workspaceDir = mkdtempSync(join(tmpdir(), `pinout-bench-${cell.arm}-`));
  const bench = new BenchDevice(cell.profileId, config.deviceMode);
  const transcript: TurnRecord[] = [];
  let llmTimeMs = 0;
  let toolTimeMs = 0;
  let toolCallCount = 0;
  let tokens: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let modelReported = config.scriptedAgent ? 'HARNESS_TEST_NOT_LLM' : 'unknown';
  let toolNames: string[] = [];
  let outcome: RunRecord['outcome'] = 'failure';
  let errorMessage: string | undefined;
  let checker = task.checkSuccess(bench.snapshot(), cell.profileId);

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), config.timeoutMs);

  try {
    const tools =
      cell.arm === 'raw'
        ? createRawArmTools(bench, workspaceDir)
        : await createPinoutArmTools(bench);
    toolNames = tools.map((tool) => tool.name);
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const llmToolDefs = tools.map((tool) => ({
      name: encodeToolNameForLlm(tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const client = createClientForRun(config, cell);
    const messages = buildInitialMessages(cell, task.buildPrompt(cell.profileId), evidence);

    for (let turn = 0; turn < config.maxTurns; turn += 1) {
      if (abort.signal.aborted) {
        outcome = 'timeout';
        errorMessage = `Per-run timeout of ${config.timeoutMs}ms exceeded.`;
        break;
      }

      const completion = await client.complete({
        messages,
        tools: llmToolDefs,
        temperature: config.temperature,
      });
      llmTimeMs += completion.latencyMs;
      modelReported = completion.rawModelId;
      tokens = addUsage(tokens, completion.usage);
      messages.push(completion.message);
      transcript.push({
        turnIndex: transcript.length,
        role: 'assistant',
        content: redactSecrets(completion.message.content),
        llmLatencyMs: completion.latencyMs,
        usage: completion.usage,
      });

      const toolCalls = completion.message.toolCalls ?? [];
      if (toolCalls.length === 0) {
        break;
      }

      for (const call of toolCalls) {
        if (abort.signal.aborted) {
          outcome = 'timeout';
          errorMessage = `Per-run timeout of ${config.timeoutMs}ms exceeded.`;
          break;
        }
        toolCallCount += 1;
        const toolStarted = performance.now();
        const resolvedName = resolveEncodedToolName(call.name, toolByName.keys());
        const tool = resolvedName ? toolByName.get(resolvedName) : undefined;
        const toolResult = tool
          ? await invokeTool(tool, call.arguments, abort.signal)
          : {
              ok: false,
              content: JSON.stringify({
                ok: false,
                error: `Unknown tool '${call.name}'.`,
                evidence,
              }),
            };
        const toolLatencyMs = performance.now() - toolStarted;
        toolTimeMs += toolLatencyMs;
        const redactedContent = redactSecrets(toolResult.content);
        messages.push({
          role: 'tool',
          content: redactedContent,
          toolCallId: call.id,
          name: call.name,
        });
        transcript.push({
          turnIndex: transcript.length,
          role: 'tool',
          content: redactedContent,
          toolName: resolvedName ?? call.name,
          toolCallId: call.id,
          toolLatencyMs,
        });
      }
      if (outcome === 'timeout') break;
    }

    checker = task.checkSuccess(bench.snapshot(), cell.profileId);
    if (outcome !== 'timeout') {
      outcome = checker.success ? 'success' : 'failure';
    }
  } catch (error) {
    outcome = abort.signal.aborted ? 'timeout' : 'error';
    errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      checker = task.checkSuccess(bench.snapshot(), cell.profileId);
    } catch {
      checker = {
        success: false,
        reason: 'Checker could not run after agent error.',
        observed: {},
      };
    }
  } finally {
    clearTimeout(timeout);
    await bench.close().catch(() => undefined);
  }

  const finalized = {
    runId,
    evidence,
    cell,
    config,
    harnessGitSha,
    startedAt,
    finishedAt: new Date(),
    wallClockMs: performance.now() - wallStarted,
    llmTimeMs,
    toolTimeMs,
    toolCallCount,
    tokens,
    modelReported,
    toolNames,
    transcript,
    outcome,
    checker,
    turnCount: transcript.filter((entry) => entry.role === 'assistant').length,
  };
  return finalizeRun(
    errorMessage === undefined ? finalized : { ...finalized, errorMessage },
  );
}

function createClientForRun(
  config: BenchConfig,
  cell: ScheduledCell,
): LlmClient {
  if (config.scriptedAgent) {
    return createScriptedClient({
      arm: cell.arm,
      taskId: cell.taskId,
      profileId: cell.profileId,
    });
  }
  const options: {
    provider: string;
    model: string;
    apiKey?: string;
    apiBaseUrl?: string;
  } = {
    provider: config.provider,
    model: config.model,
  };
  if (config.apiKey !== undefined) options.apiKey = config.apiKey;
  if (config.apiBaseUrl !== undefined) options.apiBaseUrl = config.apiBaseUrl;
  return createLlmClient(options);
}

function buildInitialMessages(
  cell: ScheduledCell,
  taskPrompt: string,
  evidence: EvidenceLabel,
): LlmMessage[] {
  if (cell.arm === 'raw') {
    return [
      {
        role: 'system',
        content: [
          `You are controlling a ${evidence} microcontroller through a raw serial/firmware sandbox.`,
          'You do not have Pinout. Read DATASHEET.md, write firmware.json, compile_flash it, and verify via serial if needed.',
          'Never invent device state. Prefer tool results over assumptions.',
          'API keys must never be echoed.',
        ].join(' '),
      },
      { role: 'user', content: taskPrompt },
    ];
  }
  return [
    {
      role: 'system',
      content: [
        `You are controlling a ${evidence} microcontroller through Pinout MCP/SDK tools.`,
        'Discover devices and capabilities, then invoke the needed tools to complete the task.',
        'Never invent device state. Prefer tool results over assumptions.',
        'API keys must never be echoed.',
      ].join(' '),
    },
    { role: 'user', content: taskPrompt },
  ];
}

async function invokeTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ ok: boolean; content: string }> {
  if (signal.aborted) {
    return { ok: false, content: JSON.stringify({ ok: false, error: 'aborted' }) };
  }
  try {
    return await tool.invoke(args);
  } catch (error) {
    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      }),
    };
  }
}

function finalizeRun(input: {
  runId: string;
  evidence: EvidenceLabel;
  cell: ScheduledCell;
  config: BenchConfig;
  harnessGitSha: string;
  startedAt: Date;
  finishedAt: Date;
  wallClockMs: number;
  llmTimeMs: number;
  toolTimeMs: number;
  toolCallCount: number;
  tokens: LlmUsage;
  modelReported: string;
  toolNames: string[];
  transcript: TurnRecord[];
  outcome: RunRecord['outcome'];
  checker: RunRecord['checker'];
  turnCount: number;
  errorMessage?: string;
}): RunRecord {
  const record: RunRecord = {
    runId: input.runId,
    evidence: input.evidence,
    arm: input.cell.arm,
    taskId: input.cell.taskId,
    profileId: input.cell.profileId,
    deviceMode: input.config.deviceMode,
    outcome: input.outcome,
    success: input.outcome === 'success',
    checker: input.checker,
    wallClockMs: input.wallClockMs,
    llmTimeMs: input.llmTimeMs,
    toolTimeMs: input.toolTimeMs,
    turnCount: input.turnCount,
    toolCallCount: input.toolCallCount,
    tokens: input.tokens,
    timeoutMs: input.config.timeoutMs,
    provider: input.config.scriptedAgent ? 'scripted' : input.config.provider,
    modelRequested: input.config.model,
    modelReported: input.modelReported,
    temperature: input.config.temperature,
    toolNames: input.toolNames,
    harnessGitSha: input.harnessGitSha,
    os: `${platform()} ${release()} ${arch()}`,
    nodeVersion: process.version,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    transcript: input.transcript,
    scripted: input.config.scriptedAgent,
  };
  if (input.errorMessage) record.errorMessage = input.errorMessage;
  return record;
}

function aggregateCells(runs: RunRecord[]): SummaryReport['cells'] {
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const key = `${run.arm}|${run.taskId}|${run.profileId}`;
    const list = groups.get(key) ?? [];
    list.push(run);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const [arm, taskId, profileId] = key.split('|') as [ArmId, TaskId, ProfileId];
      return {
        arm,
        taskId,
        profileId,
        stats: summarizeRuns(group),
      };
    });
}

function estimateUsd(usage: LlmUsage, config: BenchConfig): number {
  return (
    (usage.promptTokens / 1_000_000) * config.promptUsdPerMillion +
    (usage.completionTokens / 1_000_000) * config.completionUsdPerMillion
  );
}

function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function buildNote(
  evidence: EvidenceLabel,
  stopReason: string | undefined,
  cumulativeTokens: number,
  estimatedSpendUsd: number,
  config: BenchConfig,
): string {
  const parts = [
    `Evidence=${evidence}.`,
    'All automatic checks use simulator GPIO/servo/ADC journal state, never the model claim.',
    `Cumulative tokens=${cumulativeTokens}.`,
    `Estimated spend USD=${estimatedSpendUsd.toFixed(4)} (pricing hints only; not a bill).`,
  ];
  if (config.budgetUsd !== undefined) parts.push(`Budget USD cap=${config.budgetUsd}.`);
  if (config.maxTokens !== undefined) parts.push(`Max tokens cap=${config.maxTokens}.`);
  if (stopReason) parts.push(`Stopped early: ${stopReason}.`);
  if (evidence === 'HARNESS_TEST_NOT_LLM') {
    parts.push('This output is a harness self-test only and is not an LLM benchmark result.');
  }
  return parts.join(' ');
}

function redactRunForSummary(run: RunRecord): RunRecord {
  const next: RunRecord = {
    ...run,
    transcript: run.transcript.map((turn) => ({
      ...turn,
      content: redactSecrets(turn.content),
    })),
  };
  if (run.errorMessage !== undefined) {
    next.errorMessage = redactSecrets(run.errorMessage);
  } else {
    delete next.errorMessage;
  }
  return next;
}

function readGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: join(import.meta.dirname, '..', '..', '..'),
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}
