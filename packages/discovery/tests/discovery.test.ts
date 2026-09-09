import { describe, expect, it } from 'vitest';
import {
  CandidateValidationError,
  formatCandidatesTable,
  runDiscovery,
  validateCandidate,
  type DiscoveredCandidate,
} from '../src/core.js';
import {
  encodeMdnsQuery,
  mdnsDiscoveryPlugin,
  networkProbePlugin,
  parseMdnsResponse,
  serialDiscoveryPlugin,
} from '../src/plugins.js';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { ByteQueue } from '../../core/src/transports/byteQueue.js';
import { connect, type Transport } from '@pinout/core';

function candidate(overrides: Partial<DiscoveredCandidate>): DiscoveredCandidate {
  return {
    id: 'cand_test',
    endpoint: { kind: 'serial', address: '/dev/ttyFAKE' },
    possibleIdentity: [{ moduleId: 'pinout/esp32', vendor: 'Espressif', reason: 'test' }],
    evidence: [{ source: 'test', detail: 'fixture', weight: 0.5 }],
    confidence: 0.5,
    interfaces: ['serial'],
    ...overrides,
  };
}

describe('candidate honesty rules', () => {
  it('rejects candidates with no evidence', () => {
    expect(() => validateCandidate(candidate({ evidence: [] }))).toThrowError(
      CandidateValidationError,
    );
  });

  it('caps single-weak-heuristic confidence at 0.5', () => {
    expect(() =>
      validateCandidate(
        candidate({ confidence: 0.8, evidence: [{ source: 's', detail: 'd', weight: 0.4 }] }),
      ),
    ).toThrowError(/weak evidence/);
    expect(
      validateCandidate(
        candidate({ confidence: 0.5, evidence: [{ source: 's', detail: 'd', weight: 0.4 }] }),
      ),
    ).toBeDefined();
  });

  it('allows near-certainty only with device-confirmed evidence (weight >= 0.9)', () => {
    const confirmed = candidate({
      confidence: 0.9,
      evidence: [{ source: 'http-health', detail: 'answered {"ok":true}', weight: 0.9 }],
    });
    expect(validateCandidate(confirmed).confidence).toBe(0.9);
    expect(() =>
      validateCandidate(
        candidate({
          confidence: 0.96,
          evidence: [{ source: 'http-health', detail: 'ok', weight: 0.95 }],
        }),
      ),
    ).toThrowError(/0.95/);
  });
});

describe('serial plugin', () => {
  it('maps known manufacturer strings and never opens ports', async () => {
    const plugin = serialDiscoveryPlugin(async () => [
      { path: '/dev/cu.usbserial-1420', manufacturer: 'Silicon Labs' },
      { path: '/dev/cu.usbmodem-A', manufacturer: 'Arduino' },
      { path: '/dev/cu.mystery', manufacturer: 'MysteryCorp' },
    ]);
    const candidates = await plugin.discover({});
    expect(candidates).toHaveLength(3);

    const esp = candidates.find((c) => c.endpoint.address === '/dev/cu.usbserial-1420')!;
    expect(esp.possibleIdentity[0]!.moduleId).toBe('pinout/esp32');
    expect(esp.confidence).toBeLessThanOrEqual(0.5);
    expect(esp.interfaces).toEqual(['serial']);

    const mystery = candidates.find((c) => c.endpoint.address === '/dev/cu.mystery')!;
    expect(mystery.possibleIdentity[0]!.moduleId).toBe('unknown/serial');
    expect(mystery.confidence).toBeLessThanOrEqual(0.5);
  });

  it('does not enroll an open port that emits boot noise and never answers sys.hello', async () => {
    const transport = new UnsupportedSerialFixture();
    const started = Date.now();
    const run = await runDiscovery({
      plugins: [
        serialDiscoveryPlugin(async () => [
          { path: '/dev/cu.unsupported', manufacturer: 'MysteryCorp' },
        ]),
      ],
    });

    await expect(connect({ transport, timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(run.errors).toEqual([]);
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.possibleIdentity[0]!.moduleId).toBe('unknown/serial');
    expect(run.candidates[0]!.confidence).toBeLessThanOrEqual(0.5);
    expect(transport.writes).toHaveLength(1);
    expect(JSON.parse(transport.writes[0]!)).toMatchObject({ action: 'sys.hello' });
    expect(transport.closed).toBe(true);
  });
});

/** An open serial endpoint is not a Pinout device until sys.hello confirms it. */
class UnsupportedSerialFixture implements Transport {
  readonly kind = 'unsupported-serial-fixture';
  readonly readable = new ByteQueue();
  readonly writes: string[] = [];
  closed = false;

  async open(): Promise<void> {
    this.readable.push(new TextEncoder().encode('bootloader: unrelated device\n'));
    this.readable.push(new TextEncoder().encode('ready? no\n'));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.readable.close();
  }

  async write(data: Uint8Array): Promise<void> {
    this.writes.push(new TextDecoder().decode(data));
  }
}

describe('mDNS codec', () => {
  it('encodes a well-formed PTR query', () => {
    const packet = encodeMdnsQuery('_pinout._udp.local');
    expect(packet.readUInt16BE(4)).toBe(1); // one question
    expect(packet.subarray(13, 20).toString()).toBe('_pinout'); // skip length byte
    expect(packet.subarray(packet.length - 4, packet.length - 2).readUInt16BE(0)).toBe(12); // QTYPE PTR
  });

  it('parses response answer names', () => {
    // Hand-crafted: header (id=0x1234, qr=1, 0 questions, 1 answer),
    // answer name "My Device._pinout._udp.local" (with compression-free labels),
    // type PTR, class IN, no data.
    const name = Buffer.concat([
      Buffer.from([9]),
      Buffer.from('My Device', 'utf8'),
      Buffer.from([7]),
      Buffer.from('_pinout', 'utf8'),
      Buffer.from([4]),
      Buffer.from('_udp', 'utf8'),
      Buffer.from([5]),
      Buffer.from('local', 'utf8'),
      Buffer.from([0]),
    ]);
    const packet = Buffer.concat([
      Buffer.from([0x12, 0x34]), // id
      Buffer.from([0x84, 0x00]), // response
      Buffer.from([0x00, 0x00]), // 0 questions
      Buffer.from([0x00, 0x01]), // 1 answer
      Buffer.from([0x00, 0x00]), // 0 authority
      Buffer.from([0x00, 0x00]), // 0 additional
      name,
      Buffer.from([0x00, 0x0c]), // PTR
      Buffer.from([0x00, 0x01]), // IN
      Buffer.from([0x00, 0x00, 0x00, 0x78]), // TTL
      Buffer.from([0x00, 0x00]), // rdlength 0 (name-only; parsing skips data)
    ]);
    const answers = parseMdnsResponse(packet);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.name).toBe('My Device._pinout._udp.local');
  });

  it('malformed packets parse to nothing (no crash)', () => {
    expect(parseMdnsResponse(Buffer.from([1, 2, 3]))).toEqual([]);
    expect(parseMdnsResponse(Buffer.alloc(0))).toEqual([]);
  });

  it('live plugin: bounded window resolves even with no responders', async () => {
    const plugin = mdnsDiscoveryPlugin(150);
    const started = Date.now();
    const candidates = await plugin.discover({});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(Array.isArray(candidates)).toBe(true);
  }, 5000);
});

describe('network probe (opt-in)', () => {
  let port = 0;
  let server: ReturnType<typeof createServer> | undefined;

  it('probes only explicitly supplied endpoints and detects a pinout daemon', async () => {
    server = createServer((socket) => {
      socket.on('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"ok":true,"devices":1}',
        );
        socket.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    const plugin = networkProbePlugin();
    // Opt-out: nothing probed.
    expect(
      await plugin.discover({
        network: { enabled: false, endpoints: [{ host: '127.0.0.1', port }] },
      }),
    ).toEqual([]);

    const candidates = await plugin.discover({
      network: { enabled: true, endpoints: [{ host: '127.0.0.1', port, probe: 'pinout-daemon' }] },
      timeoutMs: 300,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.possibleIdentity[0]!.moduleId).toBe('pinout/daemon');
    expect(candidates[0]!.confidence).toBe(0.9);
    expect(candidates[0]!.evidence[0]!.detail).toContain('/v1/health');
  });

  it('returns nothing for unreachable endpoints', async () => {
    const plugin = networkProbePlugin();
    const candidates = await plugin.discover({
      network: { enabled: true, endpoints: [{ host: '127.0.0.1', port: 1 }] },
      timeoutMs: 100,
    });
    expect(candidates).toEqual([]);
  });

  it('cleans up the server', async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });
});

describe('runDiscovery', () => {
  it('merges candidates for the same endpoint and isolates plugin errors', async () => {
    const goodPlugin = {
      name: 'good',
      discover: async () => [
        candidate({
          id: 'cand_1',
          endpoint: { kind: 'serial', address: '/dev/x' },
          confidence: 0.4,
        }),
      ],
    };
    const duplicatingPlugin = {
      name: 'dup',
      discover: async () => [
        candidate({
          id: 'cand_1b',
          endpoint: { kind: 'serial', address: '/dev/x' },
          confidence: 0.5,
          evidence: [{ source: 'dup', detail: 'second view', weight: 0.5 }],
        }),
      ],
    };
    const brokenPlugin = {
      name: 'broken',
      discover: async () => {
        throw new Error('plugin exploded');
      },
    };
    const run = await runDiscovery({ plugins: [goodPlugin, duplicatingPlugin, brokenPlugin] });
    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.evidence.length).toBe(2);
    expect(run.pluginsRun).toEqual(['good', 'dup', 'broken']);
    expect(run.errors).toEqual([{ plugin: 'broken', message: 'plugin exploded' }]);
  });

  it('sorts candidates by confidence', async () => {
    const run = await runDiscovery({
      plugins: [
        {
          name: 'a',
          discover: async () => [
            candidate({
              id: 'low',
              endpoint: { kind: 'serial', address: '/dev/low' },
              confidence: 0.3,
            }),
          ],
        },
        {
          name: 'b',
          discover: async () => [
            candidate({
              id: 'high',
              endpoint: { kind: 'serial', address: '/dev/high' },
              confidence: 0.5,
              evidence: [{ source: 's', detail: 'd', weight: 0.5 }],
            }),
          ],
        },
      ],
    });
    expect(run.candidates.map((c) => c.id)).toEqual(['high', 'low']);
  });
});

describe('formatCandidatesTable', () => {
  it('prints the operator-facing format', () => {
    const lines = formatCandidatesTable([
      candidate({
        endpoint: { kind: 'serial', address: '/dev/cu.usbserial-1420' },
        confidence: 0.5,
      }),
    ]);
    const text = lines.join('\n');
    expect(text).toContain('FOUND 1 CANDIDATE DEVICES');
    expect(text).toContain('/dev/cu.usbserial-1420');
    expect(text).toContain('possible: Espressif pinout/esp32');
    expect(text).toContain('confidence: 0.50');
    expect(text).toContain('evidence:');
  });
});
