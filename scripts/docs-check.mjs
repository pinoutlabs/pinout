#!/usr/bin/env node

/** Small, network-free documentation gate for the alpha release. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const required = [
  'docs/index.md',
  'docs/hardware-support.md',
  'docs/esp32-mqtt.md',
  'docs/releasing.md',
  'docs/safety-model.md',
  'docs/security-model.md',
  'docs/troubleshooting.md',
  'docs/mcp.md',
  'docs/mcp-awareness.md',
  'docs/awareness-and-connectors.md',
  'docs/coffee-machine.md',
  'docs/maintainers.md',
  'docs/adr/0001-governed-runtime.md',
  'docs/adr/0002-control-plane-topology.md',
  'docs/adr/0003-serial-reset-and-handshake.md',
  'docs/adr/0004-versioning-reset.md',
  'docs/adr/0005-python-package-name.md',
];
const missing = required.filter((path) => !existsSync(resolve(root, path)));
if (missing.length) {
  console.error(`docs-check: missing required files:\n${missing.join('\n')}`);
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(resolve(root, 'hardware/catalog.json'), 'utf8'));
if (!Array.isArray(catalog.entries) || !Array.isArray(catalog.statuses)) {
  throw new Error('docs-check: hardware/catalog.json has no entries/statuses arrays');
}
for (const entry of catalog.entries) {
  if (!entry.target || !catalog.statuses.includes(entry.status) || !entry.testedHow) {
    throw new Error(`docs-check: malformed hardware catalog entry: ${JSON.stringify(entry)}`);
  }
}
console.log(
  `docs-check passed (${required.length} required docs; ${catalog.entries.length} catalog entries).`,
);
