import type {
  CandidateArgument,
  CandidateCapability,
  EvidenceReference,
  HardwareInterfaceIR,
  Uncertainty,
} from '../types/ir.js';
import { applyCapabilitySafetyInference } from '../safety/capabilitySafety.js';

/**
 * mDNS service advertisement and/or OpenAPI document → IR.
 * Only materializes endpoints/operations present in the source.
 */
export interface MdnsServiceRecord {
  name?: string;
  type?: string;
  host?: string;
  port?: number;
  txt?: Record<string, string>;
}

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  requestBodySchema?: Record<string, unknown>;
  readOnly?: boolean;
}

export interface MdnsOpenApiDump {
  vendor?: string;
  model?: string;
  mdns?: MdnsServiceRecord | MdnsServiceRecord[];
  openapi?: {
    info?: { title?: string; version?: string };
    paths?: Record<string, Record<string, unknown>>;
    operations?: OpenApiOperation[];
  };
}

export function ingestMdnsOpenApi(
  raw: unknown,
  options: { sourceId?: string; path?: string } = {},
): HardwareInterfaceIR {
  const sourceId = options.sourceId ?? 'mdns-openapi';
  const path = options.path ?? 'mdns-openapi.json';
  const evidence: EvidenceReference[] = [{ sourceId, path, excerpt: 'mDNS / OpenAPI source' }];
  const uncertainties: Uncertainty[] = [];

  if (!isRecord(raw)) {
    return applyCapabilitySafetyInference({
      device: { confidence: 0.1, evidence, description: 'Invalid mDNS/OpenAPI dump' },
      interfaces: [{ kind: 'unknown', confidence: 0.2, evidence }],
      capabilities: [],
      safety: [],
      evidence,
      uncertainties: [
        {
          id: 'mdns-openapi-invalid',
          message: 'Source is not a JSON object; no endpoints inferred.',
          severity: 'critical',
          confidence: 1,
          evidence,
        },
      ],
    });
  }

  const dump = raw as MdnsOpenApiDump;
  const mdnsRecords = normalizeMdns(dump.mdns);
  const operations = collectOperations(dump.openapi, uncertainties, evidence);

  const capabilities: CandidateCapability[] = operations.map((op) => {
    const method = op.method.toUpperCase();
    const readOnly =
      op.readOnly === true || method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const id = op.operationId ?? `http.${method.toLowerCase()}.${slugPath(op.path)}`;
    const args = schemaToArguments(op.requestBodySchema);
    const capability: CandidateCapability = {
      id,
      description: op.summary ?? `${method} ${op.path}`,
      confidence: 0.82,
      evidence: [{ sourceId, path, excerpt: `${method} ${op.path}` }],
      implementationStatus: 'skeleton',
      vendorNames: [op.path, method],
      safetyClass: readOnly ? 'readOnly' : 'physicalOutput',
      requiresApproval: !readOnly,
    };
    if (args) {
      capability.arguments = args;
    }
    if (readOnly) {
      capability.reversible = true;
    } else {
      capability.reversibilityNotes =
        'HTTP write/mutation may actuate; reversibility not documented in OpenAPI alone.';
    }
    return capability;
  });

  if (mdnsRecords.length === 0 && capabilities.length === 0) {
    uncertainties.push({
      id: 'mdns-openapi-empty',
      message: 'No mDNS records or OpenAPI operations found; unknowns stay explicit.',
      severity: 'warning',
      confidence: 1,
      evidence,
    });
  }

  const primaryMdns = mdnsRecords[0];
  const interfaces: HardwareInterfaceIR['interfaces'] = [];
  if (mdnsRecords.length > 0) {
    interfaces.push({
      kind: 'mdns',
      description: primaryMdns?.type ?? 'mDNS service',
      confidence: 0.85,
      evidence,
      ...(primaryMdns?.host ? { host: primaryMdns.host } : {}),
      ...(typeof primaryMdns?.port === 'number' ? { port: primaryMdns.port } : {}),
      ...(primaryMdns?.type ? { endpoint: primaryMdns.type } : {}),
    });
  }
  if (capabilities.length > 0 || dump.openapi) {
    interfaces.push({
      kind: 'http',
      description: dump.openapi?.info?.title ?? 'OpenAPI HTTP',
      confidence: capabilities.length > 0 ? 0.85 : 0.5,
      evidence,
      ...(primaryMdns?.host ? { host: primaryMdns.host } : {}),
      ...(typeof primaryMdns?.port === 'number' ? { port: primaryMdns.port } : {}),
    });
  }
  if (interfaces.length === 0) {
    interfaces.push({ kind: 'unknown', confidence: 0.2, evidence });
  }

  const ir: HardwareInterfaceIR = {
    device: {
      vendor: dump.vendor ?? 'Unknown',
      model: dump.model ?? dump.openapi?.info?.title ?? primaryMdns?.name ?? 'mdns-http-device',
      deviceClass: 'device.http',
      description: 'Device inferred from mDNS advertisement and/or OpenAPI document.',
      confidence: capabilities.length > 0 || mdnsRecords.length > 0 ? 0.7 : 0.25,
      evidence,
    },
    interfaces,
    capabilities,
    safety: [],
    evidence,
    uncertainties,
  };

  return applyCapabilitySafetyInference(ir);
}

function normalizeMdns(
  value: MdnsServiceRecord | MdnsServiceRecord[] | undefined,
): MdnsServiceRecord[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function collectOperations(
  openapi: MdnsOpenApiDump['openapi'],
  uncertainties: Uncertainty[],
  evidence: EvidenceReference[],
): OpenApiOperation[] {
  if (!openapi) {
    return [];
  }
  if (Array.isArray(openapi.operations) && openapi.operations.length > 0) {
    return openapi.operations.filter(
      (op) => op && typeof op.method === 'string' && typeof op.path === 'string',
    );
  }
  if (!openapi.paths || typeof openapi.paths !== 'object') {
    uncertainties.push({
      id: 'openapi-no-paths',
      message: 'OpenAPI document has no paths/operations; no HTTP capabilities inferred.',
      severity: 'info',
      confidence: 0.9,
      evidence,
    });
    return [];
  }

  const ops: OpenApiOperation[] = [];
  for (const [pathKey, methods] of Object.entries(openapi.paths)) {
    if (!methods || typeof methods !== 'object') {
      continue;
    }
    for (const [method, body] of Object.entries(methods as Record<string, unknown>)) {
      if (!['get', 'put', 'post', 'patch', 'delete', 'head', 'options'].includes(method)) {
        continue;
      }
      const record = isRecord(body) ? body : {};
      const op: OpenApiOperation = {
        method,
        path: pathKey,
        readOnly: method === 'get' || method === 'head' || method === 'options',
      };
      if (typeof record['operationId'] === 'string') {
        op.operationId = record['operationId'];
      }
      if (typeof record['summary'] === 'string') {
        op.summary = record['summary'];
      }
      ops.push(op);
    }
  }
  return ops;
}

function schemaToArguments(
  schema: Record<string, unknown> | undefined,
): Record<string, CandidateArgument> | undefined {
  if (!schema || schema['type'] !== 'object' || !isRecord(schema['properties'])) {
    return undefined;
  }
  const required = Array.isArray(schema['required'])
    ? new Set(schema['required'].filter((item): item is string => typeof item === 'string'))
    : new Set<string>();
  const args: Record<string, CandidateArgument> = {};
  for (const [key, prop] of Object.entries(schema['properties'])) {
    if (!isRecord(prop)) {
      continue;
    }
    const typeRaw = typeof prop['type'] === 'string' ? prop['type'] : 'string';
    const type =
      typeRaw === 'number' ||
      typeRaw === 'integer' ||
      typeRaw === 'boolean' ||
      typeRaw === 'object' ||
      typeRaw === 'string'
        ? typeRaw
        : 'string';
    const arg: CandidateArgument = {
      name: key,
      type,
      required: required.has(key),
    };
    if (typeof prop['minimum'] === 'number') {
      arg.minimum = prop['minimum'];
    }
    if (typeof prop['maximum'] === 'number') {
      arg.maximum = prop['maximum'];
    }
    if (Array.isArray(prop['enum'])) {
      arg.enumValues = prop['enum'].filter(
        (v): v is string | number | boolean =>
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      );
    }
    args[key] = arg;
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

function slugPath(path: string): string {
  return path
    .toLowerCase()
    .replace(/\{[^}]+\}/g, 'param')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
