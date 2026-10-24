/**
 * Append-only control journal (spec v1).
 *
 * Records invocations, policy outcomes, operation lifecycle, state
 * transitions, events, faults, and device reconnects so sessions can be
 * inspected (`pinout logs`) and replayed (`pinout replay`).
 *
 * Secrets and large payloads never enter the journal: `redact` strips
 * credential-shaped keys before append, and payloads larger than
 * `maxPayloadChars` are replaced with a size marker. Storage is behind the
 * `JournalStorage` interface; a JSONL file implementation ships by default —
 * no cloud database is required or implied.
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|credential|authorization|api[-_]?key|private[-_]?key/i;

/** Keys that look secret-sensitive are dropped from journaled payloads. */
export function redactPayload(
  payload: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 4) return { truncated: true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactPayload(value as Record<string, unknown>, depth + 1);
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 32);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type JournalEntryKind =
  | 'invocation.requested'
  | 'invocation.completed'
  | 'invocation.failed'
  | 'policy.rejected'
  | 'operation.requested'
  | 'operation.started'
  | 'operation.progress'
  | 'operation.completed'
  | 'operation.failed'
  | 'operation.cancelled'
  | 'operation.timed_out'
  | 'operation.rejected'
  | 'operation.reconciled'
  | 'operation.uncertain'
  | 'operation.aborted'
  | 'operation.stop_unconfirmed'
  | 'state.changed'
  | 'event.emitted'
  | 'fault.raised'
  | 'fault.cleared'
  | 'safety.state_changed'
  | 'device.connected'
  | 'device.disconnected'
  | 'device.reconnected'
  | 'lease.acquired'
  | 'lease.released'
  | 'lease.expired'
  | 'connector.generated'
  | 'connector.quarantined'
  | 'connector.approved'
  | 'connector.installed'
  | 'connector.rejected';

export interface JournalEntry {
  sequence: number;
  at: number;
  kind: JournalEntryKind;
  deviceId?: string;
  operationId?: string;
  payload?: Record<string, unknown>;
}

export interface JournalQuery {
  deviceId?: string;
  operationId?: string;
  kinds?: JournalEntryKind[];
  afterSequence?: number;
  limit?: number;
}

export interface JournalStorage {
  append(entry: JournalEntry): Promise<void> | void;
  readAll(): Promise<JournalEntry[]> | JournalEntry[];
  close?(): Promise<void> | void;
}

export interface JournalOptions {
  storage?: JournalStorage;
  /** Max payload size in characters before truncation. Default 4096. */
  maxPayloadChars?: number;
}

export class Journal {
  private sequence = 0;
  private readonly storage: JournalStorage;
  private readonly maxPayloadChars: number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: JournalOptions = {}) {
    this.storage = options.storage ?? new MemoryJournalStorage();
    this.maxPayloadChars = options.maxPayloadChars ?? 4096;
  }

  append(
    kind: JournalEntryKind,
    context: { deviceId?: string; operationId?: string } = {},
    payload: Record<string, unknown> = {},
  ): JournalEntry {
    const entry: JournalEntry = {
      sequence: ++this.sequence,
      at: Date.now(),
      kind,
      ...(context.deviceId !== undefined ? { deviceId: context.deviceId } : {}),
      ...(context.operationId !== undefined ? { operationId: context.operationId } : {}),
      ...(payload && Object.keys(payload).length > 0
        ? {
            payload: truncatePayload(redactPayload(payload), this.maxPayloadChars) as Record<
              string,
              unknown
            >,
          }
        : {}),
    };
    // Journal writes are serialized off the control path: callers never wait
    // for disk, but close() flushes everything appended so far. In-memory
    // storage appends synchronously so queries reflect the entry immediately.
    const result = this.storage.append(entry);
    if (result instanceof Promise) {
      this.writeChain = this.writeChain
        .then(() => result)
        .then(
          () => undefined,
          () => undefined,
        );
    }
    return entry;
  }

  async query(filter: JournalQuery = {}): Promise<JournalEntry[]> {
    const all = await this.storage.readAll();
    const sorted = [...all].sort((a, b) => a.sequence - b.sequence);
    const out: JournalEntry[] = [];
    for (const entry of sorted) {
      if (filter.deviceId && entry.deviceId !== filter.deviceId) continue;
      if (filter.operationId && entry.operationId !== filter.operationId) continue;
      if (filter.kinds && !filter.kinds.includes(entry.kind)) continue;
      if (filter.afterSequence !== undefined && entry.sequence <= filter.afterSequence) continue;
      out.push(entry);
      if (filter.limit !== undefined && out.length >= filter.limit) break;
    }
    return out;
  }

  async close(): Promise<void> {
    await this.writeChain;
    await this.storage.close?.();
  }

  /** Re-import entries from storage (e.g. after restart) to continue numbering. */
  async hydrate(): Promise<number> {
    const all = await this.storage.readAll();
    const max = all.reduce((acc, entry) => Math.max(acc, entry.sequence), 0);
    this.sequence = Math.max(this.sequence, max);
    return this.sequence;
  }
}

function truncatePayload(
  payload: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> | undefined {
  if (Object.keys(payload).length === 0) return undefined;
  const json = JSON.stringify(payload);
  if (json.length <= maxChars) return payload;
  return { truncated: true, originalChars: json.length, preview: json.slice(0, 512) };
}

// ---------------------------------------------------------------------------
// Storage implementations
// ---------------------------------------------------------------------------

export class MemoryJournalStorage implements JournalStorage {
  private readonly entries: JournalEntry[] = [];

  append(entry: JournalEntry): void {
    this.entries.push(entry);
  }

  readAll(): JournalEntry[] {
    return [...this.entries];
  }
}

export class FileJournalStorage implements JournalStorage {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(entry: JournalEntry): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async readAll(): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: JournalEntry[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as JournalEntry);
      } catch {
        // Skip torn/corrupt trailing lines rather than failing the read.
      }
    }
    return out;
  }
}

/** Load a journal from a JSONL file for replay/inspection. */
export async function loadJournalEntries(filePath: string): Promise<JournalEntry[]> {
  const storage = new FileJournalStorage(filePath);
  return storage.readAll();
}
