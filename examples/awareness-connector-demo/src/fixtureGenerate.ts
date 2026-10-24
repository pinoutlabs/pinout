/**
 * Demo generateConnectorFn: map awareness ids → PR3 fixtures via connector-evidence.json,
 * then call the real daemon generateConnector adapter (GATT/MQTT → module on disk).
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateConnector,
  type GenerateConnectorFn,
  type GenerateConnectorInput,
  type GenerateConnectorResult,
} from '@pinout/daemon';
import type { ConnectorEvidenceFile } from './types.js';

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(demoRoot, '../..');

export async function loadConnectorEvidence(path: string): Promise<ConnectorEvidenceFile> {
  return JSON.parse(await readFile(path, 'utf8')) as ConnectorEvidenceFile;
}

export function createFixtureGenerateConnectorFn(
  evidence: ConnectorEvidenceFile,
): GenerateConnectorFn {
  return async (input: GenerateConnectorInput): Promise<GenerateConnectorResult> => {
    const awarenessId = input.awarenessId;
    const entry = awarenessId ? evidence.byAwarenessId[awarenessId] : undefined;
    if (!entry) {
      return generateConnector(input);
    }
    if (!input.outDir) {
      throw new Error('fixture generateConnectorFn requires outDir');
    }
    const raw = JSON.parse(await readFile(resolve(repoRoot, entry.fixturePath), 'utf8')) as unknown;
    return generateConnector({
      source: entry.source === 'auto' ? 'auto' : entry.source,
      raw,
      outDir: input.outDir,
      overwrite: input.overwrite ?? true,
      ...(awarenessId !== undefined ? { awarenessId } : {}),
    });
  };
}
