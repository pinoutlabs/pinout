import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePinoutHome } from '@pinout/core';
import type { PendingCallRecord, ThreadState } from './types.js';

export interface PendingStoreOptions {
  pinoutHome?: string;
  /** Override journal directory (tests). */
  journalDir?: string;
}

interface JournalEnvelope {
  v: 1;
  at: number;
  kind: 'upsert_call' | 'delete_call' | 'upsert_thread' | 'delete_thread';
  call?: PendingCallRecord;
  thread?: ThreadState;
  key?: string;
  groupId?: string;
}

/**
 * Durable pending-callback + thread state under ~/.pinout/rap/.
 * Append-only JSONL journal with periodic snapshot compaction.
 */
export class PendingStore {
  readonly journalDir: string;
  private readonly journalPath: string;
  private readonly snapshotPath: string;
  private readonly calls = new Map<string, PendingCallRecord>();
  private readonly threads = new Map<string, ThreadState>();
  private journalLines = 0;

  constructor(options: PendingStoreOptions = {}) {
    const home = resolvePinoutHome(options.pinoutHome);
    this.journalDir = options.journalDir ?? join(home, 'rap');
    this.journalPath = join(this.journalDir, 'pending.journal.jsonl');
    this.snapshotPath = join(this.journalDir, 'pending.snapshot.json');
    mkdirSync(this.journalDir, { recursive: true });
    this.load();
  }

  listCalls(): PendingCallRecord[] {
    return [...this.calls.values()];
  }

  getCall(key: string): PendingCallRecord | undefined {
    return this.calls.get(key);
  }

  listOpenCalls(): PendingCallRecord[] {
    return this.listCalls().filter(
      (call) =>
        call.status === 'accepted' ||
        call.status === 'running' ||
        call.status === 'delivering' ||
        (call.status === 'failed' && call.deliveryAttempts < 8),
    );
  }

  upsertCall(record: PendingCallRecord): void {
    this.calls.set(record.key, record);
    this.append({ v: 1, at: Date.now(), kind: 'upsert_call', call: record });
    this.maybeCompact();
  }

  deleteCall(key: string): void {
    this.calls.delete(key);
    this.append({ v: 1, at: Date.now(), kind: 'delete_call', key });
    this.maybeCompact();
  }

  getThread(groupId: string): ThreadState | undefined {
    return this.threads.get(groupId);
  }

  ensureThread(groupId: string): ThreadState {
    const existing = this.threads.get(groupId);
    if (existing) return existing;
    const thread: ThreadState = {
      groupId,
      deviceIds: [],
      leaseIds: [],
      pendingKeys: [],
      closed: false,
    };
    this.upsertThread(thread);
    return thread;
  }

  upsertThread(thread: ThreadState): void {
    this.threads.set(thread.groupId, thread);
    this.append({ v: 1, at: Date.now(), kind: 'upsert_thread', thread });
    this.maybeCompact();
  }

  noteDevice(groupId: string, deviceId: string): void {
    const thread = this.ensureThread(groupId);
    if (!thread.deviceIds.includes(deviceId)) {
      thread.deviceIds = [...thread.deviceIds, deviceId];
      this.upsertThread(thread);
    }
  }

  noteLease(groupId: string, leaseId: string): void {
    const thread = this.ensureThread(groupId);
    if (!thread.leaseIds.includes(leaseId)) {
      thread.leaseIds = [...thread.leaseIds, leaseId];
      this.upsertThread(thread);
    }
  }

  removeLease(groupId: string, leaseId: string): void {
    const thread = this.ensureThread(groupId);
    thread.leaseIds = thread.leaseIds.filter((id) => id !== leaseId);
    this.upsertThread(thread);
  }

  notePendingKey(groupId: string, key: string): void {
    const thread = this.ensureThread(groupId);
    if (!thread.pendingKeys.includes(key)) {
      thread.pendingKeys = [...thread.pendingKeys, key];
      this.upsertThread(thread);
    }
  }

  markThreadClosed(groupId: string): ThreadState {
    const thread = this.ensureThread(groupId);
    thread.closed = true;
    this.upsertThread(thread);
    return thread;
  }

  private append(entry: JournalEnvelope): void {
    mkdirSync(this.journalDir, { recursive: true });
    writeFileSync(this.journalPath, `${JSON.stringify(entry)}\n`, { flag: 'a' });
    this.journalLines += 1;
  }

  private load(): void {
    if (existsSync(this.snapshotPath)) {
      try {
        const snapshot = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as {
          calls?: PendingCallRecord[];
          threads?: ThreadState[];
        };
        for (const call of snapshot.calls ?? []) this.calls.set(call.key, call);
        for (const thread of snapshot.threads ?? []) this.threads.set(thread.groupId, thread);
      } catch {
        // Corrupt snapshot — fall through to journal replay.
      }
    }
    if (!existsSync(this.journalPath)) return;
    const lines = readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean);
    this.journalLines = lines.length;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JournalEnvelope;
        this.apply(entry);
      } catch {
        // skip corrupt line
      }
    }
  }

  private apply(entry: JournalEnvelope): void {
    if (entry.kind === 'upsert_call' && entry.call) this.calls.set(entry.call.key, entry.call);
    if (entry.kind === 'delete_call' && entry.key) this.calls.delete(entry.key);
    if (entry.kind === 'upsert_thread' && entry.thread)
      this.threads.set(entry.thread.groupId, entry.thread);
    if (entry.kind === 'delete_thread' && entry.groupId) this.threads.delete(entry.groupId);
  }

  private maybeCompact(): void {
    if (this.journalLines < 64) return;
    this.compact();
  }

  compact(): void {
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    const snapshot = {
      v: 1,
      at: Date.now(),
      calls: [...this.calls.values()],
      threads: [...this.threads.values()],
    };
    const tmp = `${this.snapshotPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(tmp, this.snapshotPath);
    writeFileSync(this.journalPath, '');
    this.journalLines = 0;
  }
}
