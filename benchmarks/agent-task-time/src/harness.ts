import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPinoutArmTools } from './arms/pinoutArm.js';
import {
  createHttpPinoutDaemonClient,
  createPinoutRealArmTools,
  type PinoutDaemonClient,
} from './arms/pinoutRealArm.js';
import { createRawArmTools } from './arms/rawArm.js';
import { createRawRealArmTools } from './arms/rawRealArm.js';
import { BenchDevice } from './devices/benchDevice.js';
import { createProcessCommandRunner, type CommandRunner } from './devices/commandRunner.js';
import { promptPhysicalConfirm, type PhysicalConfirmDeps } from './devices/physicalConfirm.js';
import {
  defaultProbeDaemon,
  runRealBoardPreflight,
  type PreflightDeps,
  type PreflightResult,
  type SerialPortInfo,
} from './devices/preflight.js';
import { RealBoardSession, resetBoardBetweenRuns } from './devices/realBoardSession.js';
import { getProfile } from './devices/profiles.js';
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
  ColdWarmRecord,
  EvidenceLabel,
  LlmMessage,
  LlmUsage,
  PhysicalConfirmRecord,
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

export interface HarnessDeps {
  commandRunner?: CommandRunner;
  listSerialPorts?: () => Promise<SerialPortInfo[]>;
  probeDaemon?: PreflightDeps['probeDaemon'];
  pinoutDaemonClient?: PinoutDaemonClient;
  physicalConfirm?: PhysicalConfirmDeps;
}

export interface HarnessResult {
  summary: SummaryReport;
  outputDir: string;
  preflight?: PreflightResult;
}

export async function runHarness(
  config: BenchConfig,
  deps: HarnessDeps = {},
): Promise<HarnessResult> {
  const harnessGitSha = readGitSha();
  const startedSuite = new Date();
  const dateStamp = startedSuite.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const outputDir = join(config.resultsDir, dateStamp);
  const evidence: EvidenceLabel = config.scriptedAgent
    ? 'HARNESS_TEST_NOT_LLM'
    : config.deviceMode === 'real'
      ? 'REAL_HARDWARE'
      : 'SIMULATED';

  const commandRunner = deps.commandRunner ?? createProcessCommandRunner();
  const listSerialPorts =
    deps.listSerialPorts ??
    (async () => {
      const { listSerialPorts: list } = await import('@pinout/core');
      return list();
    });

  let preflight: PreflightResult | undefined;
  let selectedPort = config.serialPort;
  let pinoutdAlreadyRunning: boolean | null = null;

  if (config.deviceMode === 'real' && !config.skipPreflight) {
    const preflightArgs: Parameters<typeof runRealBoardPreflight>[0] = {
      profiles: config.profiles,
      arms: config.arms,
      deps: {
        commandRunner,
        listSerialPorts,
        probeDaemon: deps.probeDaemon ?? defaultProbeDaemon,
      },
    };
    if (config.serialPort !== undefined) preflightArgs.serialPort = config.serialPort;
    if (config.daemonUrl !== undefined) preflightArgs.daemonUrl = config.daemonUrl;
    if (config.daemonToken !== undefined) preflightArgs.daemonToken = config.daemonToken;
    preflight = await runRealBoardPreflight(preflightArgs);
    if (!preflight.ok) {
      throw new Error(
        `Real-board preflight failed:\n- ${preflight.errors.join('\n- ')}\nWarnings: ${
          preflight.warnings.join('; ') || '(none)'
        }`,
      );
    }
    selectedPort = preflight.selectedPort ?? selectedPort;
    pinoutdAlreadyRunning = preflight.daemon.alreadyRunning;
    for (const warning of preflight.warnings) {
      console.log(redactSecrets(`[preflight] ${warning}`));
    }
  }

  if (config.deviceMode === 'real' && !selectedPort && !config.scriptedAgent) {
    throw new Error('Real-board mode requires --serial-port (or a single detected port).');
  }

  const realSessions = new Map<ProfileId, RealBoardSession>();
  const ensureRealSession = (profileId: ProfileId): RealBoardSession => {
    const existing = realSessions.get(profileId);
    if (existing) return existing;
    const session = new RealBoardSession({
      profileId,
      port: selectedPort ?? 'fake-port',
      baudRate: config.baudRate,
      pinoutdAlreadyRunning,
    });
    realSessions.set(profileId, session);
    return session;
  };

  let pinoutClient = deps.pinoutDaemonClient;
  if (!pinoutClient && config.deviceMode === 'real') {
    const clientOpts: { baseUrl: string; token?: string } = {
      baseUrl: config.daemonUrl ?? 'http://127.0.0.1:8787',
    };
    if (config.daemonToken !== undefined) clientOpts.token = config.daemonToken;
    pinoutClient = createHttpPinoutDaemonClient(clientOpts);
  }

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

    if (config.deviceMode === 'real') {
      const session = ensureRealSession(cell.profileId);
      await resetBoardBetweenRuns(session, { commandRunner });
    }

    const runArgs: Parameters<typeof executeRun>[0] = {
      config,
      cell,
      evidence,
      harnessGitSha,
      commandRunner,
      listSerialPorts,
    };
    if (pinoutClient) runArgs.pinoutClient = pinoutClient;
    if (config.deviceMode === 'real') runArgs.realSession = ensureRealSession(cell.profileId);
    if (deps.physicalConfirm) runArgs.physicalConfirmDeps = deps.physicalConfirm;
    const run = await executeRun(runArgs);
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
    temperature: config.temperatureRecorded,
    runsPerCell: config.runs,
    deviceMode: config.deviceMode,
    scripted: config.scriptedAgent,
    note: buildNote(evidence, stopReason, cumulativeTokens, estimatedSpendUsd, config),
    cells,
    runs: runs.map((run) => redactRunForSummary(run)),
  };
  if (config.deviceMode === 'real') {
    summary.hardwareStatus =
      'UNTESTED on physical hardware in this repository until a dated hardware record exists.';
  }

  writeSuiteArtifacts(outputDir, summary, config);
  const result: HarnessResult = { summary, outputDir };
  if (preflight) result.preflight = preflight;
  return result;
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

async function executeRun(options: {
  config: BenchConfig;
  cell: ScheduledCell;
  evidence: EvidenceLabel;
  harnessGitSha: string;
  commandRunner: CommandRunner;
  listSerialPorts: () => Promise<SerialPortInfo[]>;
  pinoutClient?: PinoutDaemonClient;
  realSession?: RealBoardSession;
  physicalConfirmDeps?: PhysicalConfirmDeps;
}): Promise<RunRecord> {
  const { config, cell, evidence, harnessGitSha } = options;
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
  const transcript: TurnRecord[] = [];
  let llmTimeMs = 0;
  let toolTimeMs = 0;
  let toolCallCount = 0;
  let tokens: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let modelReported = config.scriptedAgent ? 'HARNESS_TEST_NOT_LLM' : 'unknown';
  let toolNames: string[] = [];
  let outcome: RunRecord['outcome'] = 'failure';
  let errorMessage: string | undefined;
  let physicalConfirm: PhysicalConfirmRecord | undefined;
  let coldWarm: ColdWarmRecord | undefined;

  const simulated =
    config.deviceMode === 'simulated'
      ? new BenchDevice(cell.profileId, 'simulated')
      : undefined;
  const snapshotProvider = () =>
    simulated ? simulated.snapshot() : options.realSession!.snapshot();

  let checker = task.checkSuccess(snapshotProvider(), cell.profileId);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), config.timeoutMs);

  try {
    const toolArgs: Parameters<typeof createToolsForRun>[0] = {
      config,
      cell,
      workspaceDir,
      commandRunner: options.commandRunner,
      listSerialPorts: options.listSerialPorts,
    };
    if (simulated) toolArgs.simulated = simulated;
    if (options.realSession) toolArgs.realSession = options.realSession;
    if (options.pinoutClient) toolArgs.pinoutClient = options.pinoutClient;
    const tools = await createToolsForRun(toolArgs);
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

      const completionArgs: {
        messages: LlmMessage[];
        tools: typeof llmToolDefs;
        temperature?: number;
      } = { messages, tools: llmToolDefs };
      if (config.temperatureSend !== undefined) {
        completionArgs.temperature = config.temperatureSend;
      }
      const completion = await client.complete(completionArgs);
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
      if (toolCalls.length === 0) break;

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

    checker = task.checkSuccess(snapshotProvider(), cell.profileId);
    if (outcome !== 'timeout') {
      outcome = checker.success ? 'success' : 'failure';
    }

    if (config.deviceMode === 'real') {
      const confirmArgs: Parameters<typeof promptPhysicalConfirm>[0] = {
        taskId: cell.taskId,
        profileLabel: getProfile(cell.profileId).displayName,
        enabled: config.confirmPhysical,
      };
      if (options.physicalConfirmDeps) confirmArgs.deps = options.physicalConfirmDeps;
      physicalConfirm = await promptPhysicalConfirm(confirmArgs);
      coldWarm = options.realSession?.coldWarmNote(cell.arm);
    }
  } catch (error) {
    outcome = abort.signal.aborted ? 'timeout' : 'error';
    errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
    try {
      checker = task.checkSuccess(snapshotProvider(), cell.profileId);
    } catch {
      checker = {
        success: false,
        reason: 'Checker could not run after agent error.',
        observed: {},
      };
    }
  } finally {
    clearTimeout(timeout);
    await simulated?.close().catch(() => undefined);
  }

  const finalized: Parameters<typeof finalizeRun>[0] = {
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
  if (errorMessage !== undefined) finalized.errorMessage = errorMessage;
  if (physicalConfirm !== undefined) finalized.physicalConfirm = physicalConfirm;
  if (coldWarm !== undefined) finalized.coldWarm = coldWarm;
  return finalizeRun(finalized);
}

async function createToolsForRun(options: {
  config: BenchConfig;
  cell: ScheduledCell;
  workspaceDir: string;
  simulated?: BenchDevice;
  realSession?: RealBoardSession;
  commandRunner: CommandRunner;
  listSerialPorts: () => Promise<SerialPortInfo[]>;
  pinoutClient?: PinoutDaemonClient;
}): Promise<AgentTool[]> {
  if (options.config.deviceMode === 'simulated') {
    if (!options.simulated) throw new Error('Missing simulated bench device.');
    return options.cell.arm === 'raw'
      ? createRawArmTools(options.simulated, options.workspaceDir)
      : createPinoutArmTools(options.simulated);
  }
  if (!options.realSession) throw new Error('Missing real board session.');
  if (options.cell.arm === 'raw') {
    return createRawRealArmTools(options.realSession, options.workspaceDir, {
      commandRunner: options.commandRunner,
      listSerialPorts: options.listSerialPorts,
    });
  }
  if (!options.pinoutClient) {
    throw new Error('Pinout real arm requires a pinoutd client.');
  }
  return createPinoutRealArmTools(options.realSession, options.pinoutClient);
}

function createClientForRun(config: BenchConfig, cell: ScheduledCell): LlmClient {
  if (config.scriptedAgent) {
    return createScriptedClient({
      arm: cell.arm,
      taskId: cell.taskId,
      profileId: cell.profileId,
      deviceMode: config.deviceMode,
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
  // Keep prompts short and parallel across arms (fairness).
  if (cell.arm === 'raw') {
    return [
      {
        role: 'system',
        content: [
          `${evidence} raw baseline: no Pinout.`,
          'Use datasheet + compile/flash + serial tools only.',
          'Do not invent device state.',
        ].join(' '),
      },
      { role: 'user', content: taskPrompt },
    ];
  }
  return [
    {
      role: 'system',
      content: [
        `${evidence} Pinout tools: list/describe/read_state and task capabilities.`,
        'Do not invent device state.',
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
  physicalConfirm?: PhysicalConfirmRecord;
  coldWarm?: ColdWarmRecord;
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
    temperature: input.config.temperatureRecorded,
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
  if (input.physicalConfirm) record.physicalConfirm = input.physicalConfirm;
  if (input.coldWarm) record.coldWarm = input.coldWarm;
  if (input.config.deviceMode === 'real') {
    record.hardwareStatus =
      input.physicalConfirm?.operatorAnswer === 'yes' ? 'OPERATOR_CONFIRMED' : 'JOURNAL_ONLY';
  }
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
      return { arm, taskId, profileId, stats: summarizeRuns(group) };
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
    'Automatic checks use device journal/state, never the model claim.',
    `Temperature recorded as ${JSON.stringify(config.temperatureRecorded)}.`,
    `Cumulative tokens=${cumulativeTokens}.`,
    `Estimated spend USD=${estimatedSpendUsd.toFixed(4)} (pricing hints only; not a bill).`,
  ];
  if (config.deviceMode === 'real') {
    parts.push(
      'REAL_HARDWARE mode is UNTESTED on physical boards in this repository until a dated hardware record exists.',
    );
  }
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
  if (run.errorMessage !== undefined) next.errorMessage = redactSecrets(run.errorMessage);
  else delete next.errorMessage;
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
