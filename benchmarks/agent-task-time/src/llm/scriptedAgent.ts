import { getProfile } from '../devices/profiles.js';
import type { LlmClient, LlmCompletion } from './client.js';
import { encodeToolNameForLlm } from './toolNames.js';
import type {
  ArmId,
  DeviceMode,
  LlmMessage,
  LlmToolDefinition,
  ProfileId,
  TaskId,
} from '../types.js';

/**
 * Deterministic fake agent used ONLY to test the harness.
 * Output must always be stamped HARNESS_TEST_NOT_LLM and is not a benchmark result.
 */
export function createScriptedClient(options: {
  arm: ArmId;
  taskId: TaskId;
  profileId: ProfileId;
  deviceMode?: DeviceMode;
}): LlmClient {
  return new ScriptedLlmClient(
    options.arm,
    options.taskId,
    options.profileId,
    options.deviceMode ?? 'simulated',
  );
}

class ScriptedLlmClient implements LlmClient {
  readonly provider = 'scripted';
  readonly modelRequested = 'HARNESS_TEST_NOT_LLM';
  private step = 0;

  constructor(
    private readonly arm: ArmId,
    private readonly taskId: TaskId,
    private readonly profileId: ProfileId,
    private readonly deviceMode: DeviceMode,
  ) {}

  async complete(options: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    temperature?: number;
  }): Promise<LlmCompletion> {
    void options.temperature;
    const plan =
      this.arm === 'raw'
        ? rawPlan(this.taskId, this.profileId, this.deviceMode)
        : pinoutPlan(this.taskId, this.profileId);
    const current = plan[this.step];
    this.step += 1;
    const available = new Set(options.tools.map((tool) => tool.name));

    if (!current) {
      return completion('HARNESS_TEST_NOT_LLM: scripted agent finished.');
    }

    if (current.toolCalls) {
      const encodedCalls = current.toolCalls.map((call) => ({
        ...call,
        name: encodeToolNameForLlm(call.name),
      }));
      const filtered = encodedCalls.filter((call) => available.has(call.name));
      if (filtered.length === 0) {
        return completion(
          `HARNESS_TEST_NOT_LLM: missing tools ${encodedCalls.map((call) => call.name).join(',')}`,
        );
      }
      return completion(current.content, filtered);
    }
    return completion(current.content);
  }
}

interface ScriptStep {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

function rawPlan(taskId: TaskId, profileId: ProfileId, deviceMode: DeviceMode): ScriptStep[] {
  const profile = getProfile(profileId);
  const steps = buildRawFirmwareSteps(taskId, profileId);
  const firmware = JSON.stringify({ evidence: 'HARNESS_TEST_NOT_LLM', steps }, null, 2);
  if (deviceMode === 'real') {
    return [
      {
        content: 'HARNESS_TEST_NOT_LLM: reading datasheet.',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'DATASHEET.md' } }],
      },
      {
        content: 'HARNESS_TEST_NOT_LLM: writing firmware sketch.',
        toolCalls: [
          { id: 'c2', name: 'write_file', arguments: { path: 'firmware.json', content: firmware } },
        ],
      },
      {
        content: 'HARNESS_TEST_NOT_LLM: compile.',
        toolCalls: [{ id: 'c3', name: 'compile_firmware', arguments: { path: 'firmware.json' } }],
      },
      {
        content: 'HARNESS_TEST_NOT_LLM: flash.',
        toolCalls: [{ id: 'c4', name: 'flash_firmware', arguments: { path: 'firmware.json' } }],
      },
      { content: `HARNESS_TEST_NOT_LLM: done on ${profile.displayName}.` },
    ];
  }
  return [
    {
      content: 'HARNESS_TEST_NOT_LLM: reading datasheet.',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'DATASHEET.md' } }],
    },
    {
      content: 'HARNESS_TEST_NOT_LLM: writing firmware sketch.',
      toolCalls: [
        { id: 'c2', name: 'write_file', arguments: { path: 'firmware.json', content: firmware } },
      ],
    },
    {
      content: 'HARNESS_TEST_NOT_LLM: compile/flash sketch.',
      toolCalls: [{ id: 'c3', name: 'compile_flash', arguments: { path: 'firmware.json' } }],
    },
    { content: `HARNESS_TEST_NOT_LLM: done on ${profile.displayName}.` },
  ];
}

function pinoutPlan(taskId: TaskId, profileId: ProfileId): ScriptStep[] {
  const profile = getProfile(profileId);
  const deviceId = `${profileId}-sim-01`;
  const common: ScriptStep[] = [
    {
      content: 'HARNESS_TEST_NOT_LLM: list devices.',
      toolCalls: [{ id: 'p1', name: 'pinout__list_devices', arguments: {} }],
    },
    {
      content: 'HARNESS_TEST_NOT_LLM: describe device.',
      toolCalls: [{ id: 'p2', name: 'pinout__describe_device', arguments: { deviceId } }],
    },
    {
      content: 'HARNESS_TEST_NOT_LLM: arm device.',
      toolCalls: [{ id: 'p3', name: 'sys.arm', arguments: { timeoutMs: 5000 } }],
    },
  ];

  if (taskId === 'blinkLed') {
    return [
      ...common,
      {
        content: 'HARNESS_TEST_NOT_LLM: LED high.',
        toolCalls: [
          { id: 'p4', name: 'gpio.write', arguments: { pin: profile.ledPin, value: true } },
        ],
      },
      {
        content: 'HARNESS_TEST_NOT_LLM: LED low.',
        toolCalls: [
          { id: 'p5', name: 'gpio.write', arguments: { pin: profile.ledPin, value: false } },
        ],
      },
      { content: 'HARNESS_TEST_NOT_LLM: blink complete.' },
    ];
  }

  if (taskId === 'servoSweep') {
    return [
      ...common,
      {
        content: 'HARNESS_TEST_NOT_LLM: servo to 90.',
        toolCalls: [
          { id: 'p4', name: 'gpio.servo', arguments: { pin: profile.servoPin, angle: 90 } },
        ],
      },
      {
        content: 'HARNESS_TEST_NOT_LLM: servo to 0.',
        toolCalls: [
          { id: 'p5', name: 'gpio.servo', arguments: { pin: profile.servoPin, angle: 0 } },
        ],
      },
      { content: 'HARNESS_TEST_NOT_LLM: servo sweep complete.' },
    ];
  }

  return [
    ...common,
    {
      content: 'HARNESS_TEST_NOT_LLM: analog read.',
      toolCalls: [
        { id: 'p4', name: 'gpio.analogRead', arguments: { pin: profile.adcPin } },
      ],
    },
    { content: 'HARNESS_TEST_NOT_LLM: sensor read complete.' },
  ];
}

function buildRawFirmwareSteps(
  taskId: TaskId,
  profileId: ProfileId,
): Array<{ action: string; payload: Record<string, unknown> }> {
  const profile = getProfile(profileId);
  if (taskId === 'blinkLed') {
    return [
      { action: 'sys.arm', payload: { timeoutMs: 5000 } },
      { action: 'watchdog.configure', payload: { timeoutMs: 10_000 } },
      { action: 'gpio.write', payload: { pin: profile.ledPin, value: true } },
      { action: 'gpio.write', payload: { pin: profile.ledPin, value: false } },
    ];
  }
  if (taskId === 'servoSweep') {
    return [
      { action: 'sys.arm', payload: { timeoutMs: 5000 } },
      { action: 'watchdog.configure', payload: { timeoutMs: 10_000 } },
      { action: 'gpio.servo', payload: { pin: profile.servoPin, angle: 90 } },
      { action: 'gpio.servo', payload: { pin: profile.servoPin, angle: 0 } },
    ];
  }
  return [
    { action: 'sys.arm', payload: { timeoutMs: 5000 } },
    { action: 'gpio.analogRead', payload: { pin: profile.adcPin } },
  ];
}

function completion(
  content: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): LlmCompletion {
  const message: LlmCompletion['message'] = { role: 'assistant', content };
  if (toolCalls && toolCalls.length > 0) message.toolCalls = toolCalls;
  return {
    message,
    model: 'HARNESS_TEST_NOT_LLM',
    rawModelId: 'HARNESS_TEST_NOT_LLM',
    usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 },
    latencyMs: 1,
  };
}
