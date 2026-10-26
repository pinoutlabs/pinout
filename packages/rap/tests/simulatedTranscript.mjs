#!/usr/bin/env node
/**
 * Honest SIMULATED transcript: pinoutd --demo + pinout-rap + mock RAP callback runtime.
 * No Infinity binary / model credentials required. No hardware.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const home = mkdtempSync(join(tmpdir(), 'pinout-rap-sim-'));
const lines = [];
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  lines.push(line);
  console.log(line);
};

function readDaemonToken() {
  const path = join(home, 'pinoutd.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed.token !== 'string') throw new Error('pinoutd.json missing token');
  return parsed.token;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHttp(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const callbacks = [];
const callbackServer = createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    callbacks.push(body);
    log(`CALLBACK ${body.type} id=${body.id ?? '-'} text=${JSON.stringify(String(body.text ?? '').slice(0, 120))}`);
    res.writeHead(200);
    res.end('OK');
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
const cbPort = callbackServer.address().port;
const callbackUrl = `http://127.0.0.1:${cbPort}/callback`;

const daemonPort = 18787;
const rapPort = 18791;

const daemon = spawn(
  process.execPath,
  [
    join(root, 'packages/daemon/dist/main.js'),
    '--demo',
    '--port',
    String(daemonPort),
    '--host',
    '127.0.0.1',
  ],
  {
    env: { ...process.env, PINOUT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
daemon.stderr.on('data', (d) => log(`daemon: ${String(d).trim()}`));
daemon.stdout.on('data', (d) => log(`daemon: ${String(d).trim()}`));

await waitHttp(`http://127.0.0.1:${daemonPort}/v1/health`);
const daemonToken = readDaemonToken();
log(`pinoutd ready (SIMULATED demo devices) tokenBytes=${daemonToken.length}`);

const rap = spawn(process.execPath, [join(root, 'packages/rap/dist/main.js')], {
  env: {
    ...process.env,
    PINOUT_HOME: home,
    PINOUT_DAEMON_URL: `http://127.0.0.1:${daemonPort}`,
    PINOUT_TOKEN: daemonToken,
    PINOUT_RAP_TOKEN: daemonToken,
    PINOUT_RAP_HOST: '127.0.0.1',
    PINOUT_RAP_PORT: String(rapPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
rap.stderr.on('data', (d) => log(`rap: ${String(d).trim()}`));
rap.stdout.on('data', (d) => log(`rap: ${String(d).trim()}`));

await waitHttp(`http://127.0.0.1:${rapPort}/health`);
const toolsetRes = await fetch(`http://127.0.0.1:${rapPort}/.well-known/rap-toolset`, {
  headers: { authorization: `Bearer ${daemonToken}` },
});
const toolset = await toolsetRes.json();
log(
  `toolset status=${toolsetRes.status} name=${toolset.name} tools=${toolset.tools.length} endpoint=${toolset.endpoint}`,
);

async function invoke(operation, args, id, groupId) {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${rapPort}/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemonToken}`,
    },
    body: JSON.stringify({
      operation,
      arguments: args,
      id,
      callback_url: callbackUrl,
      group_id: groupId,
    }),
  });
  log(`INVOKE ack status=${res.status} dtMs=${Date.now() - started} op=${operation} id=${id}`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const hit = callbacks.find((c) => c.type === 'tool_result' && c.id === id);
    if (hit) return hit;
    await wait(25);
  }
  throw new Error(`No tool_result for ${id}`);
}

const groupId = 'sim-thread-1';
const list = await invoke('pinout__list_devices', {}, 'call_list', groupId);
log(`list_devices sample=${String(list.text).slice(0, 200)}`);
await invoke('pinout__acquire_lease', { deviceId: 'esp32-01', mode: 'exclusive' }, 'call_lease', groupId);
await invoke(
  'pinout__dry_run',
  { deviceId: 'esp32-01', capability: 'gpio.write', args: { pin: 2, value: true } },
  'call_dry',
  groupId,
);
// Explicit arm is required before physical-output gpio.write on the demo ESP32.
await invoke(
  'pinout__invoke',
  { deviceId: 'esp32-01', capability: 'sys.arm', args: { timeoutMs: 60_000 } },
  'call_arm',
  groupId,
);
await invoke(
  'pinout__invoke',
  { deviceId: 'esp32-01', capability: 'gpio.write', args: { pin: 2, value: true } },
  'call_invoke',
  groupId,
);

const close = await fetch(`http://127.0.0.1:${rapPort}/close_thread`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${daemonToken}`,
  },
  body: JSON.stringify({ thread_id: groupId }),
});
log(`close_thread status=${close.status}`);

const outDir = join(root, 'docs');
const outPath = join(outDir, 'rap-simulated-transcript.md');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  outPath,
  [
    '# RAP adapter SIMULATED transcript',
    '',
    'Evidence: **SIMULATED**. Ran `pinoutd --demo` + `@pinout/rap` against a mock RAP callback runtime in this VM.',
    '',
    '## Why not Infinity?',
    '',
    'This VM has Rust/`cargo` but **not** the Infinity CLI or a configured model provider.',
    'Building `github.com/hydro-project/infinity` end-to-end also needs provider credentials (Bedrock/Anthropic/etc.).',
    'Verification here uses the package mock RAP runtime + this demo transcript instead.',
    '',
    '## Transcript',
    '',
    '```',
    ...lines,
    '```',
    '',
  ].join('\n'),
);
log(`wrote ${outPath}`);

rap.kill('SIGTERM');
daemon.kill('SIGTERM');
callbackServer.close();
await wait(200);
rmSync(home, { recursive: true, force: true });
