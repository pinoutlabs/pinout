/**
 * Module integrity + inspection CLI commands (spec v1).
 *
 * `pinout module inspect <dir>` — manifest, permissions audit, capability list.
 * `pinout module verify <dir>` — integrity status: UNSIGNED / SIGNED / VERIFIED
 * / INVALID_SIGNATURE. Unsigned development modules work; they are never
 * displayed as verified.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type * as ModuleHost from '@pinout/module-host';

export interface IntegrityOutput {
  json: boolean;
  log: (value: unknown) => void;
  error: (message: string) => void;
}

/** Attach `module inspect` / `module verify` to the EXISTING `module` command. */
export function registerModuleIntegrityCommands(
  existingModuleCommand: Command,
  outputFor: () => IntegrityOutput,
): void {
  const module = existingModuleCommand;

  module
    .command('integrity <dir>')
    .description('Audit a module directory: manifest, permissions advisory, capabilities.')
    .action(async (dir: string) => {
      const out = outputFor();
      const { auditPermissions } = await importModuleHost();
      const moduleDir = resolve(dir);
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(
          readFileSync(join(moduleDir, 'pinout.module.json'), 'utf8'),
        ) as Record<string, unknown>;
      } catch (error) {
        out.error(
          `Cannot read pinout.module.json in '${moduleDir}': ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
      }
      const findings = auditPermissions(manifest);
      if (out.json) {
        out.log({ manifest, permissionsAudit: findings });
        return;
      }
      out.log(`MODULE: ${String(manifest.id ?? '(no id)')} v${String(manifest.version ?? '?')}`);
      out.log(
        `RUNTIME: ${String(manifest.runtime ?? '?')}  DEVICE CLASS: ${String(manifest.deviceClass ?? '?')}`,
      );
      out.log('PERMISSIONS AUDIT (advisory — declared metadata, not OS enforcement):');
      for (const finding of findings) {
        out.log(`  [${finding.severity}] ${finding.permission}: ${finding.message}`);
      }
    });

  module
    .command('verify <dir>')
    .description(
      'Verify module integrity: hashes and Ed25519 signature against trusted publishers. With --registry: verify the directory against a registry index entry.',
    )
    .option(
      '--publisher <pairs>',
      'trusted publishers as id=path/to/public.pem (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--registry <source>', 'registry directory, index file, or https URL')
    .option('--name <moduleId>', 'registry entry name (default: manifest id)')
    .option('--version <version>', 'registry entry version or range (default: manifest version)')
    .option('--require-signature', 'fail when the entry is unsigned or untrusted')
    .option(
      '--allow-publisher <spec>',
      'trusted publisher key for registry verification: id=path/to/public.pem or path/to/public.pem (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(
      async (
        dir: string,
        options: {
          publisher?: string[];
          registry?: string;
          name?: string;
          version?: string;
          requireSignature?: boolean;
          allowPublisher?: string[];
        },
      ) => {
        const out = outputFor();
        if (options.registry !== undefined) {
          const { runRegistryVerifyCommand } = await import('./registryCommands.js');
          await runRegistryVerifyCommand(
            dir,
            {
              registry: options.registry,
              ...(options.name !== undefined ? { name: options.name } : {}),
              ...(options.version !== undefined ? { version: options.version } : {}),
              ...(options.requireSignature === true ? { requireSignature: true } : {}),
              ...(options.allowPublisher !== undefined
                ? { allowPublisher: options.allowPublisher }
                : {}),
              ...(options.publisher !== undefined ? { publisher: options.publisher } : {}),
            },
            out,
          );
          return;
        }
        const { verifyModule } = await importModuleHost();
        const moduleDir = resolve(dir);
        const trusted: Record<string, string> = {};
        for (const pair of options.publisher ?? []) {
          const separator = pair.indexOf('=');
          if (separator === -1) {
            out.error(`Invalid --publisher entry '${pair}'. Expected id=path/to/public.pem.`);
            process.exitCode = 1;
            return;
          }
          trusted[pair.slice(0, separator)] = readFileSync(pair.slice(separator + 1), 'utf8');
        }
        const report = verifyModule(moduleDir, trusted);
        if (out.json) {
          out.log(report);
        } else {
          out.log(`INTEGRITY: ${report.status}`);
          if (report.publisher) out.log(`PUBLISHER: ${report.publisher}`);
          if (report.manifestHash) out.log(`MANIFEST HASH: ${report.manifestHash}`);
          if (report.contentHash) out.log(`CONTENT HASH: ${report.contentHash}`);
          for (const reason of report.reasons) {
            out.log(`  ${reason}`);
          }
          if (report.status === 'UNSIGNED') {
            out.log('  Unsigned modules run in development but are never displayed as verified.');
          }
        }
        if (report.status === 'INVALID_SIGNATURE') {
          throw new Error(`Module integrity verification FAILED (${report.status}).`);
        }
      },
    );
}

async function importModuleHost(): Promise<typeof ModuleHost> {
  try {
    return await import('@pinout/module-host');
  } catch (error) {
    throw new Error(
      `The alpha CLI does not bundle the experimental module host. Install @pinout/module-host from this repository to use integrity commands. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
