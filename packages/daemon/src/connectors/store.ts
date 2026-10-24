import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolvePinoutHome } from '@pinout/core';
import type { ConnectorListItem, ConnectorRecord } from './types.js';

const META_FILENAME = 'connector.json';
const MODULE_DIRNAME = 'module';

export function connectorsRoot(home?: string): string {
  return join(resolvePinoutHome(home), 'connectors');
}

export function connectorDirectory(connectorId: string, home?: string): string {
  return join(connectorsRoot(home), sanitizeConnectorId(connectorId));
}

export function connectorModuleDirectory(connectorId: string, home?: string): string {
  return join(connectorDirectory(connectorId, home), MODULE_DIRNAME);
}

export function ensureConnectorsRoot(home?: string): string {
  const root = connectorsRoot(home);
  mkdirSync(root, { recursive: true });
  return root;
}

export function readConnectorRecord(
  connectorId: string,
  home?: string,
): ConnectorRecord | undefined {
  const metaPath = join(connectorDirectory(connectorId, home), META_FILENAME);
  if (!existsSync(metaPath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(metaPath, 'utf8')) as ConnectorRecord;
}

export function writeConnectorRecord(record: ConnectorRecord, home?: string): void {
  const dir = connectorDirectory(record.id, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, META_FILENAME), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function listConnectorRecords(home?: string): ConnectorListItem[] {
  const root = connectorsRoot(home);
  if (!existsSync(root)) {
    return [];
  }
  const items: ConnectorListItem[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readConnectorRecord(entry.name, home);
    if (!record) continue;
    const item: ConnectorListItem = {
      id: record.id,
      moduleId: record.moduleId,
      status: record.status,
      evidenceLevel: record.evidenceLevel,
      updatedAt: record.updatedAt,
    };
    if (record.awarenessId !== undefined) {
      item.awarenessId = record.awarenessId;
    }
    items.push(item);
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export function deleteConnectorDirectory(connectorId: string, home?: string): void {
  const dir = connectorDirectory(connectorId, home);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sanitizeConnectorId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`Invalid connector id '${id}'.`);
  }
  return id;
}
