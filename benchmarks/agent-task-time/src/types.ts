/** Shared types for the agent task-time benchmark. */

import type { TemperatureRecord } from './llm/temperature.js';

export type { TemperatureRecord };

export type ArmId = 'raw' | 'pinout';

export type DeviceMode = 'simulated' | 'real';

export type ProfileId = 'esp32' | 'pico' | 'uno';

export type TaskId = 'blinkLed' | 'servoSweep' | 'readSensor';

export type RunOutcome = 'success' | 'failure' | 'timeout' | 'error';

export type EvidenceLabel = 'SIMULATED' | 'REAL_HARDWARE' | 'HARNESS_TEST_NOT_LLM';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmCompletion {
  message: LlmMessage;
  model: string;
  usage: LlmUsage;
  rawModelId: string;
  latencyMs: number;
}

export interface AgentToolResult {
  ok: boolean;
  content: string;
  structured?: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: (args: Record<string, unknown>) => Promise<AgentToolResult>;
}

export interface DeviceJournalEntry {
  atMs: number;
  kind: string;
  pin?: number;
  value?: unknown;
  detail?: Record<string, unknown>;
}

export interface DeviceSnapshot {
  profileId: ProfileId;
  mode: DeviceMode;
  levels: Record<string, boolean>;
  servos: Record<string, number>;
  analogLevels: Record<string, number>;
  deviceState: string;
  journal: DeviceJournalEntry[];
}

export interface TaskDefinition {
  id: TaskId;
  title: string;
  intent: string;
  profiles: ProfileId[];
  buildPrompt: (profileId: ProfileId) => string;
  checkSuccess: (snapshot: DeviceSnapshot, profileId: ProfileId) => CheckerResult;
}

export interface CheckerResult {
  success: boolean;
  reason: string;
  observed: Record<string, unknown>;
}

export interface TurnRecord {
  turnIndex: number;
  role: 'assistant' | 'tool';
  content: string;
  toolName?: string;
  toolCallId?: string;
  llmLatencyMs?: number;
  toolLatencyMs?: number;
  usage?: LlmUsage;
}

export interface PhysicalConfirmRecord {
  prompted: boolean;
  operatorAnswer?: 'yes' | 'no' | 'skipped';
  promptText: string;
}

export interface ColdWarmRecord {
  pinoutdAlreadyRunning: boolean | null;
  firstFlashInSuite: boolean;
  flashDurationMs?: number;
  boardResetMs?: number;
  note: string;
}

export interface RunRecord {
  runId: string;
  evidence: EvidenceLabel;
  arm: ArmId;
  taskId: TaskId;
  profileId: ProfileId;
  deviceMode: DeviceMode;
  outcome: RunOutcome;
  success: boolean;
  checker: CheckerResult;
  wallClockMs: number;
  llmTimeMs: number;
  toolTimeMs: number;
  turnCount: number;
  toolCallCount: number;
  tokens: LlmUsage;
  timeoutMs: number;
  errorMessage?: string;
  provider: string;
  modelRequested: string;
  modelReported: string;
  /** Actual temperature sent, or "model default" when omitted. */
  temperature: TemperatureRecord;
  toolNames: string[];
  harnessGitSha: string;
  os: string;
  nodeVersion: string;
  startedAt: string;
  finishedAt: string;
  transcript: TurnRecord[];
  scripted: boolean;
  physicalConfirm?: PhysicalConfirmRecord;
  coldWarm?: ColdWarmRecord;
  hardwareStatus?: 'UNTESTED' | 'OPERATOR_CONFIRMED' | 'JOURNAL_ONLY';
}

export interface BenchConfig {
  provider: string;
  model: string;
  /** Operator-requested temperature, if any. */
  temperatureRequested?: number;
  temperatureExplicitlySet: boolean;
  /** What will be recorded / what the client should send. */
  temperatureRecorded: TemperatureRecord;
  temperatureSend?: number;
  runs: number;
  timeoutMs: number;
  maxTurns: number;
  deviceMode: DeviceMode;
  profiles: ProfileId[];
  tasks: TaskId[];
  arms: ArmId[];
  dryRun: boolean;
  scriptedAgent: boolean;
  resultsDir: string;
  seed: number;
  budgetUsd?: number;
  maxTokens?: number;
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
  apiKey?: string;
  apiBaseUrl?: string;
  /** Real-board options */
  confirmPhysical: boolean;
  serialPort?: string;
  baudRate: number;
  daemonUrl?: string;
  daemonToken?: string;
  skipPreflight: boolean;
}

export interface AggregateStats {
  count: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  errorCount: number;
  successRate: number;
  wallClockMs: { median: number; p90: number; mean: number; min: number; max: number };
  llmTimeMs: { median: number; p90: number; mean: number };
  toolTimeMs: { median: number; p90: number; mean: number };
  turnCount: { median: number; mean: number };
  toolCallCount: { median: number; mean: number };
  tokens: { medianTotal: number; meanTotal: number };
}

export interface SummaryReport {
  evidence: EvidenceLabel;
  generatedAt: string;
  harnessGitSha: string;
  os: string;
  nodeVersion: string;
  provider: string;
  modelRequested: string;
  modelReported: string;
  temperature: TemperatureRecord;
  runsPerCell: number;
  deviceMode: DeviceMode;
  scripted: boolean;
  note: string;
  hardwareStatus?: string;
  cells: Array<{
    arm: ArmId;
    taskId: TaskId;
    profileId: ProfileId;
    stats: AggregateStats;
  }>;
  runs: RunRecord[];
}
