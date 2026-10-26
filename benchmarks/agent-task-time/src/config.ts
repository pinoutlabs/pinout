import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveTemperaturePolicy } from './llm/temperature.js';
import type { ArmId, BenchConfig, DeviceMode, ProfileId, TaskId } from './types.js';

const benchRoot = resolve(import.meta.dirname, '..');

export function getBenchRoot(): string {
  return benchRoot;
}

export function parseCliArgs(argv: string[]): BenchConfig {
  const env = process.env;
  let runs = readPositiveInt(env.PINOUT_BENCH_RUNS, 10);
  let timeoutMs = readPositiveInt(env.PINOUT_BENCH_TIMEOUT_MS, 180_000);
  let maxTurns = readPositiveInt(env.PINOUT_BENCH_MAX_TURNS, 40);
  let temperatureRequested: number | undefined;
  let temperatureExplicitlySet = false;
  if (env.PINOUT_BENCH_TEMPERATURE !== undefined && env.PINOUT_BENCH_TEMPERATURE !== '') {
    temperatureRequested = readFloat(env.PINOUT_BENCH_TEMPERATURE, Number.NaN);
    temperatureExplicitlySet = true;
  }
  let provider = env.PINOUT_BENCH_PROVIDER ?? 'openai';
  let model = env.PINOUT_BENCH_MODEL ?? 'gpt-4o-mini';
  let deviceMode: DeviceMode =
    env.PINOUT_BENCH_DEVICE === 'real' || env.PINOUT_BENCH_DEVICE === 'simulated'
      ? env.PINOUT_BENCH_DEVICE
      : 'simulated';
  let dryRun = false;
  let scriptedAgent = false;
  let seed = readPositiveInt(env.PINOUT_BENCH_SEED, 42);
  let profiles: ProfileId[] = ['esp32', 'pico', 'uno'];
  let tasks: TaskId[] = ['blinkLed', 'servoSweep', 'readSensor'];
  let arms: ArmId[] = ['raw', 'pinout'];
  let resultsDir = join(benchRoot, 'results');
  let apiBaseUrl = env.PINOUT_BENCH_API_BASE_URL;
  let budgetUsd = readOptionalFloat(env.PINOUT_BENCH_BUDGET_USD);
  let maxTokens = readOptionalPositiveInt(env.PINOUT_BENCH_MAX_TOKENS);
  let promptUsdPerMillion = readFloat(env.PINOUT_BENCH_PROMPT_USD_PER_MILLION, 0.15);
  let completionUsdPerMillion = readFloat(env.PINOUT_BENCH_COMPLETION_USD_PER_MILLION, 0.6);
  let confirmPhysical = env.PINOUT_BENCH_CONFIRM_PHYSICAL === '1';
  let serialPort = env.PINOUT_BENCH_SERIAL_PORT ?? env.PINOUT_PORT;
  let baudRate = readPositiveInt(env.PINOUT_BENCH_BAUD ?? env.PINOUT_BAUD, 115200);
  let daemonUrl = env.PINOUT_BENCH_DAEMON_URL ?? env.PINOUT_DAEMON_URL;
  let daemonToken = env.PINOUT_BENCH_DAEMON_TOKEN ?? env.PINOUT_TOKEN;
  let skipPreflight = env.PINOUT_BENCH_SKIP_PREFLIGHT === '1';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--runs' && next) {
      runs = readPositiveInt(next, runs);
      index += 1;
    } else if (arg === '--timeout-ms' && next) {
      timeoutMs = readPositiveInt(next, timeoutMs);
      index += 1;
    } else if (arg === '--max-turns' && next) {
      maxTurns = readPositiveInt(next, maxTurns);
      index += 1;
    } else if (arg === '--temperature' && next) {
      temperatureRequested = readFloat(next, Number.NaN);
      temperatureExplicitlySet = true;
      index += 1;
    } else if (arg === '--provider' && next) {
      provider = next;
      index += 1;
    } else if (arg === '--model' && next) {
      model = next;
      index += 1;
    } else if (arg === '--device' && next) {
      if (next !== 'simulated' && next !== 'real') {
        throw new Error(`--device must be simulated or real, got '${next}'.`);
      }
      deviceMode = next;
      index += 1;
    } else if (arg === '--profiles' && next) {
      profiles = next.split(',').map(parseProfileId);
      index += 1;
    } else if (arg === '--tasks' && next) {
      tasks = next.split(',').map(parseTaskId);
      index += 1;
    } else if (arg === '--arms' && next) {
      arms = next.split(',').map(parseArmId);
      index += 1;
    } else if (arg === '--seed' && next) {
      seed = readPositiveInt(next, seed);
      index += 1;
    } else if (arg === '--results-dir' && next) {
      resultsDir = resolve(next);
      index += 1;
    } else if (arg === '--api-base-url' && next) {
      apiBaseUrl = next;
      index += 1;
    } else if (arg === '--budget-usd' && next) {
      budgetUsd = readFloat(next, Number.NaN);
      if (!(budgetUsd > 0)) throw new Error('--budget-usd must be a positive number.');
      index += 1;
    } else if (arg === '--max-tokens' && next) {
      maxTokens = readPositiveInt(next, 0);
      index += 1;
    } else if (arg === '--prompt-usd-per-million' && next) {
      promptUsdPerMillion = readFloat(next, promptUsdPerMillion);
      index += 1;
    } else if (arg === '--completion-usd-per-million' && next) {
      completionUsdPerMillion = readFloat(next, completionUsdPerMillion);
      index += 1;
    } else if (arg === '--serial-port' && next) {
      serialPort = next;
      index += 1;
    } else if (arg === '--baud' && next) {
      baudRate = readPositiveInt(next, baudRate);
      index += 1;
    } else if (arg === '--daemon-url' && next) {
      daemonUrl = next;
      index += 1;
    } else if (arg === '--daemon-token' && next) {
      daemonToken = next;
      index += 1;
    } else if (arg === '--confirm-physical') {
      confirmPhysical = true;
    } else if (arg === '--skip-preflight') {
      skipPreflight = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
      scriptedAgent = true;
    } else if (arg === '--scripted-agent') {
      scriptedAgent = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else if (arg?.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const temperaturePolicy = resolveTemperaturePolicy({
    modelId: model,
    requested: temperatureRequested,
    temperatureExplicitlySet,
  });

  const apiKey = resolveApiKey(provider, env);
  if (!scriptedAgent && !apiKey) {
    throw new Error(
      `No API key found for provider '${provider}'. Set OPENAI_API_KEY (or the provider key), or pass --dry-run / --scripted-agent to exercise the harness without an LLM.`,
    );
  }

  mkdirSync(resultsDir, { recursive: true });

  const config: BenchConfig = {
    provider,
    model,
    temperatureExplicitlySet,
    temperatureRecorded: temperaturePolicy.record,
    runs,
    timeoutMs,
    maxTurns,
    deviceMode,
    profiles,
    tasks,
    arms,
    dryRun,
    scriptedAgent,
    resultsDir,
    seed,
    promptUsdPerMillion,
    completionUsdPerMillion,
    confirmPhysical,
    baudRate,
    skipPreflight,
  };
  if (temperatureRequested !== undefined) config.temperatureRequested = temperatureRequested;
  if (temperaturePolicy.send !== undefined) config.temperatureSend = temperaturePolicy.send;
  if (budgetUsd !== undefined) config.budgetUsd = budgetUsd;
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  if (apiKey !== undefined) config.apiKey = apiKey;
  if (apiBaseUrl !== undefined) config.apiBaseUrl = apiBaseUrl;
  if (serialPort !== undefined) config.serialPort = serialPort;
  if (daemonUrl !== undefined) config.daemonUrl = daemonUrl;
  if (daemonToken !== undefined) config.daemonToken = daemonToken;
  return config;
}

function resolveApiKey(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const normalized = provider.toLowerCase();
  if (env.PINOUT_BENCH_API_KEY) return env.PINOUT_BENCH_API_KEY;
  if (normalized === 'openai' || normalized === 'openai-compatible') {
    return env.OPENAI_API_KEY;
  }
  if (normalized === 'anthropic') return env.ANTHROPIC_API_KEY;
  if (normalized === 'google' || normalized === 'gemini') {
    return env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
  }
  return env.OPENAI_API_KEY ?? env.ANTHROPIC_API_KEY;
}

function parseProfileId(value: string): ProfileId {
  if (value === 'esp32' || value === 'pico' || value === 'uno') return value;
  throw new Error(`Unknown profile '${value}'. Use esp32,pico,uno.`);
}

function parseTaskId(value: string): TaskId {
  if (value === 'blinkLed' || value === 'servoSweep' || value === 'readSensor') return value;
  throw new Error(`Unknown task '${value}'. Use blinkLed,servoSweep,readSensor.`);
}

function parseArmId(value: string): ArmId {
  if (value === 'raw' || value === 'pinout') return value;
  throw new Error(`Unknown arm '${value}'. Use raw,pinout.`);
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got '${raw}'.`);
  }
  return parsed;
}

function readOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  return readPositiveInt(raw, 0);
}

function readFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got '${raw}'.`);
  }
  return parsed;
}

function readOptionalFloat(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got '${raw}'.`);
  }
  return parsed;
}

function printHelpAndExit(): never {
  console.log(`Usage: npm run bench:agent -- [options]

Measure wall-clock time for an LLM agent on the same hardware tasks with and
without Pinout.

Simulated (default, labelled SIMULATED):
  PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \\
    npm run bench:agent -- --runs 5

Real boards (labelled REAL_HARDWARE; UNTESTED until a dated hardware record exists):
  PINOUT_BENCH_PROVIDER=openai PINOUT_BENCH_MODEL=gpt-6.1-sol OPENAI_API_KEY=... \\
    npm run bench:agent -- --device real --profiles esp32 --runs 5 --serial-port /dev/ttyUSB0

Options:
  --runs N              Repeats per arm per task per profile (default 10)
  --timeout-ms N        Per-run timeout (default 180000)
  --max-turns N         Max agent turns per run (default 40)
  --provider NAME       LLM provider (default openai)
  --model NAME          Model id
  --temperature N       Sampling temperature (omitted for models that reject it)
  --profiles LIST       Comma list: esp32,pico,uno
  --tasks LIST          Comma list: blinkLed,servoSweep,readSensor
  --arms LIST           Comma list: raw,pinout
  --device MODE         simulated (default) or real
  --serial-port PATH    Hardware serial port (or PINOUT_PORT / PINOUT_BENCH_SERIAL_PORT)
  --baud N              Serial baud (default 115200)
  --daemon-url URL      pinoutd base URL for Arm B
  --daemon-token TOKEN  pinoutd token
  --confirm-physical    Prompt operator yes/no after each real run
  --skip-preflight      Skip real-board preflight (tests only)
  --budget-usd N        Stop after estimated spend reaches N
  --max-tokens N        Stop after cumulative tokens reach N
  --dry-run             Scripted fake agent; stamps HARNESS_TEST_NOT_LLM
  --scripted-agent      Scripted agent without implying a dry config pass
  --seed N              RNG seed for arm interleaving (default 42)
  --results-dir PATH    Output directory root (created at run time)
  --api-base-url URL    OpenAI-compatible base URL

API keys are never written to transcripts, summary JSON, or markdown.
`);
  process.exit(0);
}
