import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  generateConnector,
  ingestSysHello,
  ingestGattDump,
  ingestMqttObservations,
  ingestMdnsOpenApi,
  HARDWARE_INTERFACE_KINDS,
  detectSourceKind,
  mapFromGeneratorLifecycle,
  capSupportLevel,
} from '../src/index.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

function loadFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/** Typecheck generated connector sources against monorepo @pinout/core. */
function typecheckGenerated(files: Record<string, string>): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pinout-connector-tsc-'));
  try {
    writeFiles(dir, files);
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        paths: {
          '@pinout/core': [join(repoRoot, 'packages/core/src/index.ts')],
        },
        baseUrl: dir,
      },
      include: ['src/**/*.ts'],
    };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
    const tscBin = join(repoRoot, 'node_modules/typescript/bin/tsc');
    const result = spawnSync(process.execPath, [tscBin, '-p', dir, '--pretty', 'false'], {
      encoding: 'utf8',
      cwd: dir,
    });
    return {
      ok: result.status === 0,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('IR interface kinds', () => {
  it('includes ble-gatt, mqtt, mdns, serial-bridge while keeping legacy kinds', () => {
    expect(HARDWARE_INTERFACE_KINDS).toEqual(
      expect.arrayContaining([
        'tcp',
        'serial',
        'http',
        'sdk',
        'unknown',
        'ble-gatt',
        'mqtt',
        'mdns',
        'serial-bridge',
      ]),
    );
  });
});

describe('SupportLevel (core PR0)', () => {
  it('maps generator lifecycle with generated cap at COMPILE_TESTED', () => {
    expect(mapFromGeneratorLifecycle('SIMULATION_TESTED', { generated: true })).toBe('SIMULATED');
    expect(mapFromGeneratorLifecycle('HUMAN_REVIEWED', { generated: true })).toBe('COMPILE_TESTED');
    expect(mapFromGeneratorLifecycle('HARDWARE_TESTED', { generated: true })).toBe('COMPILE_TESTED');
    expect(capSupportLevel('HARDWARE_VERIFIED', 'COMPILE_TESTED')).toBe('COMPILE_TESTED');
  });
});

describe('sys.hello ingest', () => {
  it('maps advertised capabilities onto serial-bridge IR with evidence', () => {
    const raw = loadFixture('fixtures/generator/serial-hello/hello.json');
    const ir = ingestSysHello(raw);
    expect(ir.interfaces.some((iface) => iface.kind === 'serial-bridge')).toBe(true);
    expect(ir.capabilities.map((c) => c.id)).toContain('gpio.write');
    expect(ir.capabilities.every((c) => c.evidence.length > 0)).toBe(true);
    const write = ir.capabilities.find((c) => c.id === 'gpio.write');
    expect(write?.safetyClass).toBe('physicalOutput');
    expect(write?.requiresApproval).toBe(true);
    const read = ir.capabilities.find((c) => c.id === 'gpio.read');
    expect(read?.safetyClass).toBe('readOnly');
  });

  it('does not invent capabilities when the list is empty', () => {
    const ir = ingestSysHello({ boardId: 'empty', capabilities: [] });
    expect(ir.capabilities).toHaveLength(0);
    expect(ir.uncertainties.length).toBeGreaterThan(0);
  });
});

describe('GATT ingest', () => {
  it('marks write/notify as physicalOutput candidates and read as read-only', () => {
    const raw = loadFixture('fixtures/generator/ble-gatt-lamp/gatt-dump.json');
    const ir = ingestGattDump(raw);
    expect(ir.interfaces[0]?.kind).toBe('ble-gatt');
    const write = ir.capabilities.find((c) => c.id.includes('write'));
    const read = ir.capabilities.find((c) => c.id.endsWith('.read'));
    const notify = ir.capabilities.find((c) => c.id.includes('notify'));
    expect(write?.safetyClass).toBe('physicalOutput');
    expect(write?.requiresApproval).toBe(true);
    expect(read?.safetyClass).toBe('readOnly');
    expect(notify?.safetyClass).toBe('physicalOutput');
    expect(ir.safety.some((s) => s.requiresApproval)).toBe(true);
  });
});

describe('MQTT ingest', () => {
  it('infers schemas from samples without inventing topics', () => {
    const raw = loadFixture('fixtures/generator/mqtt-sensor-relay/topics.json');
    const ir = ingestMqttObservations(raw);
    expect(ir.interfaces[0]?.kind).toBe('mqtt');
    expect(ir.capabilities.length).toBeGreaterThanOrEqual(2);
    const sensor = ir.capabilities.find(
      (c) => c.id.includes('tele_sensor') || c.id.includes('SENSOR'),
    );
    const relay = ir.capabilities.find((c) => c.safetyClass === 'physicalOutput');
    expect(sensor?.safetyClass).toBe('readOnly');
    expect(relay?.requiresApproval).toBe(true);
    expect(relay?.arguments?.on?.type).toBe('boolean');
  });
});

describe('mDNS / OpenAPI ingest', () => {
  it('emits http+mdns interfaces and read-only GET operations', () => {
    const raw = loadFixture('fixtures/generator/unknown-weird/openapi-ish.json');
    const ir = ingestMdnsOpenApi(raw);
    expect(ir.interfaces.some((iface) => iface.kind === 'mdns')).toBe(true);
    expect(ir.interfaces.some((iface) => iface.kind === 'http')).toBe(true);
    expect(ir.capabilities.some((c) => c.id === 'status.read')).toBe(true);
    expect(ir.capabilities.find((c) => c.id === 'status.read')?.safetyClass).toBe('readOnly');
  });
});

describe('generateConnector API', () => {
  it('returns in-memory files with SIMULATED evidence and never-install flags', async () => {
    const raw = loadFixture('fixtures/generator/serial-hello/hello.json');
    const result = await generateConnector({
      source: 'sys.hello',
      raw,
      inMemory: true,
    });
    expect(result.evidenceLevel).toBe('SIMULATED');
    expect(result.report.neverInstalls).toBe(true);
    expect(result.report.neverRegisters).toBe(true);
    expect(result.files['src/capabilities.ts']).toContain('generatedCapabilities');
    expect(result.files['src/simulator.ts']).toContain('GeneratedConnectorSimulator');
    expect(result.files['src/backend.ts']).toContain('skeleton');
    expect(result.files['src/types.ts']).toContain('validateGeneratedConnectorConfig');
    expect(result.files['test/conformance.test.ts']).toContain('conformance');
    expect(result.files['docs/connector.md']).toContain('UNVERIFIED');
    expect(result.files['catalog-entry.json']).toContain('SIMULATED');
    expect(result.report.pendingApprovals.length).toBeGreaterThan(0);
    expect(JSON.parse(result.files['evidence/report.json']!).neverAutoInstall).toBe(true);
  });

  it('typechecks serial-hello generated sources', async () => {
    const raw = loadFixture('fixtures/generator/serial-hello/hello.json');
    const result = await generateConnector({ source: 'sys.hello', raw, inMemory: true });
    const check = typecheckGenerated(result.files);
    expect(check.ok, check.output).toBe(true);
  });

  it('typechecks BLE GATT lamp connector', async () => {
    const raw = loadFixture('fixtures/generator/ble-gatt-lamp/gatt-dump.json');
    const result = await generateConnector({ source: 'gatt', raw, inMemory: true });
    expect(result.ir.interfaces[0]?.kind).toBe('ble-gatt');
    const check = typecheckGenerated(result.files);
    expect(check.ok, check.output).toBe(true);
  });

  it('typechecks MQTT sensor+relay connector', async () => {
    const raw = loadFixture('fixtures/generator/mqtt-sensor-relay/topics.json');
    const result = await generateConnector({ source: 'mqtt', raw, inMemory: true });
    expect(result.capabilities.some((c) => c.safetyClass === 'physicalOutput')).toBe(true);
    const check = typecheckGenerated(result.files);
    expect(check.ok, check.output).toBe(true);
  });

  it('handles unknown weird device without inventing device capabilities', async () => {
    const raw = loadFixture('fixtures/generator/unknown-weird/device.json');
    expect(detectSourceKind(raw)).toBe('sys.hello');
    const result = await generateConnector({ source: 'auto', raw, inMemory: true });
    expect(result.capabilities.map((c) => c.id)).toEqual(['generator.unresolved']);
    expect(result.ir.uncertainties.some((u) => u.id === 'no-capabilities-discovered')).toBe(true);
    expect(result.evidenceLevel).toBe('SIMULATED');
    const check = typecheckGenerated(result.files);
    expect(check.ok, check.output).toBe(true);
  });

  it('writes to outDir and refuses overwrite without flag', async () => {
    const raw = loadFixture('fixtures/generator/serial-hello/hello.json');
    const dir = mkdtempSync(join(tmpdir(), 'pinout-connector-out-'));
    try {
      const first = await generateConnector({ source: 'sys.hello', raw, outDir: dir });
      expect(first.outputPath).toBe(dir);
      expect(readFileSync(join(dir, 'GENERATION_REPORT.md'), 'utf8')).toContain('UNVERIFIED');
      await expect(generateConnector({ source: 'sys.hello', raw, outDir: dir })).rejects.toThrow(
        /already exists/,
      );
      const second = await generateConnector({
        source: 'sys.hello',
        raw,
        outDir: dir,
        overwrite: true,
      });
      expect(second.outputPath).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('physicalOutput schemas are strict (no additionalProperties)', async () => {
    const raw = loadFixture('fixtures/generator/ble-gatt-lamp/gatt-dump.json');
    const result = await generateConnector({ source: 'gatt', raw, inMemory: true });
    for (const cap of result.capabilities) {
      if (cap.safetyClass === 'physicalOutput') {
        expect(cap.inputSchema?.additionalProperties).toBe(false);
        expect(cap.requiresApproval).toBe(true);
      }
    }
    expect(result.files['src/capabilities.ts']).toContain('additionalProperties: false');
    expect(result.files['src/index.ts']).toContain('generatedRequiresApproval');
    expect(result.report.pendingApprovals.length).toBeGreaterThan(0);
  });
});
