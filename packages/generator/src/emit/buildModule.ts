import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findMonorepoRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: string[] };
        if (pkg.workspaces?.length) {
          return current;
        }
      } catch {
        // continue searching
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function buildCandidateModule(outputPath: string): void {
  const root = resolve(outputPath);
  const monorepoRoot =
    findMonorepoRoot(process.cwd()) ??
    findMonorepoRoot(dirname(fileURLToPath(import.meta.url))) ??
    findMonorepoRoot(root);

  if (!monorepoRoot) {
    throw new Error(
      'Cannot build generated module: Pinout monorepo root not found. Run generate from the Pinout repository or install dependencies manually.',
    );
  }

  const packageJsonPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = {
    ...pkg.dependencies,
    '@pinout/core': `file:${join(monorepoRoot, 'packages/core')}`,
  };
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  execFileSync('npm', ['install', '--ignore-scripts', '--no-package-lock'], {
    cwd: root,
    stdio: 'pipe',
    // Windows installs npm as a .cmd shim, which requires the command shell.
    // The command and arguments are fixed; the output directory stays in cwd.
    shell: process.platform === 'win32',
  });
  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
