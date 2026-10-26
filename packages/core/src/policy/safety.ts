/**
 * Safety engine v2.
 *
 * Extends the baseline policy engine with rate limits, interlocks, sequences,
 * approvals, lease checks, deadman switches, and resource budgets. All
 * enforcement is deterministic runtime logic — a prompt can never override
 * these rules.
 *
 * The legacy `evaluatePolicies` path keeps working unchanged; this engine
 * evaluates the same `numericRange` / `stateEquals` / `workspaceBounds` /
 * `custom` rules plus the v2 kinds below.
 */
import { PinoutStructuredError } from '../errors.js';
import type { ConstraintProvenance, PolicyDecision } from '../spec/types.js';
import type { LeaseManager } from '../lease/leaseManager.js';
import {
  PolicyActionDenied,
  PolicyConstraintViolation,
  PolicyPreconditionFailed,
} from './errors.js';
import type { PolicyContext, PolicyRule as LegacyPolicyRule } from './types.js';
import { assertFreshState, evaluatePolicies } from './engine.js';

// ---------------------------------------------------------------------------
// Rule kinds
// ---------------------------------------------------------------------------

export interface SafetyRuleBase {
  /** Stable rule id, e.g. `temperature.max`. */
  id?: string;
  provenance?: ConstraintProvenance;
}

export type SafetyRule =
  | (Extract<
      LegacyPolicyRule,
      { kind: 'numericRange' | 'stateEquals' | 'workspaceBounds' | 'custom' }
    > &
      SafetyRuleBase)
  | (RateRule & SafetyRuleBase)
  | (InterlockRule & SafetyRuleBase)
  | (SequenceRule & SafetyRuleBase)
  | (ApprovalRule & SafetyRuleBase)
  | (LeaseRule & SafetyRuleBase)
  | (DeadmanRule & SafetyRuleBase)
  | (ResourceRule & SafetyRuleBase);

export interface RateRule {
  kind: 'rate';
  capability: string;
  /** Maximum invocations per sliding window. */
  maxPerWindow: number;
  /** Window length in milliseconds. Default 1000. */
  windowMs?: number;
  message?: string;
}

export interface InterlockRule {
  kind: 'interlock';
  capability: string;
  /** Interlock name, e.g. `door.closed`. */
  interlock: string;
  /** Value the interlock must hold. Default true. */
  mustBe?: boolean | string | number;
  /** Maximum acceptable age of the operational state, in milliseconds. */
  maxStateAgeMs?: number;
  message?: string;
}

export interface SequenceRule {
  kind: 'sequence';
  capability: string;
  /** Sequence name, e.g. `startup`. */
  sequence: string;
  /** Minimum step (inclusive) the sequence must have reached. */
  atLeastStep: number;
  message?: string;
}

export interface ApprovalRule {
  kind: 'approval';
  capability: string;
  /** Approvals are recorded out-of-band by an operator flow. */
  message?: string;
}

export interface LeaseRule {
  kind: 'lease';
  capability: string;
  message?: string;
}

export interface DeadmanRule {
  kind: 'deadman';
  capability: string;
  /** Heartbeat must be younger than this, in milliseconds. Default 1000. */
  maxAgeMs?: number;
  message?: string;
}

export interface ResourceRule {
  kind: 'resource';
  capability: string;
  /** Budget name, e.g. `motion-seconds`. */
  resource: string;
  /** Cost charged to the budget per invocation. Default 1. */
  cost?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ApprovalRecord {
  id: string;
  deviceId: string;
  capability: string;
  grantedBy: string;
  grantedAt: number;
  expiresAt?: number;
  usedAt?: number;
}

export interface SafetyEngineOptions {
  rules: SafetyRule[];
  /** Injected clock for deterministic tests. */
  now?: () => number;
  leaseManager?: LeaseManager;
  /** Called for every rejection with the machine-readable decision. */
  onRejection?: (decision: PolicyDecision, context: PolicyContext) => void;
}

export interface SafetyReservation {
  /** Keep consumable policy effects after the backend accepts the action. */
  commit(): void;
  /** Restore approvals, rate slots, and resource budgets after backend failure. */
  rollback(): void;
}

interface RateWindow {
  timestamps: number[];
}

interface ResourceBudget {
  limit: number;
  windowMs: number;
  consumed: Array<{ at: number; cost: number }>;
}

export class SafetyEngine {
  private readonly rules: SafetyRule[];
  private readonly nowFn: () => number;
  private readonly leaseManager: LeaseManager | undefined;
  private readonly onRejection?: SafetyEngineOptions['onRejection'];

  private rateWindows = new Map<string, RateWindow>();
  private readonly interlocks = new Map<string, boolean | string | number>();
  private readonly sequences = new Map<string, number>();
  private approvals = new Map<string, ApprovalRecord>();
  private readonly deadman = new Map<string, number>();
  private budgets = new Map<string, ResourceBudget>();

  constructor(options: SafetyEngineOptions) {
    this.rules = options.rules;
    this.nowFn = options.now ?? Date.now;
    this.leaseManager = options.leaseManager;
    this.onRejection = options.onRejection;
  }

  /** Non-throwing evaluation. Returns the first rejection decision. */
  check(context: PolicyContext & { owner?: string }): PolicyDecision {
    try {
      this.enforce(context);
      return { allowed: true };
    } catch (error) {
      if (
        error instanceof PolicyConstraintViolation ||
        error instanceof PolicyPreconditionFailed ||
        error instanceof PolicyActionDenied ||
        error instanceof PinoutStructuredError
      ) {
        const ruleId = (error as { ruleId?: string }).ruleId;
        const decision: PolicyDecision = {
          allowed: false,
          code: error.code,
          message: error.message,
          ...(ruleId !== undefined ? { ruleId } : {}),
        };
        return decision;
      }
      throw error;
    }
  }

  /** Throwing evaluation; rejects with typed policy errors. */
  enforce(context: PolicyContext & { owner?: string }): void {
    this.reserve(context).commit();
  }

  /**
   * Enforce all rules while retaining a rollback point for a physical backend
   * failure. Callers must commit once the backend has accepted the action.
   */
  reserve(context: PolicyContext & { owner?: string }): SafetyReservation {
    const saved = this.snapshotConsumables();
    try {
      this.enforceRules(context);
    } catch (error) {
      this.restoreConsumables(saved);
      this.notifyRejection(error, context);
      throw error;
    }
    let active = true;
    return {
      commit: () => {
        active = false;
      },
      rollback: () => {
        if (!active) return;
        active = false;
        this.restoreConsumables(saved);
      },
    };
  }

  /** Evaluate without consuming approvals, rate slots, or resource budgets. */
  preview(context: PolicyContext & { owner?: string }): PolicyDecision {
    const saved = this.snapshotConsumables();
    try {
      return this.check(context);
    } finally {
      this.restoreConsumables(saved);
    }
  }

  private snapshotConsumables() {
    return structuredClone({
      rateWindows: this.rateWindows,
      approvals: this.approvals,
      budgets: this.budgets,
    });
  }

  private restoreConsumables(saved: ReturnType<SafetyEngine['snapshotConsumables']>): void {
    this.rateWindows = saved.rateWindows;
    this.approvals = saved.approvals;
    this.budgets = saved.budgets;
  }

  private notifyRejection(error: unknown, context: PolicyContext): void {
    if (
      !(error instanceof PolicyConstraintViolation) &&
      !(error instanceof PolicyPreconditionFailed) &&
      !(error instanceof PolicyActionDenied) &&
      !(error instanceof PinoutStructuredError)
    ) {
      return;
    }
    const ruleId = (error as { ruleId?: string }).ruleId;
    this.onRejection?.(
      {
        allowed: false,
        code: error.code,
        message: error.message,
        ...(ruleId !== undefined ? { ruleId } : {}),
      },
      context,
    );
  }

  private enforceRules(context: PolicyContext & { owner?: string }): void {
    // Legacy kinds first, unchanged semantics.
    evaluatePolicies(this.rules as LegacyPolicyRule[], context);

    const now = this.nowFn();
    for (const rule of this.rules) {
      if (
        rule.kind === 'numericRange' ||
        rule.kind === 'stateEquals' ||
        rule.kind === 'workspaceBounds' ||
        rule.kind === 'custom'
      ) {
        continue;
      }
      if (rule.kind !== 'lease' && rule.capability !== context.capability) continue;

      switch (rule.kind) {
        case 'rate':
          this.enforceRate(rule, context, now);
          break;
        case 'interlock':
          this.enforceInterlock(rule, context);
          break;
        case 'sequence':
          this.enforceSequence(rule, context);
          break;
        case 'approval':
          this.enforceApproval(rule, context, now);
          break;
        case 'lease':
          this.enforceLease(rule, context);
          break;
        case 'deadman':
          this.enforceDeadman(rule, context, now);
          break;
        case 'resource':
          this.enforceResource(rule, context, now);
          break;
      }
    }
  }

  // -- External state feeds -------------------------------------------------

  setInterlock(name: string, value: boolean | string | number): void {
    this.interlocks.set(name, value);
  }

  getInterlock(name: string): boolean | string | number | undefined {
    return this.interlocks.get(name);
  }

  setSequenceStep(sequence: string, step: number): void {
    this.sequences.set(sequence, step);
  }

  recordApproval(
    record: Omit<ApprovalRecord, 'grantedAt'> & { grantedAt?: number },
  ): ApprovalRecord {
    const full: ApprovalRecord = {
      ...record,
      grantedAt: record.grantedAt ?? this.nowFn(),
    };
    this.approvals.set(full.id, full);
    return { ...full };
  }

  /** Signal the deadman switch as alive right now. */
  heartbeatDeadman(deviceId: string): void {
    this.deadman.set(deviceId, this.nowFn());
  }

  /** Last deadman heartbeat timestamp for a device, if any. */
  getDeadmanLastAlive(deviceId: string): number | undefined {
    return this.deadman.get(deviceId);
  }

  /** Clear deadman tracking (e.g. after fail-safe disarm). */
  clearDeadman(deviceId: string): void {
    this.deadman.delete(deviceId);
  }

  /** Configured deadman rules (for proactive stale monitoring). */
  listDeadmanRules(): DeadmanRule[] {
    return this.rules.filter((rule): rule is DeadmanRule => rule.kind === 'deadman');
  }

  configureBudget(resource: string, limit: number, windowMs: number): void {
    this.budgets.set(resource, { limit, windowMs, consumed: [] });
  }

  // -- Rule implementations -------------------------------------------------

  private enforceRate(rule: RateRule, context: PolicyContext, now: number): void {
    const windowMs = rule.windowMs ?? 1000;
    const key = `${context.deviceId}::${context.capability}`;
    const window = this.rateWindows.get(key) ?? { timestamps: [] };
    window.timestamps = window.timestamps.filter((t) => t > now - windowMs);
    if (window.timestamps.length >= rule.maxPerWindow) {
      this.reject(
        rule,
        `Rate limit: max ${rule.maxPerWindow} '${context.capability}' per ${windowMs}ms.`,
        context,
        'SAFETY_RATE_LIMIT',
        { maxPerWindow: rule.maxPerWindow, windowMs },
      );
      return;
    }
    window.timestamps.push(now);
    this.rateWindows.set(key, window);
  }

  private enforceInterlock(rule: InterlockRule, context: PolicyContext): void {
    if (rule.maxStateAgeMs !== undefined) {
      assertFreshState(context.operationalState, rule.maxStateAgeMs, context, this.nowFn());
    }
    const expected = rule.mustBe ?? true;
    const actual = this.interlocks.get(rule.interlock);
    if (actual !== expected) {
      this.reject(
        rule,
        rule.message ??
          `Interlock '${rule.interlock}' must be ${String(expected)}, current ${String(actual)}.`,
        context,
        'SAFETY_INTERLOCK_NOT_SATISFIED',
        { interlock: rule.interlock, expected, actual },
      );
    }
  }

  private enforceSequence(rule: SequenceRule, context: PolicyContext): void {
    const step = this.sequences.get(rule.sequence);
    if (step === undefined || step < rule.atLeastStep) {
      this.reject(
        rule,
        rule.message ??
          `Sequence '${rule.sequence}' must have reached step ${rule.atLeastStep}, current ${String(step)}.`,
        context,
        'SAFETY_SEQUENCE_NOT_SATISFIED',
        { sequence: rule.sequence, requiredStep: rule.atLeastStep, currentStep: step },
      );
    }
  }

  private enforceApproval(rule: ApprovalRule, context: PolicyContext, now: number): void {
    let matched: ApprovalRecord | undefined;
    for (const approval of this.approvals.values()) {
      if (approval.deviceId !== context.deviceId || approval.capability !== context.capability)
        continue;
      if (approval.usedAt !== undefined) continue;
      if (approval.expiresAt !== undefined && approval.expiresAt <= now) continue;
      matched = approval;
      break;
    }
    if (!matched) {
      this.reject(
        rule,
        ` '${context.capability}' requires an operator approval that has not been granted (or is already used).`,
        context,
        'SAFETY_APPROVAL_REQUIRED',
      );
      return;
    }
    matched.usedAt = now;
  }

  private enforceLease(rule: LeaseRule, context: PolicyContext & { owner?: string }): void {
    if (!this.leaseManager) {
      this.reject(
        rule,
        'No lease manager is configured; lease-gated capability is unavailable.',
        context,
        'SAFETY_LEASE_MANAGER_MISSING',
      );
      return;
    }
    const owner = context.owner;
    if (!owner) {
      this.reject(
        rule,
        `'${context.capability}' requires an active lease, but no lease owner was provided.`,
        context,
        'SAFETY_LEASE_OWNER_REQUIRED',
      );
      return;
    }
    const verdict = this.leaseManager.permits(
      owner,
      context.deviceId,
      context.capability,
      'exclusive',
    );
    if (!verdict.permitted) {
      this.reject(
        rule,
        `'${context.capability}' requires a lease held by the caller on device '${context.deviceId}'.`,
        context,
        'SAFETY_LEASE_REQUIRED',
        verdict.conflict ? { conflictingLease: verdict.conflict } : undefined,
      );
    }
  }

  private enforceDeadman(rule: DeadmanRule, context: PolicyContext, now: number): void {
    const lastAlive = this.deadman.get(context.deviceId);
    const maxAge = rule.maxAgeMs ?? 1000;
    if (lastAlive === undefined || now - lastAlive > maxAge) {
      this.reject(
        rule,
        rule.message ??
          `Deadman heartbeat for '${context.deviceId}' is stale (${lastAlive === undefined ? 'never' : `${now - lastAlive}ms old`}).`,
        context,
        'SAFETY_DEADMAN_STALE',
        { maxAgeMs: maxAge, lastAlive },
      );
    }
  }

  private enforceResource(rule: ResourceRule, context: PolicyContext, now: number): void {
    const budget = this.budgets.get(rule.resource);
    if (!budget) {
      this.reject(
        rule,
        `No budget configured for resource '${rule.resource}'.`,
        context,
        'SAFETY_BUDGET_NOT_CONFIGURED',
      );
      return;
    }
    budget.consumed = budget.consumed.filter((entry) => entry.at > now - budget.windowMs);
    const cost = rule.cost ?? 1;
    const total = budget.consumed.reduce((sum, entry) => sum + entry.cost, 0);
    if (total + cost > budget.limit) {
      this.reject(
        rule,
        `Resource budget '${rule.resource}' exhausted (${total}/${budget.limit} in the last ${budget.windowMs}ms).`,
        context,
        'SAFETY_BUDGET_EXHAUSTED',
        { resource: rule.resource, consumed: total, limit: budget.limit },
      );
      return;
    }
    budget.consumed.push({ at: now, cost });
  }

  private reject(
    rule: { message?: string; id?: string },
    message: string,
    context: PolicyContext,
    code: string,
    details?: Record<string, unknown>,
  ): never {
    const error = new PinoutStructuredError(
      code,
      'SAFETY',
      `${message} (${context.deviceId}.${context.capability})`,
      {
        device: context.deviceId,
        capability: context.capability,
        details: { ...(details ?? {}), ruleId: rule.id },
      },
    );
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Module vs. deployment constraint merging
// ---------------------------------------------------------------------------

export interface ConstraintConflict {
  kind: 'range-widening' | 'state-mismatch';
  capability: string;
  field?: string;
  module: unknown;
  deployment: unknown;
  message: string;
}

/**
 * Merge module baseline rules with deployment rules.
 *
 * Deployment policies may only make constraints STRICTER:
 * - numeric ranges must be narrower (inside) than the module range,
 * - stateEquals preconditions must match module requirements exactly
 *   (additional new preconditions on other fields are fine),
 * - new rules on capabilities the module did not constrain are allowed.
 *
 * A deployment that would widen a module range or contradict a module
 * precondition yields a conflict that must be surfaced for human review —
 * never silently applied.
 */
export function mergeModuleAndDeploymentRules(
  moduleRules: SafetyRule[],
  deploymentRules: SafetyRule[],
): { rules: SafetyRule[]; conflicts: ConstraintConflict[] } {
  const conflicts: ConstraintConflict[] = [];
  const merged: SafetyRule[] = [...moduleRules];

  for (const deployment of deploymentRules) {
    if (deployment.kind === 'numericRange') {
      const moduleCounterparts = moduleRules.filter(
        (r): r is Extract<SafetyRule, { kind: 'numericRange' }> =>
          r.kind === 'numericRange' &&
          r.capability === deployment.capability &&
          r.field === deployment.field,
      );
      let satisfied = true;
      for (const module of moduleCounterparts) {
        if (deployment.min < module.min || deployment.max > module.max) {
          conflicts.push({
            kind: 'range-widening',
            capability: deployment.capability,
            field: deployment.field,
            module: { min: module.min, max: module.max },
            deployment: { min: deployment.min, max: deployment.max },
            message: `Deployment range [${deployment.min}, ${deployment.max}] would widen module range [${module.min}, ${module.max}] for ${deployment.capability}.${deployment.field}.`,
          });
          satisfied = false;
        }
      }
      if (satisfied) {
        merged.push({ ...deployment, provenance: deployment.provenance ?? 'CONFIGURED' });
      }
      continue;
    }

    if (deployment.kind === 'stateEquals') {
      for (const module of moduleRules) {
        if (
          module.kind === 'stateEquals' &&
          module.capability === deployment.capability &&
          module.field === deployment.field &&
          module.equals !== deployment.equals
        ) {
          conflicts.push({
            kind: 'state-mismatch',
            capability: deployment.capability,
            field: deployment.field,
            module: module.equals,
            deployment: deployment.equals,
            message: `Deployment precondition ${deployment.field} == ${String(deployment.equals)} contradicts module requirement ${String(module.equals)} for ${deployment.capability}.`,
          });
        }
      }
      if (
        !conflicts.some(
          (c) =>
            c.kind === 'state-mismatch' &&
            c.capability === deployment.capability &&
            c.field === deployment.field,
        )
      ) {
        merged.push({ ...deployment, provenance: deployment.provenance ?? 'CONFIGURED' });
      }
      continue;
    }

    merged.push({ ...deployment, provenance: deployment.provenance ?? 'CONFIGURED' });
  }

  return { rules: merged, conflicts };
}
