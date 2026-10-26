import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeaseManager } from '../src/lease/leaseManager.js';

describe('LeaseManager', () => {
  let now: number;
  let manager: LeaseManager;

  beforeEach(() => {
    now = 1_000_000;
    manager = new LeaseManager({ now: () => now });
  });

  afterEach(() => {
    // keep vitest happy with fake clock variable
    expect(now).toBeGreaterThan(0);
  });

  it('acquires an exclusive lease and reports ownership', () => {
    const lease = manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'agent-a',
    });
    expect(lease.mode).toBe('exclusive');
    expect(lease.expiresAt).toBe(now + 60_000);
    expect(manager.permits('agent-a', 'arm-01', 'motion.move_to').permitted).toBe(true);
  });

  it('blocks a second exclusive acquirer and reports the conflict', () => {
    manager.acquire({ scope: { kind: 'device', deviceId: 'arm-01' }, owner: 'agent-a' });
    expect(() =>
      manager.acquire({ scope: { kind: 'device', deviceId: 'arm-01' }, owner: 'agent-b' }),
    ).toThrowError(/leased by 'agent-a'/);
  });

  it('allows concurrent shared-read leases but blocks exclusive over them', () => {
    manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'reader-a',
      mode: 'shared-read',
    });
    manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'reader-b',
      mode: 'shared-read',
    });
    expect(() =>
      manager.acquire({ scope: { kind: 'device', deviceId: 'arm-01' }, owner: 'writer' }),
    ).toThrowError(/leased by 'reader-a'/);
  });

  it('scopes leases to capabilities, not the whole device', () => {
    manager.acquire({
      scope: {
        kind: 'capability',
        deviceId: 'arm-01',
        capabilities: ['motion.move_to', 'motion.home'],
      },
      owner: 'agent-a',
    });
    // Motion is locked for others…
    expect(manager.permits('agent-b', 'arm-01', 'motion.move_to').permitted).toBe(false);
    // …but unrelated capabilities stay free.
    expect(manager.permits('agent-b', 'arm-01', 'gripper.close').permitted).toBe(false);
    // Readers can still observe motion state.
    expect(manager.permits('agent-b', 'arm-01', 'motion.move_to', 'shared-read').permitted).toBe(
      false,
    );
  });

  it('renews only for the owner and extends expiry', () => {
    const lease = manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'agent-a',
      ttlMs: 1000,
    });
    now += 500;
    const renewed = manager.renew(lease.id, 'agent-a', 1000);
    expect(renewed.expiresAt).toBe(now + 1000);
    expect(() => manager.renew(lease.id, 'agent-b')).toThrowError(/belongs to/);
  });

  it('expires leases after TTL so crashed agents cannot hold machines', () => {
    manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'agent-a',
      ttlMs: 1000,
    });
    now += 1500;
    expect(manager.permits('agent-b', 'arm-01', 'motion.move_to').permitted).toBe(false);
    expect(manager.list()).toHaveLength(0);
  });

  it('refuses to renew an expired lease', () => {
    const lease = manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'agent-a',
      ttlMs: 1000,
    });
    now += 2000;
    expect(() => manager.renew(lease.id, 'agent-a')).toThrowError(/expired or unknown/);
  });

  it('releases on demand and enforces ownership on release', () => {
    const lease = manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'agent-a',
    });
    expect(() => manager.release(lease.id, 'agent-b')).toThrowError(/belongs to/);
    manager.release(lease.id, 'agent-a');
    expect(manager.get(lease.id)).toBeUndefined();
    expect(manager.permits('agent-b', 'arm-01', 'motion.move_to').permitted).toBe(false);
  });

  it('force-releases without ownership checks', () => {
    const lease = manager.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'agent-a',
    });
    manager.forceRelease(lease.id);
    expect(manager.get(lease.id)).toBeUndefined();
  });

  it('reaps expired leases on contact and counts them', () => {
    manager.acquire({ scope: { kind: 'device', deviceId: 'arm-01' }, owner: 'a', ttlMs: 500 });
    manager.acquire({ scope: { kind: 'device', deviceId: 'arm-02' }, owner: 'b', ttlMs: 5000 });
    now += 1000;
    expect(manager.reapExpired()).toBe(1);
    expect(manager.list().map((l) => l.owner)).toEqual(['b']);
  });

  it('clamps acquire/renew TTL to maxTtlMs and drainExpired returns copies', () => {
    const capped = new LeaseManager({ now: () => now, maxTtlMs: 2_000 });
    const lease = capped.acquire({
      scope: { kind: 'device', deviceId: 'arm-01' },
      owner: 'a',
      ttlMs: 60_000,
    });
    expect(lease.expiresAt).toBe(now + 2_000);
    const renewed = capped.renew(lease.id, 'a', 99_000);
    expect(renewed.expiresAt).toBe(now + 2_000);
    now += 2_500;
    const drained = capped.drainExpired();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.id).toBe(lease.id);
    expect(capped.list()).toHaveLength(0);
  });

  it('lists leases filtered by owner and device', () => {
    manager.acquire({ scope: { kind: 'device', deviceId: 'arm-01' }, owner: 'a' });
    manager.acquire({ scope: { kind: 'device', deviceId: 'arm-02' }, owner: 'a' });
    manager.acquire({ scope: { kind: 'device', deviceId: 'arm-03' }, owner: 'b' });
    expect(manager.list({ owner: 'a' })).toHaveLength(2);
    expect(manager.list({ deviceId: 'arm-02' })).toHaveLength(1);
    expect(manager.list({ deviceId: 'arm-02', owner: 'a' })).toHaveLength(1);
    expect(manager.list({ deviceId: 'arm-03', owner: 'b' })).toHaveLength(1);
  });
});
