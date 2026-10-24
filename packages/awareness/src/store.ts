/**
 * AwarenessRegistry — persistent store of every device ever seen.
 *
 * Path: ~/.pinout/awareness.json (0600). Writes are atomic (temp + rename).
 * Discovery candidates themselves are never stored; only derived AwarenessRecords.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { applyEvidenceRules, resolvePinoutHome, type SupportLevel } from '@pinout/core';
import type { DiscoveredCandidate } from '@pinout/discovery';
import {
  canTransition,
  evaluateStaleness,
  isKnownModule,
  presenceStateForObservation,
  transition,
} from './stateMachine.js';
import {
  DEFAULT_STALENESS,
  type AwarenessEvent,
  type AwarenessEventType,
  type AwarenessFile,
  type AwarenessHealth,
  type AwarenessIdentity,
  type AwarenessRecord,
  type AwarenessState,
  type AwarenessStalenessConfig,
  type AwarenessTransport,
} from './types.js';

export type AwarenessJournalSink = (event: AwarenessEvent) => void;

export interface AwarenessRegistryOptions {
  home?: string;
  path?: string;
  staleness?: AwarenessStalenessConfig;
  /** Ids already present in ~/.pinout/devices.json (enrolled). */
  enrolledIds?: () => Set<string>;
  /** Override clock for tests. */
  now?: () => number;
  onEvent?: AwarenessJournalSink;
  /**
   * Resolve SupportLevel for a record. Default: SIMULATED, capped by
   * applyEvidenceRules (HARDWARE_VERIFIED requires a dated hardware record).
   */
  resolveEvidenceLevel?: (record: AwarenessRecord) => SupportLevel;
  /** Optional dated hardware/records entry for applyEvidenceRules. */
  hardwareRecordDate?: string | null;
}

export function resolveAwarenessPath(home?: string, explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  return join(resolvePinoutHome(home), 'awareness.json');
}

function hashMac(address: string): string {
  return createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 16);
}

function transportFromCandidate(candidate: DiscoveredCandidate): AwarenessTransport {
  switch (candidate.endpoint.kind) {
    case 'serial':
      return 'serial';
    case 'usb':
      return 'usb';
    case 'ble':
      return 'ble';
    case 'mdns':
      return 'mdns';
    case 'network':
      if (/mqtt/i.test(candidate.endpoint.address) || candidate.interfaces.includes('mqtt')) {
        return 'mqtt';
      }
      return 'mdns';
    case 'simulated':
      return 'serial';
    default:
      return 'serial';
  }
}

function identityFromCandidate(candidate: DiscoveredCandidate): AwarenessIdentity {
  const details = candidate.endpoint.details ?? {};
  const guess = candidate.possibleIdentity[0];
  const identity: AwarenessIdentity = {
    endpoint: candidate.endpoint.address,
    ...(guess?.moduleId !== undefined ? { guessedModuleId: guess.moduleId } : {}),
    ...(guess?.vendor !== undefined ? { vendor: guess.vendor } : {}),
    ...(guess?.deviceClass !== undefined ? { deviceClass: guess.deviceClass } : {}),
  };
  if (typeof details.vendorId === 'string') identity.vid = details.vendorId;
  if (typeof details.productId === 'string') identity.pid = details.productId;
  if (typeof details.vid === 'string') identity.vid = details.vid;
  if (typeof details.pid === 'string') identity.pid = details.pid;
  if (typeof details.manufacturer === 'string' && !identity.vendor) {
    identity.vendor = details.manufacturer;
  }
  if (typeof details.localName === 'string') identity.advertisedName = details.localName;
  if (typeof details.advertisedName === 'string') identity.advertisedName = details.advertisedName;
  if (Array.isArray(details.serviceUuids)) {
    identity.uuids = details.serviceUuids.filter((u): u is string => typeof u === 'string');
  }
  if (candidate.endpoint.kind === 'ble') {
    identity.macHash = hashMac(candidate.endpoint.address);
  }
  if (typeof details.firmware === 'string') identity.firmware = details.firmware;
  if (typeof details.version === 'string') identity.version = details.version;
  return identity;
}

function defaultHealth(at: number, connected: boolean): AwarenessHealth {
  return {
    status: connected ? 'CONNECTED' : 'DISCONNECTED',
    lifecycle: connected ? 'ready' : 'disconnected',
    lastUpdated: at,
  };
}

function hasIdentitySignal(identity: AwarenessIdentity): boolean {
  return Boolean(
    identity.vid ||
      identity.pid ||
      identity.firmware ||
      identity.advertisedName ||
      identity.guessedModuleId ||
      (identity.uuids && identity.uuids.length > 0),
  );
}

/** Build a legal multi-hop path between two states. */
export function transitionPath(from: AwarenessState, to: AwarenessState): AwarenessState[] {
  if (from === to) return [];
  if (canTransition(from, to)) return [to];
  if (from === 'SEEN' && to === 'PENDING_ENROLL') return ['IDENTIFIED', 'PENDING_ENROLL'];
  if (from === 'SEEN' && to === 'ONLINE') return ['IDENTIFIED', 'PENDING_ENROLL', 'ONLINE'];
  if (from === 'IDENTIFIED' && to === 'ONLINE') return ['PENDING_ENROLL', 'ONLINE'];
  if ((from === 'STALE' || from === 'OFFLINE') && to === 'PENDING_ENROLL') {
    return canTransition(from, 'PENDING_ENROLL')
      ? ['PENDING_ENROLL']
      : ['IDENTIFIED', 'PENDING_ENROLL'];
  }
  if ((from === 'STALE' || from === 'OFFLINE') && to === 'ONLINE') return ['ONLINE'];
  if ((from === 'STALE' || from === 'OFFLINE') && to === 'IDENTIFIED') return ['IDENTIFIED'];
  if ((from === 'STALE' || from === 'OFFLINE') && to === 'SEEN') return ['SEEN'];
  if (from === 'PENDING_ENROLL' && to === 'SEEN') return ['IDENTIFIED', 'SEEN'];
  throw new Error(`No transition path from ${from} to ${to}`);
}

export class AwarenessRegistry {
  private readonly records = new Map<string, AwarenessRecord>();
  private readonly subscribers = new Set<(event: AwarenessEvent) => void>();
  private readonly path: string;
  private readonly staleness: AwarenessStalenessConfig;
  private readonly now: () => number;
  private readonly enrolledIds: () => Set<string>;
  private readonly resolveEvidenceLevel: (record: AwarenessRecord) => SupportLevel;
  private readonly onEvent: AwarenessJournalSink | undefined;
  private readonly hardwareRecordDate: string | null | undefined;
  private loaded = false;

  constructor(private readonly options: AwarenessRegistryOptions = {}) {
    this.path = resolveAwarenessPath(options.home, options.path);
    this.staleness = options.staleness ?? DEFAULT_STALENESS;
    this.now = options.now ?? (() => Date.now());
    this.enrolledIds = options.enrolledIds ?? (() => new Set());
    this.hardwareRecordDate = options.hardwareRecordDate;
    this.resolveEvidenceLevel =
      options.resolveEvidenceLevel ??
      ((record) =>
        applyEvidenceRules(record.mock ? 'SIMULATED' : (record.evidenceLevel ?? 'SIMULATED'), {
          ...(this.hardwareRecordDate !== undefined
            ? { hardwareRecordDate: this.hardwareRecordDate }
            : {}),
        }));
    this.onEvent = options.onEvent ?? undefined;
  }

  subscribe(handler: (event: AwarenessEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as AwarenessFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.devices)) {
      throw new Error(`Invalid awareness store at ${this.path}`);
    }
    for (const device of parsed.devices) {
      this.records.set(device.id, device);
    }
  }

  list(): AwarenessRecord[] {
    this.load();
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  get(id: string): AwarenessRecord | undefined {
    this.load();
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  /**
   * Ingest a discovery candidate (read-only observation). Never actuates.
   */
  observeCandidate(
    candidate: DiscoveredCandidate,
    extras: { mock?: boolean; capabilities?: string[] } = {},
  ): AwarenessRecord {
    this.load();
    const now = this.now();
    const transport = transportFromCandidate(candidate);
    const identity = identityFromCandidate(candidate);
    const id = candidate.id;
    const enrolled = this.enrolledIds().has(id);
    const existing = this.records.get(id);
    const nextState = presenceStateForObservation({
      enrolled,
      ...(identity.guessedModuleId !== undefined
        ? { guessedModuleId: identity.guessedModuleId }
        : {}),
      hasIdentitySignal: hasIdentitySignal(identity),
    });

    if (!existing) {
      const record: AwarenessRecord = {
        id,
        transport,
        identity,
        state: 'SEEN',
        firstSeen: now,
        lastSeen: now,
        health: defaultHealth(now, true),
        evidenceLevel: 'SIMULATED',
        confidence: candidate.confidence,
        connector: { status: 'none' },
        ...(extras.mock ? { mock: true } : {}),
        ...(extras.capabilities ? { capabilities: extras.capabilities } : {}),
        ...(isKnownModule(identity.guessedModuleId)
          ? { moduleId: identity.guessedModuleId }
          : {}),
      };
      this.records.set(id, record);
      this.emit('seen', record);
      const after = this.applyObservationState(record, nextState, now, identity, candidate);
      this.persist();
      return structuredClone(after);
    }

    const mergedIdentity = { ...existing.identity, ...identity };
    const patched: AwarenessRecord = {
      ...existing,
      transport,
      identity: mergedIdentity,
      lastSeen: now,
      health: defaultHealth(now, true),
      confidence: candidate.confidence,
      evidenceLevel: this.resolveEvidenceLevel({
        ...existing,
        ...(extras.mock === true || existing.mock === true ? { mock: true as const } : {}),
      }),
      ...(extras.mock || existing.mock ? { mock: true } : {}),
      ...(extras.capabilities
        ? { capabilities: extras.capabilities }
        : existing.capabilities
          ? { capabilities: existing.capabilities }
          : {}),
      ...(isKnownModule(mergedIdentity.guessedModuleId)
        ? { moduleId: mergedIdentity.guessedModuleId }
        : existing.moduleId
          ? { moduleId: existing.moduleId }
          : {}),
    };
    this.records.set(id, patched);
    const after = this.applyObservationState(patched, nextState, now, mergedIdentity, candidate);
    this.persist();
    return structuredClone(after);
  }

  /** Mark an explicit enroll approval: PENDING_ENROLL → ONLINE. Never arms. */
  markEnrolled(id: string, moduleId?: string): AwarenessRecord {
    this.load();
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Awareness device '${id}' not found.`);
    if (existing.state !== 'PENDING_ENROLL' && existing.state !== 'IDENTIFIED') {
      throw new Error(
        `Cannot enroll '${id}' from state ${existing.state}; expected PENDING_ENROLL.`,
      );
    }
    const now = this.now();
    let current = existing;
    if (current.state === 'IDENTIFIED') {
      const previous = current.state;
      current = transition(current, 'PENDING_ENROLL', {
        lastSeen: now,
        health: defaultHealth(now, true),
      });
      this.records.set(id, current);
      this.emit('state_changed', current, previous);
    }
    const beforeOnline = current.state;
    const enrolled = transition(current, 'ONLINE', {
      lastSeen: now,
      health: defaultHealth(now, true),
      ...(moduleId
        ? { moduleId, identity: { ...current.identity, guessedModuleId: moduleId } }
        : {}),
      connector: current.connector ?? { status: 'none' },
    });
    this.records.set(id, enrolled);
    this.emit('state_changed', enrolled, beforeOnline);
    this.emit('online', enrolled, beforeOnline);
    this.persist();
    return structuredClone(enrolled);
  }

  /** Sweep staleness timeouts; journal transitions. */
  tick(now = this.now()): AwarenessRecord[] {
    this.load();
    const changed: AwarenessRecord[] = [];
    for (const [id, record] of this.records) {
      const next = evaluateStaleness(record, now, this.staleness);
      if (!next || next === record.state) continue;
      const previous = record.state;
      const updated = transition(record, next, {
        health: defaultHealth(now, false),
      });
      this.records.set(id, updated);
      this.emit('state_changed', updated, previous);
      if (next === 'OFFLINE') this.emit('offline', updated, previous);
      changed.push(structuredClone(updated));
    }
    if (changed.length > 0) this.persist();
    return changed;
  }

  /** Inject a fully-formed mock record (tests / --mock-devices). */
  upsertMock(
    record: Omit<AwarenessRecord, 'evidenceLevel' | 'mock'> & {
      evidenceLevel?: SupportLevel;
      mock?: boolean;
    },
  ): AwarenessRecord {
    this.load();
    const now = this.now();
    const full: AwarenessRecord = {
      ...record,
      evidenceLevel: 'SIMULATED',
      mock: true,
      firstSeen: record.firstSeen ?? now,
      lastSeen: record.lastSeen ?? now,
      health: record.health ?? defaultHealth(now, true),
      connector: record.connector ?? { status: 'none' },
    };
    const existing = this.records.get(full.id);
    this.records.set(full.id, full);
    if (!existing) {
      this.emit('seen', full);
      if (full.state === 'IDENTIFIED' || full.state === 'PENDING_ENROLL' || full.state === 'ONLINE') {
        this.emit('identified', full, 'SEEN');
      }
      if (full.state === 'ONLINE') this.emit('online', full, 'SEEN');
      if (full.state !== 'SEEN') this.emit('state_changed', full, 'SEEN');
    } else if (existing.state !== full.state) {
      this.emit('state_changed', full, existing.state);
    }
    this.persist();
    return structuredClone(full);
  }

  private applyObservationState(
    record: AwarenessRecord,
    nextState: AwarenessState,
    now: number,
    identity: AwarenessIdentity,
    candidate: DiscoveredCandidate,
  ): AwarenessRecord {
    let current: AwarenessRecord = { ...record, lastSeen: now, identity };
    if (current.state === nextState) {
      this.records.set(current.id, current);
      return current;
    }

    const path = transitionPath(current.state, nextState);
    for (const step of path) {
      const before = current.state;
      current = transition(current, step, {
        lastSeen: now,
        identity,
        health: defaultHealth(now, true),
        confidence: candidate.confidence,
        ...(isKnownModule(identity.guessedModuleId)
          ? { moduleId: identity.guessedModuleId }
          : {}),
      });
      this.records.set(current.id, current);
      if (
        (step === 'IDENTIFIED' || step === 'PENDING_ENROLL') &&
        (before === 'SEEN' || before === 'OFFLINE' || before === 'STALE')
      ) {
        this.emit('identified', current, before);
      }
      this.emit('state_changed', current, before);
      if (step === 'ONLINE') this.emit('online', current, before);
    }
    return current;
  }

  private emit(
    type: AwarenessEventType,
    record: AwarenessRecord,
    previousState?: AwarenessState,
  ): void {
    const event: AwarenessEvent = {
      type,
      record: structuredClone(record),
      at: this.now(),
      ...(previousState !== undefined ? { previousState } : {}),
    };
    this.onEvent?.(event);
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch {
        // Subscriber faults must not break discovery.
      }
    }
  }

  private persist(): void {
    const file: AwarenessFile = {
      schemaVersion: 1,
      devices: [...this.records.values()],
    };
    atomicWriteJson(this.path, file);
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `.awareness-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup
    }
    throw error;
  }
}
