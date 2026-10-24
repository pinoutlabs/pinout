import {
  AWARENESS_TRANSITIONS,
  type AwarenessRecord,
  type AwarenessState,
  type AwarenessStalenessConfig,
  DEFAULT_STALENESS,
} from './types.js';

export class InvalidAwarenessTransitionError extends Error {
  constructor(
    readonly from: AwarenessState,
    readonly to: AwarenessState,
    readonly id: string,
  ) {
    super(`Invalid awareness transition for '${id}': ${from} → ${to}`);
    this.name = 'InvalidAwarenessTransitionError';
  }
}

export function canTransition(from: AwarenessState, to: AwarenessState): boolean {
  if (from === to) return true;
  return AWARENESS_TRANSITIONS[from].includes(to);
}

export function assertTransition(record: AwarenessRecord, to: AwarenessState): void {
  if (!canTransition(record.state, to)) {
    throw new InvalidAwarenessTransitionError(record.state, to, record.id);
  }
}

/**
 * Apply a transition, returning a new record. Same-state is a no-op identity.
 */
export function transition(
  record: AwarenessRecord,
  to: AwarenessState,
  patch: Partial<AwarenessRecord> = {},
): AwarenessRecord {
  assertTransition(record, to);
  const next: AwarenessRecord = {
    ...record,
    ...patch,
    state: to,
    identity: patch.identity ? { ...record.identity, ...patch.identity } : record.identity,
    health: patch.health ?? record.health,
  };
  if (patch.connector !== undefined) {
    next.connector = patch.connector;
  } else if (record.connector !== undefined) {
    next.connector = record.connector;
  } else {
    delete next.connector;
  }
  return next;
}

/** Whether the guessed module is a real enrollable module (not unknown/*). */
export function isKnownModule(moduleId: string | undefined): boolean {
  if (!moduleId) return false;
  if (moduleId.startsWith('unknown/')) return false;
  if (moduleId === 'unknown') return false;
  return true;
}

/**
 * Choose the presence state for a freshly observed (or re-observed) device.
 * Never auto-enrolls: known modules go to PENDING_ENROLL until approved.
 */
export function presenceStateForObservation(options: {
  enrolled: boolean;
  guessedModuleId?: string;
  hasIdentitySignal: boolean;
}): AwarenessState {
  if (options.enrolled) return 'ONLINE';
  if (isKnownModule(options.guessedModuleId)) return 'PENDING_ENROLL';
  if (options.hasIdentitySignal) return 'IDENTIFIED';
  return 'SEEN';
}

export function evaluateStaleness(
  record: AwarenessRecord,
  now: number,
  config: AwarenessStalenessConfig = DEFAULT_STALENESS,
): AwarenessState | undefined {
  if (record.state === 'OFFLINE') return undefined;
  const age = now - record.lastSeen;
  if (age >= config.offlineAfterMs && canTransition(record.state, 'OFFLINE')) {
    return 'OFFLINE';
  }
  if (
    age >= config.staleAfterMs &&
    record.state !== 'STALE' &&
    canTransition(record.state, 'STALE')
  ) {
    return 'STALE';
  }
  return undefined;
}
