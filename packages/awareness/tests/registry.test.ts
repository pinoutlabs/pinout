import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AwarenessRegistry,
  canTransition,
  evaluateStaleness,
  mockSpecToCandidate,
  presenceStateForObservation,
  transitionPath,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinout-awareness-'));
  tempDirs.push(dir);
  return dir;
}

describe('awareness state machine', () => {
  it('allows the documented transitions only', () => {
    expect(canTransition('SEEN', 'IDENTIFIED')).toBe(true);
    expect(canTransition('PENDING_ENROLL', 'ONLINE')).toBe(true);
    expect(canTransition('ONLINE', 'SEEN')).toBe(false);
    // SEEN may go directly to PENDING_ENROLL when the transition table allows it.
    expect(transitionPath('SEEN', 'PENDING_ENROLL')).toEqual(['PENDING_ENROLL']);
    expect(transitionPath('SEEN', 'ONLINE')).toEqual([
      'IDENTIFIED',
      'PENDING_ENROLL',
      'ONLINE',
    ]);
  });

  it('maps observation to presence states without auto-enroll', () => {
    expect(
      presenceStateForObservation({
        enrolled: false,
        guessedModuleId: 'pinout/esp32',
        hasIdentitySignal: true,
      }),
    ).toBe('PENDING_ENROLL');
    expect(
      presenceStateForObservation({
        enrolled: false,
        guessedModuleId: 'unknown/usb',
        hasIdentitySignal: true,
      }),
    ).toBe('IDENTIFIED');
    expect(
      presenceStateForObservation({
        enrolled: true,
        guessedModuleId: 'pinout/esp32',
        hasIdentitySignal: true,
      }),
    ).toBe('ONLINE');
  });

  it('evaluates staleness timeouts', () => {
    const record = {
      id: 'x',
      transport: 'serial' as const,
      identity: {},
      state: 'ONLINE' as const,
      firstSeen: 0,
      lastSeen: 0,
      health: {
        status: 'CONNECTED' as const,
        lifecycle: 'ready' as const,
        lastUpdated: 0,
      },
      evidenceLevel: 'SIMULATED' as const,
    };
    expect(evaluateStaleness(record, 31_000, { staleAfterMs: 30_000, offlineAfterMs: 120_000 })).toBe(
      'STALE',
    );
    expect(
      evaluateStaleness(
        { ...record, state: 'STALE' },
        121_000,
        { staleAfterMs: 30_000, offlineAfterMs: 120_000 },
      ),
    ).toBe('OFFLINE');
  });
});

describe('AwarenessRegistry', () => {
  it('persists observations atomically at 0600 and journals events', () => {
    const home = tempHome();
    const events: string[] = [];
    let now = 1_000;
    const registry = new AwarenessRegistry({
      home,
      now: () => now,
      onEvent: (event) => events.push(event.type),
      staleness: { staleAfterMs: 50, offlineAfterMs: 100 },
    });

    const candidate = mockSpecToCandidate({
      transport: 'serial',
      endpoint: '/dev/cu.mock-esp32',
      vid: '303a',
      pid: '1001',
      vendor: 'Espressif',
      moduleId: 'pinout/esp32',
      confidence: 0.5,
    });
    const record = registry.observeCandidate(candidate, { mock: true });
    expect(record.state).toBe('PENDING_ENROLL');
    expect(record.evidenceLevel).toBe('SIMULATED');
    expect(record.mock).toBe(true);
    expect(events).toContain('seen');
    expect(events).toContain('identified');
    expect(events).toContain('state_changed');

    const path = join(home, 'awareness.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { devices: unknown[] };
    expect(stored.devices).toHaveLength(1);

    now = 1_200;
    const stale = registry.tick(now);
    expect(stale[0]?.state).toBe('OFFLINE');
    expect(events).toContain('offline');
  });

  it('enrolls only from PENDING_ENROLL / IDENTIFIED and never claims hardware', () => {
    const home = tempHome();
    const registry = new AwarenessRegistry({ home });
    const unknown = mockSpecToCandidate({
      transport: 'usb',
      endpoint: 'usb:1234:5678',
      vid: '1234',
      pid: '5678',
      moduleId: 'unknown/usb',
      unknown: true,
      confidence: 0.25,
    });
    const record = registry.observeCandidate(unknown, { mock: true });
    expect(record.state).toBe('IDENTIFIED');
    expect(() => registry.markEnrolled(record.id)).not.toThrow();
    expect(registry.get(record.id)?.state).toBe('ONLINE');
    expect(registry.get(record.id)?.evidenceLevel).toBe('SIMULATED');
  });

  it('reloads from disk', () => {
    const home = tempHome();
    const first = new AwarenessRegistry({ home });
    first.observeCandidate(
      mockSpecToCandidate({
        id: 'cand_reload',
        transport: 'mdns',
        endpoint: 'bridge.local',
        moduleId: 'pinout/bridge',
        confidence: 0.45,
      }),
      { mock: true },
    );
    chmodSync(join(home, 'awareness.json'), 0o600);

    const second = new AwarenessRegistry({ home });
    expect(second.get('cand_reload')?.transport).toBe('mdns');
  });
});
