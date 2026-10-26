import type { RapToolDef, RapToolsetManifest } from './types.js';

const ownerThreadProps = {
  owner: {
    type: 'string',
    description:
      'Optional per-call owner / principal. Defaults to the RAP group_id (Infinity thread).',
  },
  threadId: {
    type: 'string',
    description:
      'Optional nested thread id; scopes owner as <group_id>:<threadId> (MCP-compatible).',
  },
} as const;

/** Build the Pinout RAP toolset from the static capability catalog. */
export function buildPinoutToolset(endpoint: string): RapToolsetManifest {
  return {
    name: 'pinout',
    description:
      'Pinout physical execution tools for Infinity RAP. Read-only tools inspect devices; physical-output tools actuate under leases. Use pinout__renew_lease / pinout__heartbeat while the agent is paused so fail-safe disarm does not trip. SIMULATED devices are labeled by the daemon.',
    endpoint,
    tools: pinoutRapTools(),
    needsMigration: false,
  };
}

export function pinoutRapTools(): RapToolDef[] {
  return [
    {
      name: 'pinout__list_devices',
      description:
        'READ-ONLY. List every device registered with pinoutd, including capability names when available.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: {
        'x-pinout-side-effect': 'read-only',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"list Pinout devices"',
    },
    {
      name: 'pinout__describe_device',
      description:
        'READ-ONLY. Inspect one device: identity, health, capabilities, operational state, and stateEvidence. observed is the only independent physical evidence.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId'],
        properties: { deviceId: { type: 'string', minLength: 1 } },
      },
      annotations: {
        'x-pinout-side-effect': 'read-only',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"describe " + args.deviceId',
    },
    {
      name: 'pinout__read_state',
      description:
        'READ-ONLY. Read operational state and stateEvidence for one device. Does not require a lease.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId'],
        properties: { deviceId: { type: 'string', minLength: 1 } },
      },
      annotations: {
        'x-pinout-side-effect': 'read-only',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"read state " + args.deviceId',
    },
    {
      name: 'pinout__snapshot',
      description:
        'READ-ONLY. Safety plus every device identity, health, operational state, and stateEvidence in one call.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: {
        'x-pinout-side-effect': 'read-only',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"Pinout snapshot"',
    },
    {
      name: 'pinout__safety_status',
      description: 'READ-ONLY. Read the shared pinoutd safety-halt state. Does not halt or resume.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: {
        'x-pinout-side-effect': 'read-only',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"Pinout safety status"',
    },
    {
      name: 'pinout__dry_run',
      description:
        'READ-ONLY planning. Preview a capability invocation and its safety decision without physical effects.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId', 'capability'],
        properties: {
          deviceId: { type: 'string', minLength: 1 },
          capability: { type: 'string', minLength: 1 },
          args: { type: 'object' },
          ...ownerThreadProps,
        },
      },
      annotations: {
        'x-pinout-side-effect': 'read-only',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"dry-run " + args.deviceId + " " + args.capability',
    },
    {
      name: 'pinout__invoke',
      description:
        'PHYSICAL-OUTPUT. Start a governed capability invocation on pinoutd with waitFor=accepted. Requires an exclusive lease and explicit sys.arm before outputs. Idempotency key defaults to RAP group_id:id (override with idempotencyKey). Waits up to ~10s then returns OPERATION_PENDING with operationId — poll pinout__operation_status or cancel with pinout__cancel_operation. Renew leases / heartbeat while Infinity pauses the agent.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId', 'capability'],
        properties: {
          deviceId: { type: 'string', minLength: 1 },
          capability: { type: 'string', minLength: 1 },
          args: { type: 'object' },
          timeoutMs: { type: 'number' },
          idempotencyKey: {
            type: 'string',
            description:
              'Optional override. Default is group_id:id so retries after an agent pause never double-actuate.',
          },
          ...ownerThreadProps,
        },
      },
      annotations: {
        'x-pinout-side-effect': 'physical-output',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      displayScript: '"invoke " + args.deviceId + " " + args.capability',
    },
    {
      name: 'pinout__operation_status',
      description: 'READ-ONLY. Inspect a governed operation snapshot (status, progress, result).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['operationId'],
        properties: { operationId: { type: 'string', minLength: 1 } },
      },
      annotations: {
        'x-pinout-side-effect': 'read-only',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"op status " + args.operationId',
    },
    {
      name: 'pinout__cancel_operation',
      description:
        'PHYSICAL-OUTPUT / control. Request cooperative cancellation of a governed operation. Idempotent after the operation is terminal.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['operationId'],
        properties: {
          operationId: { type: 'string', minLength: 1 },
          reason: { type: 'string' },
        },
      },
      annotations: {
        'x-pinout-side-effect': 'physical-output',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      displayScript: '"cancel op " + args.operationId',
    },
    {
      name: 'pinout__acquire_lease',
      description:
        'CONTROL-PLANE. Acquire an exclusive or shared-read lease before physical actuation. Owner defaults to the RAP group_id (Infinity thread). TTL is clamped by pinoutd maxLeaseTtlMs; renew before expiry or fail-safe will disarm/safeState.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId'],
        properties: {
          deviceId: { type: 'string', minLength: 1 },
          ttlMs: { type: 'number' },
          mode: { type: 'string', enum: ['exclusive', 'shared-read'] },
          ...ownerThreadProps,
        },
      },
      annotations: {
        'x-pinout-side-effect': 'control-plane',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      displayScript: '"acquire lease " + args.deviceId',
    },
    {
      name: 'pinout__renew_lease',
      description:
        'CONTROL-PLANE. Renew a lease owned by this RAP thread so Infinity agent pauses do not trip fail-safe lease expiry. Pair with pinout__heartbeat for armed devices.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['leaseId'],
        properties: {
          leaseId: { type: 'string', minLength: 1 },
          ttlMs: { type: 'number' },
          ...ownerThreadProps,
        },
      },
      annotations: {
        'x-pinout-side-effect': 'control-plane',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"renew lease " + args.leaseId',
    },
    {
      name: 'pinout__heartbeat',
      description:
        'CONTROL-PLANE. Kick the device deadman heartbeat while the agent is paused. Stale heartbeats trigger host fail-safe disarm/safeState (complementary to firmware watchdog).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['deviceId'],
        properties: {
          deviceId: { type: 'string', minLength: 1 },
          ...ownerThreadProps,
        },
      },
      annotations: {
        'x-pinout-side-effect': 'control-plane',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"heartbeat " + args.deviceId',
    },
    {
      name: 'pinout__release_lease',
      description: 'CONTROL-PLANE. Release a lease owned by this RAP thread (group_id).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['leaseId'],
        properties: { leaseId: { type: 'string', minLength: 1 }, ...ownerThreadProps },
      },
      annotations: {
        'x-pinout-side-effect': 'control-plane',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      displayScript: '"release lease " + args.leaseId',
    },
  ];
}

export { rapCallIdempotencyKey as idempotencyKeyFor } from './idempotency.js';

export function isPhysicalOutputTool(operation: string): boolean {
  return (
    operation === 'pinout__invoke' ||
    operation === 'pinout__cancel_operation' ||
    operation === 'pinout__acquire_lease' ||
    operation === 'pinout__renew_lease' ||
    operation === 'pinout__heartbeat' ||
    operation === 'pinout__release_lease'
  );
}
