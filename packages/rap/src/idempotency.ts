import { createHash } from 'node:crypto';

/** RAP call identity — preferred idempotency key for every RAP-originated invoke. */
export function rapCallIdempotencyKey(groupId: string, id: string): string {
  return `${groupId}:${id}`;
}

/**
 * Deterministic auto key for physical outputs when a caller omits both the RAP
 * call key and an explicit idempotencyKey (mirrors MCP #62 behavior).
 */
export function deterministicIdempotencyKey(
  deviceId: string,
  capability: string,
  args: Record<string, unknown>,
  owner: string,
): string {
  const payload = stableStringify({ deviceId, capability, args, owner });
  return `auto-${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`;
}

export function resolveInvokeIdempotencyKey(input: {
  groupId: string;
  callId: string;
  args: Record<string, unknown>;
  deviceId: string;
  capability: string;
  owner: string;
  physicalOutput?: boolean;
}): { idempotencyKey: string; idempotencyKeyGenerated: boolean; source: 'rap' | 'caller' | 'auto' } {
  if (typeof input.args.idempotencyKey === 'string' && input.args.idempotencyKey.length > 0) {
    return {
      idempotencyKey: input.args.idempotencyKey,
      idempotencyKeyGenerated: false,
      source: 'caller',
    };
  }
  // RAP invocations always have group_id + id — use that as the stable retry key.
  if (input.groupId.length > 0 && input.callId.length > 0) {
    return {
      idempotencyKey: rapCallIdempotencyKey(input.groupId, input.callId),
      idempotencyKeyGenerated: true,
      source: 'rap',
    };
  }
  if (input.physicalOutput !== false) {
    return {
      idempotencyKey: deterministicIdempotencyKey(
        input.deviceId,
        input.capability,
        objectArg(input.args.args),
        input.owner,
      ),
      idempotencyKeyGenerated: true,
      source: 'auto',
    };
  }
  return {
    idempotencyKey: rapCallIdempotencyKey(input.groupId || 'rap', input.callId || 'unknown'),
    idempotencyKeyGenerated: true,
    source: 'auto',
  };
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
