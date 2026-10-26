import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { loadDatasheet } from '../devices/profiles.js';
import type { BenchDevice } from '../devices/benchDevice.js';
import type { AgentTool } from '../types.js';

/**
 * Arm A: no Pinout. The agent gets a shell-like workspace, a datasheet-style
 * board description (pinout + JSON-line serial protocol), and must write a
 * firmware sketch then compile/flash-equivalent it onto the shared simulator.
 *
 * Tool names and descriptions intentionally avoid Pinout branding.
 */
export function createRawArmTools(bench: BenchDevice, workspaceDir: string): AgentTool[] {
  mkdirSync(workspaceDir, { recursive: true });
  const datasheet = loadDatasheet(bench.profile.id);
  writeFileSync(join(workspaceDir, 'DATASHEET.md'), datasheet, 'utf8');
  writeFileSync(
    join(workspaceDir, 'README_AGENT.txt'),
    [
      'SIMULATED device sandbox (not physical hardware).',
      'Write a firmware sketch as firmware.json (see DATASHEET.md).',
      'Then call compile_flash with path firmware.json.',
      'Optional: serial_request to send live JSON-line bridge commands after arming.',
      'Do not claim success without actually flashing and observing device behaviour.',
      '',
    ].join('\n'),
    'utf8',
  );

  let flashCount = 0;

  const tools: AgentTool[] = [
    {
      name: 'list_workspace',
      description: 'List files in the agent workspace directory.',
      inputSchema: {
        type: 'object',
        properties: {
          relativePath: { type: 'string', description: 'Optional subdirectory.' },
        },
      },
      async invoke(args) {
        const relativePath = typeof args.relativePath === 'string' ? args.relativePath : '.';
        const target = safeResolve(workspaceDir, relativePath);
        const entries = readdirSync(target).map((name) => {
          const full = join(target, name);
          const stats = statSync(full);
          return { name, type: stats.isDirectory() ? 'dir' : 'file', size: stats.size };
        });
        return ok({ entries, evidence: 'SIMULATED' });
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the workspace (datasheet, sketches, logs).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to workspace.' },
        },
        required: ['path'],
      },
      async invoke(args) {
        const path = requireString(args.path, 'path');
        const full = safeResolve(workspaceDir, path);
        const content = readFileSync(full, 'utf8');
        return ok({ path, content, evidence: 'SIMULATED' });
      },
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file into the workspace (firmware sketch, notes).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      async invoke(args) {
        const path = requireString(args.path, 'path');
        const content = requireString(args.content, 'content');
        const full = safeResolve(workspaceDir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
        return ok({ path, bytes: content.length, evidence: 'SIMULATED' });
      },
    },
    {
      name: 'compile_flash',
      description:
        'Compile and flash-equivalent a firmware.json sketch onto the SIMULATED board. The sketch is a JSON object with steps: [{action, payload}, ...]. See DATASHEET.md.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to firmware.json' },
        },
        required: ['path'],
      },
      async invoke(args) {
        const path = requireString(args.path, 'path');
        const full = safeResolve(workspaceDir, path);
        const raw = readFileSync(full, 'utf8');
        let sketch: unknown;
        try {
          sketch = JSON.parse(raw);
        } catch {
          return fail('firmware.json is not valid JSON.');
        }
        const steps = normalizeSketch(sketch);
        const results: Array<Record<string, unknown>> = [];
        for (const step of steps) {
          try {
            const result = bench.applyAction(step.action, step.payload);
            results.push({ action: step.action, ok: true, result });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ action: step.action, ok: false, error: message });
            return fail(`Flash step failed at ${step.action}: ${message}`, { results });
          }
        }
        flashCount += 1;
        writeFileSync(
          join(workspaceDir, 'last_flash_log.json'),
          JSON.stringify({ evidence: 'SIMULATED', flashCount, results }, null, 2),
          'utf8',
        );
        return ok({
          flashed: true,
          flashCount,
          steps: results.length,
          evidence: 'SIMULATED',
          results,
        });
      },
    },
    {
      name: 'serial_request',
      description:
        'Send one JSON-line bridge request to the SIMULATED board after firmware is present. Payload follows DATASHEET.md (action + payload object).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          payload: { type: 'object' },
        },
        required: ['action'],
      },
      async invoke(args) {
        const action = requireString(args.action, 'action');
        const payload =
          args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
            ? (args.payload as Record<string, unknown>)
            : {};
        try {
          const result = bench.applyAction(action, payload);
          return ok({ action, result, evidence: 'SIMULATED' });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'read_flash_log',
      description: 'Read the last compile_flash log if present.',
      inputSchema: { type: 'object', properties: {} },
      async invoke() {
        const logPath = join(workspaceDir, 'last_flash_log.json');
        try {
          const content = readFileSync(logPath, 'utf8');
          return ok({ content, evidence: 'SIMULATED' });
        } catch {
          return fail('No flash log yet. Call compile_flash first.');
        }
      },
    },
  ];

  return tools;
}

function normalizeSketch(sketch: unknown): Array<{ action: string; payload: Record<string, unknown> }> {
  if (Array.isArray(sketch)) {
    return sketch.map((step, index) => normalizeStep(step, index));
  }
  if (sketch && typeof sketch === 'object' && Array.isArray((sketch as { steps?: unknown }).steps)) {
    return ((sketch as { steps: unknown[] }).steps).map((step, index) => normalizeStep(step, index));
  }
  throw new Error('firmware.json must be an array of steps or { steps: [...] }.');
}

function normalizeStep(
  step: unknown,
  index: number,
): { action: string; payload: Record<string, unknown> } {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`steps[${index}] must be an object.`);
  }
  const record = step as Record<string, unknown>;
  if (typeof record.action !== 'string') {
    throw new Error(`steps[${index}].action must be a string.`);
  }
  const payload =
    record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  return { action: record.action, payload };
}

function safeResolve(root: string, relativePath: string): string {
  const full = resolve(root, relativePath);
  if (full !== root && !full.startsWith(`${root}/`)) {
    throw new Error('Path escapes the workspace.');
  }
  return full;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function ok(structured: Record<string, unknown>) {
  return { ok: true, content: JSON.stringify(structured), structured };
}

function fail(message: string, structured: Record<string, unknown> = {}) {
  return {
    ok: false,
    content: JSON.stringify({ ok: false, error: message, evidence: 'SIMULATED', ...structured }),
    structured: { ok: false, error: message, evidence: 'SIMULATED', ...structured },
  };
}
