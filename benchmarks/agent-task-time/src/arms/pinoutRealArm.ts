import { pinoutTaskCapabilityNames } from './fairTools.js';
import type { RealBoardSession } from '../devices/realBoardSession.js';
import type { AgentTool, AgentToolResult } from '../types.js';

export interface PinoutDaemonClient {
  listDevices(): Promise<unknown>;
  describeDevice(deviceId: string): Promise<unknown>;
  readState(deviceId: string): Promise<unknown>;
  invoke(deviceId: string, action: string, payload: Record<string, unknown>): Promise<unknown>;
}

/**
 * Arm B (real): Pinout tools against a running pinoutd (warm connection).
 * Same compact tool budget as the simulated Pinout arm.
 */
export function createPinoutRealArmTools(
  session: RealBoardSession,
  client: PinoutDaemonClient,
  deviceId = 'board-01',
): AgentTool[] {
  const discovery: AgentTool[] = [
    {
      name: 'pinout__list_devices',
      description: 'List devices from the running pinoutd daemon.',
      inputSchema: { type: 'object', properties: {} },
      async invoke() {
        const devices = await client.listDevices();
        return ok({ devices, evidence: 'REAL_HARDWARE' });
      },
    },
    {
      name: 'pinout__describe_device',
      description: 'Describe a device via pinoutd.',
      inputSchema: {
        type: 'object',
        properties: { deviceId: { type: 'string' } },
        required: ['deviceId'],
      },
      async invoke(args) {
        const id = typeof args.deviceId === 'string' ? args.deviceId : deviceId;
        const described = await client.describeDevice(id);
        return ok({
          described,
          pins: {
            ledPin: session.profile.ledPin,
            servoPin: session.profile.servoPin,
            adcPin: session.profile.adcPin,
          },
          evidence: 'REAL_HARDWARE',
        });
      },
    },
    {
      name: 'pinout__read_state',
      description: 'Read device state evidence from pinoutd / harness journal.',
      inputSchema: {
        type: 'object',
        properties: { deviceId: { type: 'string' } },
        required: ['deviceId'],
      },
      async invoke(args) {
        const id = typeof args.deviceId === 'string' ? args.deviceId : deviceId;
        const remote = await client.readState(id);
        const local = session.snapshot();
        return ok({
          remote,
          localJournalTail: local.journal.slice(-20),
          levels: local.levels,
          servos: local.servos,
          evidence: 'REAL_HARDWARE',
        });
      },
    },
  ];

  const capabilities: AgentTool[] = pinoutTaskCapabilityNames.map((name) => ({
    name,
    description: `Pinout capability ${name} via pinoutd (REAL_HARDWARE).`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    async invoke(args): Promise<AgentToolResult> {
      try {
        const result = await client.invoke(deviceId, name, args);
        mirrorToSession(session, name, args, result);
        return ok({ action: name, result, evidence: 'REAL_HARDWARE' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          content: JSON.stringify({
            ok: false,
            action: name,
            error: message,
            evidence: 'REAL_HARDWARE',
          }),
          structured: { ok: false, action: name, error: message, evidence: 'REAL_HARDWARE' },
        };
      }
    },
  }));

  return [...discovery, ...capabilities];
}

function mirrorToSession(
  session: RealBoardSession,
  action: string,
  payload: Record<string, unknown>,
  result: unknown,
): void {
  if (action === 'sys.arm') session.recordState('armed', { action, payload, result });
  if (action === 'sys.disarm') session.recordState('disarmed', { action, payload, result });
  if (action === 'gpio.write' && typeof payload.pin === 'number') {
    session.recordLevel(payload.pin, Boolean(payload.value), { action, payload, result });
  }
  if (
    action === 'gpio.servo' &&
    typeof payload.pin === 'number' &&
    typeof payload.angle === 'number'
  ) {
    session.recordServo(payload.pin, payload.angle, { action, payload, result });
  }
  if (action === 'gpio.analogRead' && typeof payload.pin === 'number') {
    const value =
      result &&
      typeof result === 'object' &&
      typeof (result as { value?: unknown }).value === 'number'
        ? ((result as { value: number }).value)
        : (session.analogLevels.get(payload.pin) ?? 0);
    session.recordAnalogRead(payload.pin, value, { action, payload, result });
  }
}

export function createHttpPinoutDaemonClient(options: {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): PinoutDaemonClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetchImpl(`${base}${path}`, { ...init, headers });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`pinoutd ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }

  return {
    listDevices: () => request('/v1/devices'),
    describeDevice: (deviceId) => request(`/v1/devices/${encodeURIComponent(deviceId)}`),
    readState: (deviceId) => request(`/v1/devices/${encodeURIComponent(deviceId)}/state`),
    invoke: (deviceId, action, payload) =>
      request(`/v1/devices/${encodeURIComponent(deviceId)}/invoke`, {
        method: 'POST',
        body: JSON.stringify({ action, payload }),
      }),
  };
}

function ok(structured: Record<string, unknown>): AgentToolResult {
  return { ok: true, content: JSON.stringify(structured), structured };
}
