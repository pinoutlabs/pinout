import type { CandidateCapability, CandidateSafetyConstraint, HardwareInterfaceIR } from './ir.js';
import type { GeneratorEvidenceLevel } from './supportLevel.js';
import type { GenerationProvenance } from './provenance.js';

export type ConnectorSourceKind =
  'sys.hello' | 'gatt' | 'mqtt' | 'mdns' | 'openapi' | 'datasheet' | 'ir' | 'auto';

export interface GenerateConnectorOptions {
  /** How the raw input should be interpreted. `auto` inspects shape. */
  source: ConnectorSourceKind;
  /** Pre-built IR — skips ingest when provided. */
  ir?: HardwareInterfaceIR;
  /** Raw source payload (hello JSON, GATT dump, MQTT samples, OpenAPI, …). */
  raw?: unknown;
  /** Optional filesystem source path (datasheet / SDK directory). */
  sourcePath?: string;
  /** Write files under this directory. Mutually exclusive with inMemory-only use. */
  outDir?: string;
  /** Return file map without writing (daemon / PR4). */
  inMemory?: boolean;
  /**
   * When writing to outDir: allow replacing an existing non-empty directory.
   * Prefer a fresh empty directory; overwrite is for PR4 re-generation into a
   * staging path that the install pipeline owns.
   */
  overwrite?: boolean;
  /** Optional device-class hint. */
  deviceClass?: string;
  /** Provider override for UNKNOWN device naming only. */
  provider?: string;
  model?: string;
  /** Attempt local TypeScript compile of emitted sources (bumps evidence to COMPILE_TESTED). */
  compileCheck?: boolean;
}

export interface ConnectorGenerationReport {
  moduleId: string;
  slug: string;
  provenance: GenerationProvenance;
  uncertainties: HardwareInterfaceIR['uncertainties'];
  transportKinds: string[];
  evidenceLevel: GeneratorEvidenceLevel;
  /** True when physicalOutput capabilities still need human-supplied ranges. */
  pendingApprovals: string[];
  neverInstalls: true;
  neverRegisters: true;
}

export interface GenerateConnectorResult {
  files: Record<string, string>;
  report: ConnectorGenerationReport;
  capabilities: CandidateCapability[];
  safety: CandidateSafetyConstraint[];
  evidenceLevel: GeneratorEvidenceLevel;
  ir: HardwareInterfaceIR;
  outputPath?: string;
}
