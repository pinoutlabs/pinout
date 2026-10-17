/**
 * Registry CLI commands (registry v0).
 *
 * `pinout module pack|publish|search|info|conformance` plus the `--registry`
 * flows that extend the existing `module install` / `module verify` commands.
 *
 * Offline-first: a local directory containing `registry.json` (or a path to an
 * index file) is the primary, fully supported path. `https://` index URLs work
 * through the same client but are secondary; publishing requires a local index.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { resolvePinoutHome } from '@pinout/core';
import type { CliOutput } from './output.js';
import type * as Registry from '@pinout/registry';

export interface RegistryPackFlags {
  signKey?: string;
  publisher?: string;
  status?: string;
  url?: string;
  out?: string;
  target?: string[];
}

export interface RegistryPublishFlags {
  registry: string;
  index?: string;
  dryRun?: boolean;
  replace?: boolean;
  signKey?: string;
  publisher?: string;
  status?: string;
  url?: string;
  target?: string[];
}

export interface RegistryInstallFlags {
  registry: string;
  out?: string;
  force?: boolean;
  requireSignature?: boolean;
  allowPublisher?: string[];
}

export interface RegistryVerifyFlags {
  registry: string;
  name?: string;
  version?: string;
  requireSignature?: boolean;
  allowPublisher?: string[];
  publisher?: string[];
}

export interface RegistryConformanceFlags {
  json?: string;
  simulationVerified?: boolean;
  integrationVerified?: boolean;
  hardwareRecord?: string;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Attach registry commands to the EXISTING `module` command. */
export function registerRegistryCommands(
  existingModuleCommand: Command,
  outputFor: () => CliOutput,
): void {
  const module = existingModuleCommand;

  module
    .command('pack <dir>')
    .description(
      'Pack a module directory into a registry entry (hashes, optional Ed25519 signature).',
    )
    .option('--sign-key <pem>', 'sign with a PEM Ed25519 private key (requires --publisher)')
    .option('--publisher <id>', 'publisher id recorded in the entry (requires --sign-key)')
    .option('--status <status>', 'conformance status L0..L5 or UNVERIFIED (default UNVERIFIED)')
    .option('--url <url>', 'payload location recorded in the entry')
    .option('--target <target>', 'target label (repeatable; default: manifest runtime)', collect)
    .option('--out <file>', 'write the entry JSON to a file')
    .action(async (dir: string, options: RegistryPackFlags) => {
      const out = outputFor();
      const registry = await importRegistry();
      try {
        const prepared = preparePack(registry, options);
        const packed = await packAndVerify(registry, dir, prepared);
        if (options.out) {
          const outPath = resolve(options.out);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, `${JSON.stringify(packed.entry, null, 2)}\n`, 'utf8');
          if (out.json) {
            out.log({ entry: packed.entry, files: packed.files, path: outPath });
            return;
          }
          out.log(`Packed ${packed.entry.name}@${packed.entry.version} (${packed.files.length} files)`);
          out.log(`Entry written to ${outPath}`);
          return;
        }
        out.log(packed.entry);
      } catch (error) {
        throw presentRegistryError(error, registry);
      }
    });

  module
    .command('publish <dir>')
    .description(
      'Pack a module, verify it, and append it to a local registry index (verified before writing).',
    )
    .requiredOption(
      '--registry <source>',
      'local registry directory or index file (remote indexes are read-only)',
    )
    .option('--index <file>', 'index file to write (default: <registry>/registry.json)')
    .option('--dry-run', 'validate and show what would be written, without writing')
    .option('--replace', 'replace an existing (name, version) entry and payload')
    .option('--sign-key <pem>', 'sign with a PEM Ed25519 private key (requires --publisher)')
    .option('--publisher <id>', 'publisher id recorded in the entry (requires --sign-key)')
    .option('--status <status>', 'conformance status L0..L5 or UNVERIFIED (default UNVERIFIED)')
    .option('--url <url>', 'payload location recorded in the entry (skips the local payload copy)')
    .option('--target <target>', 'target label (repeatable; default: manifest runtime)', collect)
    .action(async (dir: string, options: RegistryPublishFlags) => {
      const out = outputFor();
      const registry = await importRegistry();
      try {
        const prepared = preparePack(registry, options);
        const packed = await packAndVerify(registry, dir, prepared);
        const location = registry.resolveIndexLocation(options.registry, process.cwd());
        const indexPath = options.index
          ? resolve(options.index)
          : location.kind === 'local'
            ? location.path
            : null;
        if (indexPath === null) {
          throw new registry.RegistryError(
            'REGISTRY_READ_ONLY',
            `Publishing to remote registry '${options.registry}' is not supported in v0; use a local index file.`,
          );
        }
        const existing = existsSync(indexPath)
          ? registry.parseRegistryIndexText(readFileSync(indexPath, 'utf8'), indexPath)
          : registry.emptyRegistryIndex();
        if (registry.containsEntry(existing, packed.entry) && options.replace !== true) {
          throw new registry.RegistryError(
            'MODULE_ALREADY_PUBLISHED',
            `Registry '${indexPath}' already contains '${packed.entry.name}@${packed.entry.version}'. Pass --replace to overwrite it.`,
          );
        }
        const nextIndex = options.replace
          ? registry.upsertEntry(existing, packed.entry)
          : registry.appendEntry(existing, packed.entry);
        const payloadDir =
          options.url === undefined ? join(dirname(indexPath), packed.entry.url) : null;

        if (options.dryRun === true) {
          if (out.json) {
            out.log({
              dryRun: true,
              index: indexPath,
              entry: packed.entry,
              files: packed.files.length,
              payloadDirectory: payloadDir,
            });
            return;
          }
          out.log('DRY RUN — nothing was written.');
          out.log(`Index:   ${indexPath} (${nextIndex.modules.length} entries after append)`);
          out.log(
            payloadDir === null
              ? 'Payload: no copy (--url provided; the publisher hosts the payload)'
              : `Payload: ${payloadDir}`,
          );
          out.log(JSON.stringify(packed.entry, null, 2));
          return;
        }

        if (payloadDir !== null) {
          if (existsSync(payloadDir)) {
            if (options.replace !== true) {
              throw new registry.RegistryError(
                'MODULE_ALREADY_PRESENT',
                `Payload directory '${payloadDir}' already exists. Pass --replace to overwrite it.`,
              );
            }
            rmSync(payloadDir, { recursive: true, force: true });
          }
          registry.copyModuleDirectory(resolve(dir), payloadDir);
        }
        mkdirSync(dirname(indexPath), { recursive: true });
        writeFileSync(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, 'utf8');
        if (out.json) {
          out.log({
            index: indexPath,
            entry: packed.entry,
            files: packed.files.length,
            payloadDirectory: payloadDir,
          });
          return;
        }
        out.log(`Published ${packed.entry.name}@${packed.entry.version} → ${indexPath}`);
        if (payloadDir !== null) {
          out.log(`Payload copied to ${payloadDir}`);
        } else {
          out.log('Payload not copied (--url provided).');
        }
      } catch (error) {
        throw presentRegistryError(error, registry);
      }
    });

  module
    .command('search <query>')
    .description('Search modules in a registry index (offline-first: local paths are primary).')
    .requiredOption('--registry <source>', 'registry directory, index file, or https URL')
    .action(async (query: string, options: { registry: string }) => {
      const out = outputFor();
      const registry = await importRegistry();
      try {
        const client = new registry.RegistryClient({ source: options.registry });
        const matches = await client.search(query);
        if (out.json) {
          out.log({ registry: options.registry, query, modules: matches });
          return;
        }
        if (matches.length === 0) {
          out.log(`No modules match '${query}' in '${options.registry}'.`);
          return;
        }
        out.log(`${'MODULE'.padEnd(28)} ${'VERSION'.padEnd(10)} STATUS      TARGETS`);
        for (const entry of matches) {
          out.log(
            `${entry.name.padEnd(28)} ${entry.version.padEnd(10)} ${entry.status.padEnd(11)} ${entry.targets.join(', ')}`,
          );
        }
      } catch (error) {
        throw presentRegistryError(error, registry);
      }
    });

  module
    .command('info <target>')
    .description('Show a registry entry: name[@version or range], hashes, publisher, status.')
    .requiredOption('--registry <source>', 'registry directory, index file, or https URL')
    .action(async (target: string, options: { registry: string }) => {
      const out = outputFor();
      const registry = await importRegistry();
      try {
        const client = new registry.RegistryClient({ source: options.registry });
        const parsed = registry.parseInstallTarget(target);
        const entry = await client.resolve(parsed.name, parsed.range);
        if (out.json) {
          out.log(entry);
          return;
        }
        out.log(`MODULE:      ${entry.name}@${entry.version}`);
        out.log(`DESCRIPTION: ${entry.description}`);
        out.log(`STATUS:      ${entry.status}`);
        out.log(`TARGETS:     ${entry.targets.join(', ')}`);
        out.log(`PUBLISHER:   ${entry.publisher ?? '(none — unsigned entry)'}`);
        out.log(
          `SIGNATURE:   ${entry.signature === undefined ? 'absent' : 'present (verify with --allow-publisher)'}`,
        );
        out.log(`MANIFEST:    ${entry.manifestHash}`);
        out.log(`CONTENT:     ${entry.contentHash}`);
        out.log(`URL:         ${entry.url}`);
        out.log(`PUBLISHED:   ${entry.publishedAt}`);
      } catch (error) {
        throw presentRegistryError(error, registry);
      }
    });

  module
    .command('conformance <dir>')
    .description('Emit the machine-readable L0–L5 conformance report for a module directory.')
    .option('--json <file>', 'write the machine-readable report to a file')
    .option('--simulation-verified', 'record simulation evidence (L3)')
    .option('--integration-verified', 'record daemon/module-host integration evidence (L4)')
    .option('--hardware-record <file>', 'dated hardware test record JSON (L5)')
    .action(async (dir: string, options: RegistryConformanceFlags) => {
      const out = outputFor();
      const registry = await importRegistry();
      try {
        const conformanceOptions: NonNullable<
          Parameters<typeof registry.evaluateModuleConformance>[1]
        > = {};
        if (options.simulationVerified === true) conformanceOptions.simulationVerified = true;
        if (options.integrationVerified === true) conformanceOptions.integrationVerified = true;
        if (options.hardwareRecord) {
          const recordPath = resolve(options.hardwareRecord);
          let raw: unknown;
          try {
            raw = JSON.parse(readFileSync(recordPath, 'utf8'));
          } catch (error) {
            throw new registry.RegistryError(
              'CONFORMANCE_FAILED',
              `Hardware record '${recordPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          conformanceOptions.hardwareRecord = registry.validateHardwareVerificationRecord(
            raw,
            recordPath,
          );
        }
        const report = await registry.evaluateModuleConformance(dir, conformanceOptions);
        if (options.json) {
          const reportPath = resolve(options.json);
          mkdirSync(dirname(reportPath), { recursive: true });
          writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
          if (!out.json) {
            out.log(`Report written to ${reportPath}`);
          }
        }
        if (out.json) {
          out.log(report);
        } else {
          for (const line of registry.formatModuleConformanceReport(report).split('\n')) {
            out.log(line);
          }
        }
        if (!report.passed) {
          throw new Error(
            `[CONFORMANCE_FAILED] ${report.moduleId ?? dir} did not reach L2 (${report.level ?? 'below L0'}).`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('[CONFORMANCE_FAILED]')) {
          throw error;
        }
        throw presentRegistryError(error, registry);
      }
    });
}

/** `module install <name[@version]> --registry ...` (added to the legacy command). */
export async function runRegistryInstallCommand(
  target: string,
  options: RegistryInstallFlags,
  output: CliOutput,
): Promise<void> {
  const registry = await importRegistry();
  try {
    const client = new registry.RegistryClient({ source: options.registry });
    const allowlist = readPublisherKeys(options.allowPublisher);
    const outDir = options.out
      ? resolve(options.out)
      : join(resolvePinoutHome(), 'registry-modules');
    const result = await registry.installModule(client, target, {
      outDir,
      force: options.force === true,
      requireSignature: options.requireSignature === true,
      ...(allowlist.length > 0 ? { allowlist } : {}),
    });
    if (output.json) {
      output.log({
        path: result.path,
        entry: result.entry,
        verification: result.verification,
        files: result.files,
      });
      return;
    }
    output.log(`Installed ${result.entry.name}@${result.entry.version} → ${result.path}`);
    output.log(
      `Verification: hashes ${result.verification.hashes.content.status}; signature ${result.verification.signature.status}${
        result.entry.publisher ? ` (publisher ${result.entry.publisher})` : ''
      }`,
    );
    output.log(
      `NOTE: vendored copy only — register it with the runtime via: pinout module install ${result.path}`,
    );
  } catch (error) {
    throw presentRegistryError(error, registry);
  }
}

/** `module verify <dir> --registry ...` (added to the legacy command). */
export async function runRegistryVerifyCommand(
  directory: string,
  options: RegistryVerifyFlags,
  output: CliOutput,
): Promise<void> {
  const registry = await importRegistry();
  try {
    const moduleDir = resolve(directory);
    const manifestDefaults = readManifestIdentity(moduleDir);
    const name = options.name ?? manifestDefaults?.id;
    if (!name) {
      throw new registry.RegistryError(
        'MODULE_SOURCE_INVALID',
        `Cannot determine the module id: pass --name or provide a readable pinout.module.json in '${moduleDir}'.`,
      );
    }
    const version = options.version ?? manifestDefaults?.version;
    const client = new registry.RegistryClient({ source: options.registry });
    const entry = await client.resolve(name, version ?? '*');
    const allowlist = readPublisherKeys(options.allowPublisher);
    for (const pair of options.publisher ?? []) {
      const separator = pair.indexOf('=');
      if (separator === -1) {
        throw new registry.RegistryError(
          'MODULE_SOURCE_INVALID',
          `Invalid --publisher entry '${pair}'. Expected id=path/to/public.pem.`,
        );
      }
      allowlist.push({
        publisher: pair.slice(0, separator),
        pem: readPemFile(pair.slice(separator + 1)),
      });
    }
    const verification = registry.verifyEntry(moduleDir, entry, {
      requireSignature: options.requireSignature === true,
      ...(allowlist.length > 0 ? { allowlist } : {}),
    });
    if (output.json) {
      output.log(verification);
    } else {
      output.log(
        `REGISTRY VERIFICATION: ${verification.ok ? 'OK' : 'FAILED'} for ${entry.name}@${entry.version}`,
      );
      output.log(
        `HASHES: manifest ${verification.hashes.manifest.status}, content ${verification.hashes.content.status}`,
      );
      output.log(
        `SIGNATURE: ${verification.signature.status}${
          verification.signature.publisher ? ` (publisher ${verification.signature.publisher})` : ''
        }`,
      );
      output.log(`  ${verification.signature.reason}`);
      for (const failure of verification.failures) {
        output.log(`  [${failure.code}] ${failure.message}`);
      }
    }
    registry.throwIfVerificationFailed(verification);
  } catch (error) {
    throw presentRegistryError(error, registry);
  }
}

interface PreparedPack {
  packOptions: Registry.PackModuleOptions;
  publisherKeyPem: string | null;
}

function preparePack(
  registry: typeof Registry,
  options: Pick<RegistryPackFlags, 'signKey' | 'publisher' | 'status' | 'url' | 'target'>,
): PreparedPack {
  const packOptions: Registry.PackModuleOptions = {};
  let publisherKeyPem: string | null = null;
  if (options.signKey !== undefined) {
    if (options.publisher === undefined) {
      throw new Error('--sign-key requires --publisher <id> so the entry says who signed it.');
    }
    const pem = readPemFile(options.signKey);
    publisherKeyPem = registry.publicKeyPemFromPrivate(pem);
    packOptions.signer = registry.createPayloadSigner(pem);
    packOptions.publisher = options.publisher;
  } else if (options.publisher !== undefined) {
    throw new Error(
      '--publisher requires --sign-key <pem>; the registry never signs with a stored key.',
    );
  }
  if (options.status !== undefined) {
    packOptions.status = options.status as Registry.RegistryModuleStatus;
  }
  if (options.url !== undefined) packOptions.url = options.url;
  if (options.target !== undefined && options.target.length > 0) {
    packOptions.targets = options.target;
  }
  return { packOptions, publisherKeyPem };
}

async function packAndVerify(
  registry: typeof Registry,
  dir: string,
  prepared: PreparedPack,
): Promise<{ entry: Registry.RegistryModuleEntry; files: string[] }> {
  const packed = await registry.packModule(dir, prepared.packOptions);
  const verification = registry.verifyEntry(resolve(dir), packed.entry, {
    requireSignature: prepared.publisherKeyPem !== null,
    ...(prepared.publisherKeyPem !== null ? { publisherKey: prepared.publisherKeyPem } : {}),
  });
  registry.throwIfVerificationFailed(verification);
  return packed;
}

function readPublisherKeys(specs: string[] | undefined): Registry.TrustedPublisherKey[] {
  const keys: Registry.TrustedPublisherKey[] = [];
  for (const spec of specs ?? []) {
    const separator = spec.indexOf('=');
    if (separator > 0) {
      const candidate = spec.slice(0, separator);
      // Same pattern as `PUBLISHER_ID_PATTERN` in @pinout/registry; kept inline so
      // this file only needs a type-level import until the module loads.
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate)) {
        keys.push({ publisher: candidate, pem: readPemFile(spec.slice(separator + 1)) });
        continue;
      }
    }
    keys.push({ pem: readPemFile(spec) });
  }
  return keys;
}

function readPemFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read publisher key '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readManifestIdentity(directory: string): { id: string; version: string } | null {
  const manifestPath = join(directory, 'pinout.module.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      id?: unknown;
      version?: unknown;
    };
    if (typeof raw.id === 'string' && typeof raw.version === 'string') {
      return { id: raw.id, version: raw.version };
    }
    return null;
  } catch {
    return null;
  }
}

/** Print `[CODE] message` for structured registry errors, then rethrow. */
function presentRegistryError(error: unknown, registry: typeof Registry): Error {
  if (error instanceof registry.RegistryError) {
    return new Error(`[${error.code}] ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function importRegistry(): Promise<typeof Registry> {
  try {
    return await import('@pinout/registry');
  } catch (error) {
    throw new Error(
      `The CLI could not load @pinout/registry. It ships with this repository; install workspace dependencies first. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
