import { setTimeout } from 'node:timers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
if (!argv.includes('--yes') || !argv.includes('--device') || !argv.includes('--pin')) {
  throw Error(
    'Usage: npm run hardware:smoke -- --device <discovered-id> --pin <number|A1> --yes. Runs an active-high external LED on/off test; use a series resistor.',
  );
}
const deviceId = option('--device');
const client = new Client({ name: 'pinout-hardware-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../packages/mcp/dist/index.js', import.meta.url))],
  stderr: 'inherit',
  env: { ...process.env, PINOUT_OWNER: 'hardware-smoke' },
});
let leaseId;
let armed = false;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Error(JSON.stringify(result));
  return result.structuredContent;
}
const invoke = (capability, args) => call('pinout__invoke', { deviceId, capability, args });
try {
  await client.connect(transport);
  const info = await call('pinout__describe_device', { deviceId });
  const board = info.operationalState?.board;
  if (!board) throw Error('Device has no supported board identity.');
  const label = option('--pin');
  const pin =
    board.boardId === 'arduino-uno' && /^A[0-5]$/i.test(label)
      ? 14 + Number(label.slice(1))
      : Number(label);
  if (!Number.isInteger(pin) || !board.gpioPins.includes(pin) || board.inputOnlyPins?.includes(pin))
    throw Error('Pin is not a usable output on this board.');
  leaseId = (await call('pinout__acquire_lease', { deviceId, ttlMs: 30000 })).lease.id;
  await invoke('gpio.configSafeState', { pin, safeLevel: 'low', polarity: 'active-high' });
  await invoke('sys.arm', { timeoutMs: 1000 });
  armed = true;
  const on = await invoke('gpio.write', { pin, value: true });
  const readOn = await invoke('gpio.read', { pin });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const off = await invoke('gpio.write', { pin, value: false });
  const readOff = await invoke('gpio.read', { pin });
  if (readOn.result?.value !== true || readOff.result?.value !== false)
    throw Error('GPIO readback did not match commanded levels.');
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        deviceId,
        boardId: board.boardId,
        pin,
        on,
        readOn,
        off,
        readOff,
        physicalObservation: 'PENDING: operator must confirm LED visibly on then off.',
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (armed) await invoke('sys.disarm', {});
  } finally {
    try {
      if (leaseId) await call('pinout__release_lease', { leaseId });
    } finally {
      await client.close();
    }
  }
}
