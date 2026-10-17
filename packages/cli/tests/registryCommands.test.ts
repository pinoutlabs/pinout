import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contentHash,
  generatePublisherKeyPair,
  manifestHash,
  signModule,
} from '@pinout/module-host';
import { runCli } from '../src/runCli.js';

interface RunResult {
  code: number;
  lines: string[];
  text: string;
}

async function run(argv: string[]): Promise<RunResult> {
  const lines: string[] = [];
  const code = await runCli(['node', 'pinout', ...argv], {
    log: (value: unknown) => lines.push(typeof value === 'string' ? value : JSON.stringify(value)),
    error: (message: string) => lines.push(message),
  });
  return { code, lines, text: lines.join('\n') };
}

const RUNNABLE_SOURCE = (id: string, version: string): string => `const capability = {
  name: 'climate.read',
  description: 'Read the climate sensor state.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: { temperatureC: { type: 'number' } },
    required: ['temperatureC'],
    additionalProperties: false,
  },
  safety: { physicalOutput: false, reversible: true },
};

const definition = {
  id: '${id}',
  version: '${version}',
  deviceClass: 'climate.sensor',
  capabilities: [capability],
  capabilityNames: ['climate.read'],
  policies: [],
  supportedTransportKinds: ['simulated'],
  createSimulatedBackend() {
    return {
      kind: 'simulated',
      async invoke(action) {
        if (action !== 'climate.read') {
          throw new Error('unknown capability ' + action);
        }
        return { temperatureC: 21 };
      },
      async close() {},
      subscribe() {
        return () => {};
      },
    };
  },
};

export default definition;
`;

function writeFixture(root: string, id: string, version = '0.1.0'): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'pinout.module.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id,
        version,
        deviceClass: 'climate.sensor',
        entrypoint: './index.js',
        runtime: 'node',
        capabilities: ['climate.read'],
        simulation: { provided: true },
        status: 'TESTED',
        name: 'Climate Fixture',
        description: 'CLI registry test fixture',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(root, 'index.js'), RUNNABLE_SOURCE(id, version), 'utf8');
  return root;
}

let dir: string;
let registryDir: string;
let fixture: string;
let keys: { publicKeyPem: string; privateKeyPem: string };
let privateKeyPath: string;
let publicKeyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinout-cli-registry-'));
  registryDir = join(dir, 'registry');
  mkdirSync(registryDir, { recursive: true });
  fixture = writeFixture(join(dir, 'fixtures/climate'), 'test/climate');
  keys = generatePublisherKeyPair();
  privateKeyPath = join(dir, 'signing-key.pem');
  publicKeyPath = join(dir, 'publisher.pem');
  writeFileSync(privateKeyPath, keys.privateKeyPem, 'utf8');
  writeFileSync(publicKeyPath, keys.publicKeyPem, 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI module pack', () => {
  it('writes a signed entry with module-host hash parity', async () => {
    const entryPath = join(dir, 'entry.json');
    const result = await run([
      'module',
      'pack',
      fixture,
      '--sign-key',
      privateKeyPath,
      '--publisher',
      'pinoutlabs',
      '--status',
      'L2',
      '--target',
      'esp32',
      '--out',
      entryPath,
    ]);

    expect(result.code).toBe(0);
    expect(result.text).toContain('Packed test/climate@0.1.0');
    expect(existsSync(entryPath)).toBe(true);

    const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
    const manifest = JSON.parse(readFileSync(join(fixture, 'pinout.module.json'), 'utf8'));
    expect(entry['publisher']).toBe('pinoutlabs');
    expect(entry['status']).toBe('L2');
    expect(entry['targets']).toEqual(['esp32']);
    expect(entry['manifestHash']).toBe(manifestHash(manifest));
    expect(entry['contentHash']).toBe(contentHash(fixture));
    const moduleHostSignature = signModule(fixture, manifest, 'pinoutlabs', keys.privateKeyPem);
    expect(entry['signature']).toBe(moduleHostSignature.signature);
  });

  it('prints the entry as JSON without --out', async () => {
    const result = await run(['module', 'pack', fixture]);
    expect(result.code).toBe(0);
    const entry = JSON.parse(result.text) as Record<string, unknown>;
    expect(entry['name']).toBe('test/climate');
    expect(entry['status']).toBe('UNVERIFIED');
    expect(entry['signature']).toBeUndefined();
  });

  it('requires --publisher together with --sign-key', async () => {
    const result = await run(['module', 'pack', fixture, '--sign-key', privateKeyPath]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('--sign-key requires --publisher');

    const other = await run(['module', 'pack', fixture, '--publisher', 'pinoutlabs']);
    expect(other.code).toBe(1);
    expect(other.text).toContain('--publisher requires --sign-key');
  });
});

describe('CLI module publish, search, info', () => {
  it('publishes, dedupes, replaces, and lists entries', async () => {
    const dryRegistry = join(dir, 'dry-registry');
    mkdirSync(dryRegistry, { recursive: true });
    const dryRun = await run([
      'module',
      'publish',
      fixture,
      '--registry',
      dryRegistry,
      '--dry-run',
    ]);
    expect(dryRun.code).toBe(0);
    expect(dryRun.text).toContain('DRY RUN — nothing was written.');
    expect(existsSync(join(dryRegistry, 'registry.json'))).toBe(false);

    const result = await run([
      'module',
      'publish',
      fixture,
      '--registry',
      registryDir,
      '--sign-key',
      privateKeyPath,
      '--publisher',
      'pinoutlabs',
    ]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('Published test/climate@0.1.0');

    const indexPath = join(registryDir, 'registry.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      modules: Array<Record<string, unknown>>;
    };
    expect(index.modules).toHaveLength(1);
    expect(index.modules[0]?.['publisher']).toBe('pinoutlabs');
    expect(existsSync(join(registryDir, 'modules/test-climate@0.1.0/index.js'))).toBe(true);

    const duplicate = await run([
      'module',
      'publish',
      fixture,
      '--registry',
      registryDir,
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.text).toContain('[MODULE_ALREADY_PUBLISHED]');

    const replaced = await run([
      'module',
      'publish',
      fixture,
      '--registry',
      registryDir,
      '--replace',
    ]);
    expect(replaced.code).toBe(0);
  });

  it('searches and inspects entries with text and JSON output', async () => {
    await run(['module', 'publish', fixture, '--registry', registryDir]);

    const search = await run(['module', 'search', 'climate', '--registry', registryDir]);
    expect(search.code).toBe(0);
    expect(search.text).toContain('test/climate');

    const empty = await run(['module', 'search', 'nothing', '--registry', registryDir]);
    expect(empty.code).toBe(0);
    expect(empty.text).toContain('No modules match');

    const json = await run(['--json', 'module', 'search', 'climate', '--registry', registryDir]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.text) as { modules: unknown[] };
    expect(parsed.modules).toHaveLength(1);

    const info = await run(['module', 'info', 'test/climate', '--registry', registryDir]);
    expect(info.code).toBe(0);
    expect(info.text).toContain('MODULE:      test/climate@0.1.0');
    expect(info.text).toContain('SIGNATURE:   absent');

    const infoJson = await run([
      '--json',
      'module',
      'info',
      'test/climate@^0.1.0',
      '--registry',
      registryDir,
    ]);
    expect(infoJson.code).toBe(0);
    expect((JSON.parse(infoJson.text) as Record<string, unknown>)['version']).toBe('0.1.0');

    const missing = await run(['module', 'info', 'test/absent', '--registry', registryDir]);
    expect(missing.code).toBe(1);
    expect(missing.text).toContain('[MODULE_NOT_FOUND]');
  });
});

describe('CLI module install and verify through --registry', () => {
  async function publishSignedModule(moduleDir = fixture): Promise<void> {
    const result = await run([
      'module',
      'publish',
      moduleDir,
      '--registry',
      registryDir,
      '--sign-key',
      privateKeyPath,
      '--publisher',
      'pinoutlabs',
    ]);
    expect(result.code).toBe(0);
  }

  it('installs, verifies, refuses duplicates, and forces replacement', async () => {
    await publishSignedModule();
    const outDir = join(dir, 'installed');
    const installed = join(outDir, 'test__climate@0.1.0');

    const result = await run([
      'module',
      'install',
      'test/climate',
      '--registry',
      registryDir,
      '--out',
      outDir,
      '--allow-publisher',
      `pinoutlabs=${publicKeyPath}`,
    ]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('Installed test/climate@0.1.0');
    expect(existsSync(join(installed, 'pinout.module.sig'))).toBe(true);

    const duplicate = await run([
      'module',
      'install',
      'test/climate',
      '--registry',
      registryDir,
      '--out',
      outDir,
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.text).toContain('[MODULE_ALREADY_PRESENT]');

    const forced = await run([
      'module',
      'install',
      'test/climate',
      '--registry',
      registryDir,
      '--out',
      outDir,
      '--force',
    ]);
    expect(forced.code).toBe(0);

    const verified = await run([
      'module',
      'verify',
      installed,
      '--registry',
      registryDir,
      '--allow-publisher',
      `pinoutlabs=${publicKeyPath}`,
    ]);
    expect(verified.code).toBe(0);
    expect(verified.text).toContain('REGISTRY VERIFICATION: OK');
    expect(verified.text).toContain('SIGNATURE: VALID');

    const untrusted = await run([
      'module',
      'verify',
      installed,
      '--registry',
      registryDir,
    ]);
    expect(untrusted.code).toBe(0);
    expect(untrusted.text).toContain('SIGNATURE: UNTRUSTED');
  });

  it('installs into <PINOUT_HOME>/registry-modules by default', async () => {
    await run(['module', 'publish', fixture, '--registry', registryDir]);
    const home = join(dir, 'home');
    const previous = process.env['PINOUT_HOME'];
    process.env['PINOUT_HOME'] = home;
    try {
      const result = await run([
        'module',
        'install',
        'test/climate',
        '--registry',
        registryDir,
      ]);
      expect(result.code).toBe(0);
      expect(existsSync(join(home, 'registry-modules/test__climate@0.1.0/index.js'))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env['PINOUT_HOME'];
      } else {
        process.env['PINOUT_HOME'] = previous;
      }
    }
  });

  it('rejects unsigned entries under --require-signature', async () => {
    await run(['module', 'publish', fixture, '--registry', registryDir]);
    const result = await run([
      'module',
      'install',
      'test/climate',
      '--registry',
      registryDir,
      '--out',
      join(dir, 'strict'),
      '--require-signature',
    ]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('[MODULE_UNTRUSTED]');
  });

  it('rejects wrong publisher keys', async () => {
    await publishSignedModule();
    const other = generatePublisherKeyPair();
    const otherPath = join(dir, 'other.pem');
    writeFileSync(otherPath, other.publicKeyPem, 'utf8');

    const wrongKey = await run([
      'module',
      'install',
      'test/climate',
      '--registry',
      registryDir,
      '--out',
      join(dir, 'wrong-key'),
      '--allow-publisher',
      `pinoutlabs=${otherPath}`,
    ]);
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.text).toContain('[MODULE_SIGNATURE_INVALID]');
  });

  it('rejects tampered payloads', async () => {
    await publishSignedModule();
    const payloadIndex = join(registryDir, 'modules/test-climate@0.1.0/index.js');
    writeFileSync(payloadIndex, 'export default { hacked: true };\n', 'utf8');

    const tampered = await run([
      'module',
      'install',
      'test/climate',
      '--registry',
      registryDir,
      '--out',
      join(dir, 'tampered-install'),
      '--allow-publisher',
      `pinoutlabs=${publicKeyPath}`,
    ]);
    expect(tampered.code).toBe(1);
    expect(tampered.text).toContain('[MODULE_HASH_MISMATCH]');
  });

  it('verifies a source directory against the registry and reports mismatches', async () => {
    await publishSignedModule();
    const moduleDir = writeFixture(join(dir, 'fixtures/copy'), 'test/climate');
    const ok = await run([
      'module',
      'verify',
      moduleDir,
      '--registry',
      registryDir,
      '--allow-publisher',
      `pinoutlabs=${publicKeyPath}`,
    ]);
    expect(ok.code).toBe(0);
    expect(ok.text).toContain('REGISTRY VERIFICATION: OK');

    writeFileSync(join(moduleDir, 'index.js'), 'export default { changed: true };\n', 'utf8');
    const mismatch = await run([
      'module',
      'verify',
      moduleDir,
      '--registry',
      registryDir,
      '--allow-publisher',
      `pinoutlabs=${publicKeyPath}`,
    ]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.text).toContain('[MODULE_HASH_MISMATCH]');
  });
});

describe('CLI module conformance', () => {
  it('emits and writes the L2 report for a runnable module', async () => {
    const reportPath = join(dir, 'reports/conformance.json');
    const result = await run(['module', 'conformance', fixture, '--json', reportPath]);

    expect(result.code).toBe(0);
    expect(result.text).toContain('L2 CONFORMANCE_PASS');
    expect(result.text).toContain('PASS (>= L2)');
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      level: string;
      passed: boolean;
      lanes: unknown[];
    };
    expect(report.level).toBe('L2');
    expect(report.passed).toBe(true);
    expect(report.lanes).toHaveLength(6);
  });

  it('records simulation, integration, and hardware evidence up to L5', async () => {
    const hardwarePath = join(dir, 'hardware.json');
    writeFileSync(
      hardwarePath,
      `${JSON.stringify({
        date: '2026-09-08',
        hardware: 'ESP32 classic DevKit',
        firmwareVersion: '0.0.1-alpha.1',
        moduleVersion: '0.1.0',
        testSuiteVersion: '0.1.0',
      })}\n`,
      'utf8',
    );
    const result = await run([
      'module',
      'conformance',
      fixture,
      '--simulation-verified',
      '--integration-verified',
      '--hardware-record',
      hardwarePath,
    ]);
    expect(result.code).toBe(0);
    expect(result.text).toContain('L5 HARDWARE_VERIFIED');

    const globalJson = await run(['--json', 'module', 'conformance', fixture]);
    expect(globalJson.code).toBe(0);
    const report = JSON.parse(globalJson.text) as Record<string, unknown>;
    expect(report['level']).toBe('L2');
  });

  it('fails below L2 with CONFORMANCE_FAILED and still writes the report', async () => {
    const broken = join(dir, 'fixtures/broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      join(broken, 'pinout.module.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'test/broken',
        version: '0.1.0',
        deviceClass: 'climate.sensor',
        entrypoint: './index.js',
        runtime: 'node',
        capabilities: ['climate.read'],
        simulation: { provided: true },
        status: 'TESTED',
      })}\n`,
      'utf8',
    );
    writeFileSync(join(broken, 'index.js'), 'export default {};\n', 'utf8');

    const reportPath = join(dir, 'broken-report.json');
    const result = await run(['module', 'conformance', broken, '--json', reportPath]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('[CONFORMANCE_FAILED]');
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { passed: boolean };
    expect(report.passed).toBe(false);
  });

  it('reports malformed hardware records as CONFORMANCE_FAILED', async () => {
    const hardwarePath = join(dir, 'bad-hardware.json');
    writeFileSync(
      hardwarePath,
      `${JSON.stringify({
        date: '2026-9-8',
        hardware: 'ESP32 classic DevKit',
        firmwareVersion: '0.0.1-alpha.1',
        moduleVersion: '0.1.0',
        testSuiteVersion: '0.1.0',
      })}\n`,
      'utf8',
    );
    const result = await run([
      'module',
      'conformance',
      fixture,
      '--hardware-record',
      hardwarePath,
    ]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('[CONFORMANCE_FAILED]');
    expect(result.text).toContain('YYYY-MM-DD');
  });
});
