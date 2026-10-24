/**
 * Demo-local types for the awareness → connector e2e (PR4 daemon routes).
 * Awareness records come from `@pinout/awareness`. Evidence uses core SupportLevel.
 */
import { capSupportLevel, compareSupportLevels, type SupportLevel } from '@pinout/core';
import type { ConnectorSourceKind } from '@pinout/generator';

export type { SupportLevel };

export interface ParamRange {
  min: number;
  max: number;
}

export interface InvokeResult {
  ok: boolean;
  code?: string;
  message?: string;
  result?: Record<string, unknown>;
}

export interface ConnectorEvidenceEntry {
  source: ConnectorSourceKind | 'auto' | 'gatt' | 'mqtt' | 'sys.hello' | 'mdns' | 'openapi';
  fixturePath: string;
}

export interface ConnectorEvidenceFile {
  byAwarenessId: Record<string, ConnectorEvidenceEntry>;
}

export function capEvidenceLevel(
  level: SupportLevel,
  max: SupportLevel = 'COMPILE_TESTED',
): SupportLevel {
  return capSupportLevel(level, max);
}

export function evidenceExceeds(level: SupportLevel, max: SupportLevel): boolean {
  return compareSupportLevels(level, max) > 0;
}
