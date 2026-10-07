import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PinoutRuntime, relayModule } from '@pinout/core';
import { startDaemon } from '../src/start.js';

const execFileAsync = promisify(execFile);

describe('Python client to real pinoutd contract', () => {
  it('acquires a lease, previews, invokes, and releases through HTTP', async () => {
    const runtime = new PinoutRuntime();
    await runtime.registerFromModule(relayModule.id, { id: 'relay-python', simulated: true });
    const daemon = await startDaemon(runtime, { port: 0, token: 'python-contract-token' });
    try {
      const script = resolve('sdk/python/tests/real_daemon_smoke.py');
      const pythonPath = resolve('sdk/python/src');
      const { stderr } = await execFileAsync('python3', [script], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          PYTHONPATH: pythonPath,
          PINOUT_TEST_URL: `http://127.0.0.1:${daemon.port}`,
          PINOUT_TEST_TOKEN: 'python-contract-token',
        },
        // Cold python + loaded Windows runners can stall; real failures exit fast.
        timeout: 60_000,
      });
      expect(stderr).toBe('');
    } finally {
      await daemon.close();
    }
  }, 90_000);
});
