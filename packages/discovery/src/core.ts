/**
 * Discovery types and hard rules (spec v1).
 *
 * Discovery NEVER actuates hardware. The plugin interface has no write path,
 * candidates are read-only observations, and `validateCandidate` enforces the
 * honesty rules:
 *
 * - confidence is capped at 0.95 and only reachable via a device-confirmed
 *   handshake (e.g. a `GET /v1/health` that answered with `{ok:true}`);
 * - a single weak heuristic (VID/PID match, port open, manufacturer string,
 *   BLE local name / advertised service UUID) caps confidence at 0.5 — a
 *   device identity is never claimed on one signal;
 * - every candidate must carry at least one piece of evidence.
 */
import { createHash } from 'node:crypto';

export type EndpointKind = 'serial' | 'usb' | 'network' | 'ble' | 'mdns' | 'simulated';

export interface DiscoveredEndpoint {
  kind: EndpointKind;
  address: string;
  port?: number;
  /** Transport-level details (VID/PID, manufacturer, service names, …). */
  details?: Record<string, unknown>;
}

export interface IdentityGuess {
  moduleId: string;
  vendor?: string;
  deviceClass?: string;
  reason: string;
  /** Discovery hint only — module is not in the builtin registry. */
  unavailable?: boolean;
}

export interface Evidence {
  source: string;
  detail: string;
  /** 0..1 — how strongly this evidence alone supports the identity. */
  weight: number;
}

export interface DiscoveredCandidate {
  id: string;
  endpoint: DiscoveredEndpoint;
  possibleIdentity: IdentityGuess[];
  evidence: Evidence[];
  confidence: number;
  interfaces: string[];
}

export interface DiscoveryOptions {
  timeoutMs?: number;
  /** Opt-in network probing. Off by default; bounded and never a subnet scan. */
  network?: {
    enabled: boolean;
    endpoints?: Array<{ host: string; port: number; probe?: 'pinout-daemon' }>;
  };
  /** Injectable serial-port lister for tests. */
  listSerialPorts?: () => Promise<
    Array<{ path: string; manufacturer?: string; vendorId?: string; productId?: string }>
  >;
}

export interface DiscoveryPlugin {
  name: string;
  /** Must be read-only: observe and report, never open/actuate hardware. */
  discover(options: DiscoveryOptions): Promise<DiscoveredCandidate[]>;
}

export function candidateId(endpoint: DiscoveredEndpoint): string {
  const hash = createHash('sha256')
    .update(`${endpoint.kind}:${endpoint.address}:${endpoint.port ?? ''}`)
    .digest('hex')
    .slice(0, 12);
  return `cand_${hash}`;
}

export class CandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateValidationError';
  }
}

const ABSOLUTE_CONFIDENCE_CAP = 0.95;
const WEAK_HEURISTIC_CAP = 0.5;

/**
 * Enforce the honesty rules. Throws on candidates that would overstate what
 * discovery knows — silently capping would hide plugin bugs.
 */
export function validateCandidate(candidate: DiscoveredCandidate): DiscoveredCandidate {
  if (candidate.evidence.length === 0) {
    throw new CandidateValidationError(`Candidate '${candidate.id}' has no evidence.`);
  }
  const strongestEvidence = Math.max(...candidate.evidence.map((entry) => entry.weight));
  if (candidate.confidence > ABSOLUTE_CONFIDENCE_CAP) {
    throw new CandidateValidationError(
      `Candidate '${candidate.id}' claims confidence ${candidate.confidence} > ${ABSOLUTE_CONFIDENCE_CAP}. Only a device-confirmed handshake justifies near-certainty.`,
    );
  }
  if (strongestEvidence < 0.9 && candidate.confidence > WEAK_HEURISTIC_CAP) {
    throw new CandidateValidationError(
      `Candidate '${candidate.id}' claims confidence ${candidate.confidence} from weak evidence (strongest weight ${strongestEvidence}). Strong claims need device confirmation.`,
    );
  }
  return candidate;
}

/** Merge candidates that describe the same physical endpoint. */
export function mergeCandidates(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  const byKey = new Map<string, DiscoveredCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.endpoint.kind}:${candidate.endpoint.address}:${candidate.endpoint.port ?? ''}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    existing.possibleIdentity.push(...candidate.possibleIdentity);
    existing.evidence.push(...candidate.evidence);
    // Max confidence (never average): merging evidence strengthens, but we
    // keep the honesty cap via validateCandidate at the end.
    existing.confidence = Math.max(existing.confidence, candidate.confidence);
    for (const iface of candidate.interfaces) {
      if (!existing.interfaces.includes(iface)) existing.interfaces.push(iface);
    }
  }
  return [...byKey.values()];
}

export interface DiscoveryRun {
  candidates: DiscoveredCandidate[];
  durationMs: number;
  pluginsRun: string[];
  errors: Array<{ plugin: string; message: string }>;
}

/** Run plugins in parallel, merge, validate. Plugin failures are isolated. */
export async function runDiscovery(
  options: DiscoveryOptions & { plugins?: DiscoveryPlugin[] } = {},
): Promise<DiscoveryRun> {
  const started = Date.now();
  const plugins = options.plugins ?? [];
  const errors: DiscoveryRun['errors'] = [];
  const settled = await Promise.allSettled(plugins.map((plugin) => plugin.discover(options)));
  const candidates: DiscoveredCandidate[] = [];

  settled.forEach((result, index) => {
    const plugin = plugins[index]!;
    if (result.status === 'fulfilled') {
      for (const candidate of result.value) {
        try {
          candidates.push(validateCandidate(candidate));
        } catch (error) {
          errors.push({
            plugin: plugin.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      errors.push({
        plugin: plugin.name,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return {
    candidates: mergeCandidates(candidates).sort((a, b) => b.confidence - a.confidence),
    durationMs: Date.now() - started,
    pluginsRun: plugins.map((plugin) => plugin.name),
    errors,
  };
}

/** Human-readable candidate table (the `pinout discover` output). */
export function formatCandidatesTable(candidates: DiscoveredCandidate[]): string[] {
  const lines: string[] = [`FOUND ${candidates.length} CANDIDATE DEVICES`];
  for (const candidate of candidates) {
    const endpoint =
      candidate.endpoint.kind === 'network' && candidate.endpoint.port !== undefined
        ? `${candidate.endpoint.address}:${candidate.endpoint.port}`
        : candidate.endpoint.address;
    lines.push('');
    lines.push(endpoint);
    if (candidate.possibleIdentity.length > 0) {
      const identity = candidate.possibleIdentity[0]!;
      lines.push(`  possible: ${identity.vendor ? `${identity.vendor} ` : ''}${identity.moduleId}`);
    }
    lines.push(`  confidence: ${candidate.confidence.toFixed(2)}`);
    for (const evidence of candidate.evidence) {
      lines.push(`  evidence: ${evidence.source} — ${evidence.detail}`);
    }
    if (candidate.interfaces.length > 0) {
      lines.push(`  interfaces: ${candidate.interfaces.join(', ')}`);
    }
  }
  return lines;
}
