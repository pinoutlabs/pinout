import {
  CallbackDelivery,
  progressViewUpdate,
  toolResultMessage,
} from './callbackDelivery.js';
import { DaemonClient } from './daemonClient.js';
import { resolveInvokeIdempotencyKey } from './idempotency.js';
import { ownerForRapThread } from './owner.js';
import { PendingStore } from './pendingStore.js';
import { abortThreadSafety } from './safety.js';
import { buildPinoutToolset, idempotencyKeyFor } from './toolset.js';
import type {
  PendingCallRecord,
  RapCancelToolCall,
  RapCloseThread,
  RapInvocation,
  RapToolsetManifest,
} from './types.js';

/** Align with MCP invokeWaitMs (#62): bounded wait then OPERATION_PENDING. */
export const DEFAULT_INVOKE_WAIT_MS = 10_000;

const terminalStatuses = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'rejected',
  'requires_reconciliation',
  'uncertain',
  'stop_unconfirmed',
]);

export interface RapAdapterOptions {
  publicBaseUrl: string;
  daemonUrl?: string;
  daemonToken?: string;
  pinoutHome?: string;
  journalDir?: string;
  fetch?: typeof globalThis.fetch;
  maxCallbackAttempts?: number;
  callbackBaseDelayMs?: number;
  pollIntervalMs?: number;
  /** Bounded wait after waitFor=accepted before OPERATION_PENDING (default 10s). */
  operationTimeoutMs?: number;
  invokeWaitMs?: number;
}

export class RapAdapter {
  readonly store: PendingStore;
  readonly daemon: DaemonClient;
  readonly delivery: CallbackDelivery;
  readonly publicBaseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly operationTimeoutMs: number;
  private readonly inFlight = new Set<string>();
  private readonly background = new Set<Promise<void>>();
  private recoveryStarted = false;

  constructor(options: RapAdapterOptions) {
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/$/, '');
    this.daemon = new DaemonClient({
      ...(options.daemonUrl !== undefined ? { baseUrl: options.daemonUrl } : {}),
      ...(options.daemonToken !== undefined ? { token: options.daemonToken } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.store = new PendingStore({
      ...(options.pinoutHome !== undefined ? { pinoutHome: options.pinoutHome } : {}),
      ...(options.journalDir !== undefined ? { journalDir: options.journalDir } : {}),
    });
    this.delivery = new CallbackDelivery({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.maxCallbackAttempts !== undefined
        ? { maxAttempts: options.maxCallbackAttempts }
        : {}),
      ...(options.callbackBaseDelayMs !== undefined
        ? { baseDelayMs: options.callbackBaseDelayMs }
        : {}),
    });
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.operationTimeoutMs =
      options.invokeWaitMs ?? options.operationTimeoutMs ?? DEFAULT_INVOKE_WAIT_MS;
  }

  toolset(): RapToolsetManifest {
    return buildPinoutToolset(`${this.publicBaseUrl}/invoke`);
  }

  /** Resume durable deliveries after process restart. */
  startRecovery(): void {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    for (const call of this.store.listOpenCalls()) {
      this.track(this.resumeCall(call));
    }
  }

  /**
   * Accept a RAP invocation. Caller MUST already have sent HTTP 200.
   * Duplicate group_id:id is idempotent: reuses prior work / redelivers.
   */
  acceptInvocation(invocation: RapInvocation): void {
    const key = idempotencyKeyFor(invocation.group_id, invocation.id);
    const existing = this.store.getCall(key);
    if (existing) {
      if (existing.resultText !== undefined) {
        this.track(this.redeliver(existing));
        return;
      }
      if (
        existing.status === 'accepted' ||
        existing.status === 'running' ||
        existing.status === 'delivering'
      ) {
        this.track(this.resumeCall(existing));
        return;
      }
    }

    const record: PendingCallRecord = {
      key,
      groupId: invocation.group_id,
      id: invocation.id,
      ...(invocation.call_id ? { callId: invocation.call_id } : {}),
      callbackUrl: invocation.callback_url,
      operation: invocation.operation,
      arguments:
        invocation.arguments && typeof invocation.arguments === 'object'
          ? invocation.arguments
          : {},
      status: 'accepted',
      deliveryAttempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deviceIds: [],
      leaseIds: [],
      cancelled: false,
    };
    this.store.upsertCall(record);
    this.store.notePendingKey(invocation.group_id, key);
    this.track(this.runCall(record));
  }

  /** Wait for background invoke/delivery work (tests / graceful shutdown). */
  async drain(): Promise<void> {
    while (this.background.size > 0 || this.inFlight.size > 0) {
      await Promise.allSettled([...this.background]);
      if (this.inFlight.size > 0) await sleep(10);
    }
  }

  private track(task: Promise<void>): void {
    this.background.add(task);
    void task.finally(() => this.background.delete(task));
  }

  /** Best-effort cancel mapped to pinoutd operation cancel + local mark. */
  async cancelToolCall(body: RapCancelToolCall): Promise<void> {
    const key = idempotencyKeyFor(body.thread_id, body.tool_call_id);
    const call = this.store.getCall(key);
    if (!call) return;
    call.cancelled = true;
    call.updatedAt = Date.now();
    this.store.upsertCall(call);
    if (call.daemonOperationId) {
      try {
        await this.daemon.cancelOperation(
          call.daemonOperationId,
          'RAP cancel_tool_call',
        );
      } catch {
        // late / duplicate cancel is fine
      }
    }
    // Safety abort for physical work owned by this call's devices.
    if (call.deviceIds.length > 0) {
      for (const deviceId of call.deviceIds) {
        try {
          await this.daemon.disarmOrSafeState(deviceId, body.thread_id);
        } catch {
          // best effort
        }
      }
    }
  }

  /** Release leases owned by the thread and disarm devices it armed. */
  async closeThread(body: RapCloseThread): Promise<void> {
    this.store.markThreadClosed(body.thread_id);
    await abortThreadSafety(
      this.daemon,
      this.store,
      body.thread_id,
      'RAP close_thread',
    );
  }

  private async resumeCall(call: PendingCallRecord): Promise<void> {
    if (call.resultText !== undefined && call.status !== 'delivered') {
      await this.deliverResult(call, call.resultText);
      return;
    }
    if (call.daemonOperationId) {
      await this.watchOperation(call, call.daemonOperationId);
      return;
    }
    await this.runCall(call);
  }

  private async redeliver(call: PendingCallRecord): Promise<void> {
    if (call.resultText === undefined) return;
    await this.deliverResult(call, call.resultText);
  }

  private async runCall(call: PendingCallRecord): Promise<void> {
    if (this.inFlight.has(call.key)) return;
    this.inFlight.add(call.key);
    try {
      if (call.cancelled) {
        await this.deliverResult(call, 'Error: tool call cancelled before execution.');
        return;
      }
      call.status = 'running';
      call.updatedAt = Date.now();
      this.store.upsertCall(call);

      const text = await this.executeOperation(call);
      if (call.cancelled) {
        // Spec: may still deliver; runtime ignores late results. We deliver a cancelled note.
        await this.deliverResult(
          call,
          text.startsWith('Error:') ? text : `Error: cancelled after partial work. ${text}`,
        );
        return;
      }
      await this.deliverResult(call, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined;
      await this.deliverResult(
        call,
        code ? `Error: ${code}: ${message}` : `Error: ${message}`,
      );
    } finally {
      this.inFlight.delete(call.key);
    }
  }

  private async executeOperation(call: PendingCallRecord): Promise<string> {
    const args = call.arguments;
    const owner = ownerForRapThread(call.groupId, args);
    const required = (name: string): string => {
      const value = args[name];
      if (typeof value !== 'string' || value.length === 0) {
        throw Object.assign(new Error(`${name} must be a non-empty string.`), {
          code: 'VALIDATION_ERROR',
        });
      }
      return value;
    };

    switch (call.operation) {
      case 'pinout__list_devices':
        return jsonText(await this.daemon.listDevices());
      case 'pinout__describe_device': {
        const deviceId = required('deviceId');
        return jsonText(await this.daemon.describeDevice(deviceId));
      }
      case 'pinout__read_state': {
        const deviceId = required('deviceId');
        return jsonText(await this.daemon.readState(deviceId));
      }
      case 'pinout__snapshot':
        return jsonText(await this.daemon.snapshot());
      case 'pinout__safety_status':
        return jsonText(await this.daemon.safety());
      case 'pinout__dry_run': {
        const deviceId = required('deviceId');
        const capability = required('capability');
        const dryArgs =
          args.args && typeof args.args === 'object' && !Array.isArray(args.args)
            ? (args.args as Record<string, unknown>)
            : {};
        return jsonText(
          await this.daemon.dryRun({ deviceId, capability, args: dryArgs, owner }),
        );
      }
      case 'pinout__operation_status':
        return jsonText(await this.daemon.operationStatus(required('operationId')));
      case 'pinout__cancel_operation': {
        const operationId = required('operationId');
        const reason = typeof args.reason === 'string' ? args.reason : 'RAP pinout__cancel_operation';
        return jsonText(await this.daemon.cancelOperation(operationId, reason));
      }
      case 'pinout__acquire_lease': {
        const deviceId = required('deviceId');
        this.store.noteDevice(owner, deviceId);
        call.deviceIds = unique([...call.deviceIds, deviceId]);
        const result = await this.daemon.acquireLease({
          deviceId,
          owner,
          ...(typeof args.mode === 'string' ? { mode: args.mode } : {}),
          ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
        });
        const lease = result.lease as { id?: string } | undefined;
        if (lease?.id) {
          this.store.noteLease(owner, lease.id);
          call.leaseIds = unique([...call.leaseIds, lease.id]);
        }
        call.updatedAt = Date.now();
        this.store.upsertCall(call);
        return jsonText({ ...result, owner });
      }
      case 'pinout__renew_lease': {
        const leaseId = required('leaseId');
        return jsonText(
          await this.daemon.renewLease({
            leaseId,
            owner,
            ...(typeof args.ttlMs === 'number' ? { ttlMs: args.ttlMs } : {}),
          }),
        );
      }
      case 'pinout__heartbeat': {
        const deviceId = required('deviceId');
        this.store.noteDevice(owner, deviceId);
        return jsonText(await this.daemon.heartbeat(deviceId, owner));
      }
      case 'pinout__release_lease': {
        const leaseId = required('leaseId');
        const result = await this.daemon.releaseLease(leaseId, owner);
        this.store.removeLease(owner, leaseId);
        return jsonText(result);
      }
      case 'pinout__invoke': {
        const deviceId = required('deviceId');
        const capability = required('capability');
        const invokeArgs =
          args.args && typeof args.args === 'object' && !Array.isArray(args.args)
            ? (args.args as Record<string, unknown>)
            : {};
        this.store.noteDevice(owner, deviceId);
        call.deviceIds = unique([...call.deviceIds, deviceId]);
        const keyInfo = resolveInvokeIdempotencyKey({
          groupId: call.groupId,
          callId: call.id,
          args,
          deviceId,
          capability,
          owner,
          physicalOutput: true,
        });
        const accepted = await this.daemon.invokeAccepted({
          deviceId,
          capability,
          args: invokeArgs,
          owner,
          idempotencyKey: keyInfo.idempotencyKey,
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
        });
        const keyMeta = {
          idempotencyKey: keyInfo.idempotencyKey,
          ...(keyInfo.idempotencyKeyGenerated ? { idempotencyKeyGenerated: true } : {}),
          idempotencyKeySource: keyInfo.source,
          owner,
          ...(accepted.deduped === true ? { deduped: true } : {}),
        };
        const operation = accepted.operation as { id?: string; status?: string } | undefined;
        if (!operation?.id) {
          return jsonText({ ...accepted, ...keyMeta });
        }
        call.daemonOperationId = operation.id;
        call.updatedAt = Date.now();
        this.store.upsertCall(call);
        return await this.watchOperation(call, operation.id, keyMeta);
      }
      default:
        throw Object.assign(new Error(`Unknown operation '${call.operation}'.`), {
          code: 'UNKNOWN_OPERATION',
        });
    }
  }

  private async watchOperation(
    call: PendingCallRecord,
    operationId: string,
    keyMeta: Record<string, unknown> = {},
  ): Promise<string> {
    const waitBudgetMs = this.operationTimeoutMs;
    const deadline = Date.now() + waitBudgetMs;
    let lastFraction = -1;
    let latest: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      if (call.cancelled) {
        try {
          await this.daemon.cancelOperation(operationId, 'RAP cancel during watch');
        } catch {
          // ignore
        }
      }
      const payload = await this.daemon.operationStatus(operationId);
      latest = payload;
      const operation = payload.operation as
        | {
            id?: string;
            status?: string;
            progress?: { fraction?: number; message?: string };
            result?: unknown;
            error?: unknown;
          }
        | undefined;
      const status = operation?.status ?? 'unknown';
      const fraction = operation?.progress?.fraction;
      if (typeof fraction === 'number' && fraction !== lastFraction) {
        lastFraction = fraction;
        void this.delivery.deliver(
          call.callbackUrl,
          progressViewUpdate({
            groupId: call.groupId,
            operationId,
            fraction,
            ...(operation?.progress?.message
              ? { message: operation.progress.message }
              : {}),
          }),
        );
      }
      if (terminalStatuses.has(status)) {
        return jsonText({ ...payload, ...keyMeta });
      }
      await sleep(this.pollIntervalMs);
      // Refresh cancelled flag from store (cancel_tool_call may have landed).
      const refreshed = this.store.getCall(call.key);
      if (refreshed?.cancelled) call.cancelled = true;
    }

    const pendingOperation = (latest.operation as Record<string, unknown> | undefined) ?? {
      id: operationId,
    };
    // Match MCP #62: do not hang — return OPERATION_PENDING with poll/cancel hints.
    return jsonText({
      code: 'OPERATION_PENDING',
      message:
        'Operation accepted but did not reach a terminal state within the invoke wait budget. Poll pinout__operation_status or cancel with pinout__cancel_operation; retry with the same idempotencyKey to observe the original operation without re-actuating.',
      operationId,
      operation: pendingOperation,
      waitMs: waitBudgetMs,
      poll: { tool: 'pinout__operation_status', arguments: { operationId } },
      cancel: { tool: 'pinout__cancel_operation', arguments: { operationId } },
      retryable: true,
      ...keyMeta,
    });
  }

  private async deliverResult(call: PendingCallRecord, text: string): Promise<void> {
    call.resultText = text;
    call.status = 'delivering';
    call.updatedAt = Date.now();
    this.store.upsertCall(call);

    const delivery = await this.delivery.deliver(
      call.callbackUrl,
      toolResultMessage({
        groupId: call.groupId,
        id: call.id,
        ...(call.callId !== undefined ? { callId: call.callId } : {}),
        text,
      }),
    );
    call.deliveryAttempts += delivery.attempts;
    call.updatedAt = Date.now();
    if (delivery.ok) {
      call.status = 'delivered';
      this.store.upsertCall(call);
      return;
    }
    call.status = 'failed';
    this.store.upsertCall(call);
    if (call.deliveryAttempts >= this.delivery.attemptLimit) {
      await abortThreadSafety(
        this.daemon,
        this.store,
        call.groupId,
        `RAP callback delivery exhausted after ${call.deliveryAttempts} attempts`,
      );
    }
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
