import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoutRuntime, relayModule, registerModule } from '@pinout/core';
import { startDaemon, type RunningDaemon } from '../src/start.js';

let daemon: RunningDaemon;
let base: string;
let journalDir: string;

beforeAll(async () => {
  const runtime = new PinoutRuntime();
  registerModule(relayModule);
  await runtime.registerFromModule(relayModule.id, { id: 'relay-01', simulated: true });
  journalDir = await mkdtemp(join(tmpdir(), 'pinoutd-latency-'));
  daemon = await startDaemon(runtime, {
    port: 0,
    journalPath: join(journalDir, 'journal.jsonl'),
    requireLeases: false,
  });
  base = `http://127.0.0.1:${daemon.port}`;
});

afterAll(async () => {
  await daemon?.close();
  await rm(journalDir, { recursive: true, force: true });
});

describe('batched latency API', () => {
  it('lists MCP-ready capability tools for a registered relay', async () => {
    const res = await fetch(`${base}/v1/tools`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Array<{
        deviceId: string;
        capability: string;
        mcpName: string;
        name: string;
        description: string;
        inputSchema: unknown;
        outputSchema: unknown;
        annotations: { physicalOutput: boolean };
      }>;
    };
    const relaySet = body.tools.find(
      (tool) => tool.deviceId === 'relay-01' && tool.capability === 'relay.set',
    );
    expect(relaySet).toMatchObject({
      deviceId: 'relay-01',
      capability: 'relay.set',
      mcpName: 'relay_01__relay_set',
      name: 'relay.set',
    });
    expect(relaySet?.description).toContain('relay-01');
    expect(relaySet?.inputSchema).toBeDefined();
    expect(relaySet?.outputSchema).toBeDefined();
    expect(relaySet?.annotations.physicalOutput).toBe(true);
  });

  it('returns a snapshot with safety and per-device state', async () => {
    const res = await fetch(`${base}/v1/snapshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      uptimeMs: number;
      safety: string;
      devices: Array<{
        id: string;
        capabilities: string[];
        capabilityDescriptors: Array<{ name: string }>;
        operationalState: Record<string, unknown>;
        stateEvidence: Record<string, unknown>;
        health: { lifecycle: string };
      }>;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.safety).toBe('NORMAL');
    const relay = body.devices.find((device) => device.id === 'relay-01');
    expect(relay).toBeDefined();
    expect(relay?.capabilities).toContain('relay.set');
    expect(relay?.capabilityDescriptors.some((capability) => capability.name === 'relay.set')).toBe(
      true,
    );
    expect(relay?.operationalState).toBeDefined();
    expect(relay?.stateEvidence).toBeDefined();
    expect(relay?.health.lifecycle).toBeDefined();
  });

  it('keeps GET /v1/health and GET /v1/devices working', async () => {
    const healthRes = await fetch(`${base}/v1/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { ok: boolean; devices: number; safety: string };
    expect(health.ok).toBe(true);
    expect(health.devices).toBe(1);
    expect(health.safety).toBe('NORMAL');

    const devicesRes = await fetch(`${base}/v1/devices`);
    expect(devicesRes.status).toBe(200);
    const list = (await devicesRes.json()) as {
      devices: Array<{ id: string; capabilityDescriptors?: unknown }>;
    };
    expect(list.devices.map((device) => device.id)).toContain('relay-01');
    expect(list.devices[0]?.capabilityDescriptors).toBeUndefined();
  });

  it('optionally includes capabilityDescriptors on GET /v1/devices', async () => {
    const res = await fetch(`${base}/v1/devices?include=capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: Array<{ id: string; capabilityDescriptors?: Array<{ name: string }> }>;
    };
    const relay = body.devices.find((device) => device.id === 'relay-01');
    expect(
      relay?.capabilityDescriptors?.some((capability) => capability.name === 'relay.set'),
    ).toBe(true);
  });
});
