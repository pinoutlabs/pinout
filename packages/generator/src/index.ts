export { analyzeHardwareSource } from './pipeline/analyze.js';
export {
  generateCandidateModule,
  type GenerateOptions,
  type GenerateResult,
} from './pipeline/generate.js';
export { formatGenerationPlan, formatGenerationPlanJson } from './pipeline/plan.js';
export { ingestSource, hashSourceContent } from './ingest/ingestSource.js';
export { extractHardwareIr } from './providers/mockProvider.js';
export { emitCandidateModule, GENERATOR_VERSION } from './emit/moduleEmitter.js';
export {
  evaluateIrAgainstExpected,
  type ExpectedFixture,
  type EvaluationMetrics,
} from './eval/evaluate.js';
export { loadGeneratorConfig, redactSecrets } from './config.js';
export { createGeneratorProvider } from './providers/registry.js';
export { createMockProvider } from './providers/mockProvider.js';
export { createHttpProvider } from './providers/httpProvider.js';
export type { HardwareInterfaceIR, CandidateCapability, Uncertainty } from './types/ir.js';
export type { SourceDocument } from './types/source.js';
export type { GeneratorModel, GeneratorProvider } from './providers/types.js';
export { confidenceBand } from './types/ir.js';
export { ingestPdf, pdfPagesToEvidence, extractTextFromContentStream } from './ingest/pdfIngest.js';
export type { PdfIngestResult, PdfPageText } from './ingest/pdfIngest.js';
export {
  classifyProvenance,
  detectContradictions,
  applyProvenancePolicy,
  scanForPromptInjection,
  classifyImplementationState,
} from './safety/provenance.js';
export type {
  SafetyProvenance,
  ProvenancedConstraint,
  Contradiction,
  DocumentedClaim,
  InjectionFinding,
  ImplementationState,
} from './safety/provenance.js';
export { repairGeneratedModule, parseCompilerErrors } from './pipeline/repair.js';
export type {
  CompilerError,
  RepairAttempt,
  RepairResult,
  RepairOptions,
} from './pipeline/repair.js';
export {
  validateGeneratedModuleLayout,
  GENERATED_MODULE_REQUIRED_ENTRIES,
  REGISTRY_PACK_EXCLUDED_DIRECTORIES,
} from './registryCompat.js';
export type {
  GeneratedModuleLayoutReport,
  GeneratedModuleManifestSummary,
} from './registryCompat.js';
