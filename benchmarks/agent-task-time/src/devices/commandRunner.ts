import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult>;
  which(command: string): Promise<string | undefined>;
}

export function createProcessCommandRunner(): CommandRunner {
  return {
    async run(command, args, options = {}) {
      const started = performance.now();
      try {
        const result = await execFileAsync(command, args, {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 120_000,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
          durationMs: performance.now() - started,
        };
      } catch (error) {
        const err = error as {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          message?: string;
        };
        return {
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? err.message ?? String(error),
          exitCode: typeof err.code === 'number' ? err.code : 1,
          durationMs: performance.now() - started,
        };
      }
    },
    async which(command) {
      const result = await this.run(process.platform === 'win32' ? 'where' : 'which', [command], {
        timeoutMs: 5000,
      });
      if (result.exitCode !== 0) return undefined;
      const first = result.stdout.trim().split(/\r?\n/)[0];
      return first || undefined;
    },
  };
}

/** In-memory fake for unit tests. */
export function createFakeCommandRunner(options: {
  binaries?: Record<string, string>;
  handlers?: Record<string, (args: string[]) => CommandResult | Promise<CommandResult>>;
}): CommandRunner {
  const binaries = options.binaries ?? {};
  const handlers = options.handlers ?? {};
  return {
    async which(command) {
      return binaries[command];
    },
    async run(command, args) {
      const key = `${command} ${args.join(' ')}`.trim();
      const handler =
        handlers[key] ??
        handlers[command] ??
        (() => ({
          stdout: '',
          stderr: `fake: unhandled ${command}`,
          exitCode: 1,
          durationMs: 1,
        }));
      return handler(args);
    },
  };
}
