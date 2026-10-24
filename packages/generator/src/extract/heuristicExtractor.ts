import { evidenceFromMatch, findLineEvidence } from '../ingest/evidence.js';
import { applyCapabilitySafetyInference } from '../safety/capabilitySafety.js';
import { detectContradictions } from '../safety/provenance.js';
import { inferDeviceClass, mapVendorSymbol } from '../semantic/capabilityMapper.js';
import type {
  CandidateCapability,
  CandidateSafetyConstraint,
  DocumentedNumericClaim,
  HardwareInterface,
  HardwareInterfaceIR,
  HardwareDeviceInference,
  Uncertainty,
} from '../types/ir.js';
import type { SourceDocument } from '../types/source.js';

export function extractHardwareIr(documents: SourceDocument[]): HardwareInterfaceIR {
  const text = documents.map((doc) => doc.content).join('\n');
  const uncertainties: Uncertainty[] = [];
  const capabilities = new Map<string, CandidateCapability>();
  const safety: CandidateSafetyConstraint[] = [];
  const claims: DocumentedNumericClaim[] = [];

  extractCapabilities(documents, capabilities, uncertainties, claims);
  extractSafety(documents, text, safety, uncertainties, capabilities);
  detectAmbiguities(documents, text, uncertainties, safety);

  // Contradiction pass: examples vs documented bounds are DATA-vs-DATA
  // conflicts that must be surfaced for human review, never auto-resolved.
  {
    const provenancedSafety = safety.map((constraint) => ({
      ...constraint,
      provenance: (constraint.documented && constraint.confidence >= 0.8
        ? 'DOCUMENTED'
        : 'INFERRED') as 'DOCUMENTED' | 'INFERRED',
      hardEligible: false,
    }));
    const contradictions = detectContradictions(provenancedSafety, claims);
    if (contradictions.length > 0) {
      uncertainties.push({
        id: 'source-contradictions',
        message: `${contradictions.length} contradiction(s) between sources detected; hard policies suppressed pending human review.`,
        severity: 'critical',
        confidence: 0.99,
      });
    }
  }

  if (/TCP|port\s*\d+/i.test(text) && !/timeout/i.test(text)) {
    uncertainties.push({
      id: 'transport-timeout',
      message: 'No documented connection timeout for TCP interface.',
      severity: 'warning',
    });
  }

  const state = inferState(text);
  const ir: HardwareInterfaceIR = {
    device: inferDeviceMetadata(documents, text),
    interfaces: inferInterfaceList(documents, text),
    capabilities: [...capabilities.values()].sort((a, b) => a.id.localeCompare(b.id)),
    events: [],
    safety,
    evidence: documents.map((doc) => ({ sourceId: doc.id, path: doc.path })),
    uncertainties,
  };
  if (state) {
    ir.state = state;
  }
  if (claims.length > 0) {
    ir.claims = claims;
  }
  return applyCapabilitySafetyInference(ir);
}

function inferDeviceMetadata(documents: SourceDocument[], text: string): HardwareDeviceInference {
  const evidence = [];
  let vendor: string | undefined;
  let model: string | undefined;

  for (const doc of documents) {
    const vendorMatch = findLineEvidence(doc, /vendor\s*:\s*([^\n]+)/i);
    if (vendorMatch) {
      vendor = vendorMatch.match[1]?.trim();
      evidence.push(vendorMatch.evidence);
    }
    const modelMatch = findLineEvidence(doc, /model\s*:\s*([^\n]+)/i);
    if (modelMatch) {
      model = modelMatch.match[1]?.trim();
      evidence.push(modelMatch.evidence);
    }
  }

  if (!vendor && /Acme/i.test(text)) {
    vendor = 'Acme';
  }
  if (!model) {
    const heatbox = text.match(/HeatBox\s*400/i);
    if (heatbox) {
      model = 'HeatBox 400';
    }
    const arm = text.match(/RoboArm\s*X1/i);
    if (arm) {
      model = 'RoboArm X1';
    }
  }

  const deviceClass = inferDeviceClass(text);
  const inference: HardwareDeviceInference = {
    confidence: vendor && model && deviceClass ? 0.95 : 0.65,
    evidence,
  };
  if (vendor !== undefined) {
    inference.vendor = vendor;
  }
  if (model !== undefined) {
    inference.model = model;
  }
  if (deviceClass !== undefined) {
    inference.deviceClass = deviceClass;
  }
  if (model) {
    inference.description = `${vendor ?? 'Unknown'} ${model}`;
  }
  return inference;
}

function inferInterfaceList(documents: SourceDocument[], text: string): HardwareInterface[] {
  const interfaces: HardwareInterface[] = [];
  const baseEvidence = documents.slice(0, 1).map((doc) => ({ sourceId: doc.id, path: doc.path }));

  if (/TCP|telnet|socket/i.test(text)) {
    const portMatch = text.match(/port\s*(?:=|:)?\s*(\d+)/i);
    const tcp: HardwareInterface = {
      kind: 'tcp',
      evidence: baseEvidence,
      confidence: 0.85,
    };
    if (portMatch) {
      tcp.port = Number.parseInt(portMatch[1]!, 10);
    }
    interfaces.push(tcp);
  }
  if (/BLE|Bluetooth\s*LE|GATT/i.test(text)) {
    interfaces.push({
      kind: 'ble-gatt',
      description: 'Bluetooth LE GATT inferred from documentation',
      evidence: baseEvidence,
      confidence: 0.8,
    });
  }
  if (/\bMQTT\b|mosquitto|broker/i.test(text)) {
    interfaces.push({
      kind: 'mqtt',
      description: 'MQTT inferred from documentation',
      evidence: baseEvidence,
      confidence: 0.8,
    });
  }
  if (/mDNS|Bonjour|_http\._tcp|_pinout/i.test(text)) {
    interfaces.push({
      kind: 'mdns',
      description: 'mDNS service discovery inferred from documentation',
      evidence: baseEvidence,
      confidence: 0.75,
    });
  }
  if (/sys\.hello|serial-bridge|NDJSON.*bridge|pinout.*bridge/i.test(text)) {
    interfaces.push({
      kind: 'serial-bridge',
      description: 'Pinout serial bridge (sys.hello) inferred from documentation',
      baud: 115200,
      evidence: baseEvidence,
      confidence: 0.85,
    });
  }
  if (
    /serial|UART|RS-?232|baud/i.test(text) &&
    !interfaces.some((i) => i.kind === 'serial-bridge')
  ) {
    interfaces.push({
      kind: 'serial',
      baud: 115200,
      evidence: baseEvidence,
      confidence: 0.8,
    });
  }
  if (/OpenAPI|swagger|https?:\/\//i.test(text) && !interfaces.some((i) => i.kind === 'http')) {
    interfaces.push({
      kind: 'http',
      description: 'HTTP/OpenAPI inferred from documentation',
      evidence: baseEvidence,
      confidence: 0.7,
    });
  }
  if (interfaces.length === 0) {
    interfaces.push({
      kind: 'sdk',
      description: 'SDK/library integration inferred from source files',
      evidence: baseEvidence,
      confidence: 0.6,
    });
  }
  return interfaces;
}

function extractCapabilities(
  documents: SourceDocument[],
  capabilities: Map<string, CandidateCapability>,
  uncertainties: Uncertainty[],
  claims: DocumentedNumericClaim[],
): void {
  const symbolPattern =
    /\b(function|def|void|int|float|bool|async)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(|^\s*([A-Z_]{3,}[A-Z0-9_]*)\s*$/gm;

  for (const doc of documents) {
    let match: RegExpExecArray | null;
    while ((match = symbolPattern.exec(doc.content)) !== null) {
      const symbol = match[2] ?? match[3];
      if (!symbol) {
        continue;
      }
      const mapping = mapVendorSymbol(symbol);
      if (!mapping) {
        continue;
      }
      mergeCapability(
        capabilities,
        mapping.capabilityId,
        mapping.confidence,
        symbol,
        evidenceFromMatch(doc, match.index, match[0]),
      );
    }

    const isProse = doc.type === 'md' || doc.type === 'txt' || doc.type === 'yaml';
    for (const line of doc.content.split('\n')) {
      const cmdMatch = line.match(/^(SET TEMP|GET TEMP|OPEN DOOR|CLOSE DOOR|LED:ON|LED:OFF)/i);
      if (cmdMatch) {
        const mapping = mapVendorSymbol(cmdMatch[1]!);
        if (mapping) {
          mergeCapability(
            capabilities,
            mapping.capabilityId,
            mapping.confidence,
            cmdMatch[1]!,
            evidenceFromMatch(doc, doc.content.indexOf(line), line),
          );
        }
        continue;
      }

      // SCPI-style command reference lines, e.g. "VOLT <value>" or "MEAS:VOLT?".
      if (isProse) {
        const scpiMatch = line.match(/^\s*([A-Z][A-Z:]*\??)\s*(?:<|ON\b|OFF\b|\?|$)/);
        if (scpiMatch) {
          const mapping = mapVendorSymbol(scpiMatch[1]!);
          if (mapping) {
            mergeCapability(
              capabilities,
              mapping.capabilityId,
              Math.min(mapping.confidence, 0.85),
              scpiMatch[1]!,
              evidenceFromMatch(doc, doc.content.indexOf(line), line),
            );
          }
          continue;
        }

        // Modbus register-map table rows:
        // | 40010 | holding | setpoint | write | 0.1 | C |
        const registerRow = line.match(
          /^\|\s*\d+\s*\|\s*(holding|input|coil|discrete)\s*\|\s*([a-zA-Z0-9_.-]+)\s*\|\s*(read|write)\s*\|/,
        );
        if (registerRow) {
          const name = registerRow[2]!;
          const access = registerRow[3]!;
          const mapping = mapVendorSymbol(name);
          if (mapping) {
            mergeCapability(
              capabilities,
              mapping.capabilityId,
              Math.min(mapping.confidence + 0.05, 0.9),
              `${name}(${access})`,
              evidenceFromMatch(doc, doc.content.indexOf(line), line),
            );
            if (access === 'read') {
              const readMapping = mapVendorSymbol(`read_${name.split('.').pop()}`);
              if (readMapping && !capabilities.has(readMapping.capabilityId)) {
                mergeCapability(
                  capabilities,
                  readMapping.capabilityId,
                  0.7,
                  name,
                  evidenceFromMatch(doc, doc.content.indexOf(line), line),
                );
              }
            }
          }
        }

        // Bare SDK calls in prose: set_temp(85), distance_read(), gpio_write(pin, value).
        const bareCall = line.match(/(?:^|\s|`)\s*([a-z][a-zA-Z0-9_]*)\s*\(([^)]*)\)/);
        if (bareCall) {
          const symbol = bareCall[1]!;
          const mapping = mapVendorSymbol(symbol);
          if (mapping) {
            mergeCapability(
              capabilities,
              mapping.capabilityId,
              Math.min(mapping.confidence, 0.82),
              symbol,
              evidenceFromMatch(doc, doc.content.indexOf(line), line),
            );
            // Record numeric example calls as claims (data for contradiction
            // detection, never hard rules).
            const numericArg = bareCall[2]!
              .split(',')
              .map((part) => part.trim())
              .find((part) => /^-?\d+(?:\.\d+)?$/.test(part));
            if (numericArg !== undefined && !mapping.capabilityId.startsWith('vendor.')) {
              const value = Number.parseFloat(numericArg);
              if (
                !claims.some(
                  (claim) => claim.capability === mapping.capabilityId && claim.value === value,
                )
              ) {
                claims.push({
                  claim: `${symbol}(${numericArg}) in ${doc.path}`,
                  capability: mapping.capabilityId,
                  value,
                  evidence: [evidenceFromMatch(doc, doc.content.indexOf(line), line)],
                });
              }
            }
          }
        }
        continue;
      }

      const backtickFn = line.match(/`([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)`/);
      if (backtickFn) {
        const mapping = mapVendorSymbol(backtickFn[1]!);
        if (mapping) {
          mergeCapability(
            capabilities,
            mapping.capabilityId,
            mapping.confidence,
            backtickFn[1]!,
            evidenceFromMatch(doc, doc.content.indexOf(line), line),
          );
        }
      }
    }
  }

  if (capabilities.has('temperature.set')) {
    const cap = capabilities.get('temperature.set')!;
    if (!cap.arguments?.temperature?.unit) {
      uncertainties.push({
        id: 'temperature-unit',
        message: 'Could not determine unit for temperature parameter in all sources.',
        severity: 'warning',
        confidence: 0.5,
      });
    }
  }
}

function mergeCapability(
  capabilities: Map<string, CandidateCapability>,
  capabilityId: string,
  confidence: number,
  symbol: string,
  evidence: ReturnType<typeof evidenceFromMatch>,
): void {
  const existing = capabilities.get(capabilityId);
  if (existing) {
    existing.vendorNames?.push(symbol);
    existing.evidence.push(evidence);
    existing.confidence = Math.max(existing.confidence, confidence);
    return;
  }
  const capability: CandidateCapability = {
    id: capabilityId,
    description: `Mapped from vendor symbol '${symbol}'`,
    vendorNames: [symbol],
    confidence,
    evidence: [evidence],
    implementationStatus: confidence >= 0.85 ? 'implemented' : 'skeleton',
  };
  const args = defaultArguments(capabilityId);
  if (args) {
    capability.arguments = args;
  }
  capabilities.set(capabilityId, capability);
}

function defaultArguments(capabilityId: string) {
  if (capabilityId === 'temperature.set') {
    return {
      temperature: {
        name: 'temperature',
        type: 'number' as const,
        unit: 'celsius',
        required: true,
      },
    };
  }
  if (capabilityId === 'motion.move_to') {
    return {
      x: { name: 'x', type: 'number' as const, required: true },
      y: { name: 'y', type: 'number' as const, required: true },
      z: { name: 'z', type: 'number' as const, required: true },
    };
  }
  return undefined;
}

function extractSafety(
  documents: SourceDocument[],
  text: string,
  safety: CandidateSafetyConstraint[],
  uncertainties: Uncertainty[],
  capabilities: Map<string, CandidateCapability>,
): void {
  for (const doc of documents) {
    const explicitRange = findLineEvidence(
      doc,
      /(?:temperature|setpoint)[^.\n]{0,40}?(\d+(?:\.\d+)?)\s*°?\s*(?:C\b)?\s*(?:to|–|-)\s*(\d+(?:\.\d+)?)\s*°?\s*C\b/i,
    );
    if (explicitRange && capabilities.has('temperature.set')) {
      safety.push({
        type: 'range',
        capability: 'temperature.set',
        argument: /setpoint/i.test(explicitRange.match[0]) ? 'setpoint' : 'temperature',
        minimum: Number.parseFloat(explicitRange.match[1]!),
        maximum: Number.parseFloat(explicitRange.match[2]!),
        confidence: 0.99,
        evidence: [explicitRange.evidence],
        requiresHumanReview: false,
        documented: true,
      });
    }

    // "Measurement range: 0.15 m to 12 m" (sensor operating envelope).
    const distanceRange = findLineEvidence(
      doc,
      /(?:measurement|operating)\s*range[^.\n]{0,40}?(\d+(?:\.\d+)?)\s*(?:m\b)?\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*m\b/i,
    );
    if (distanceRange && capabilities.has('distance.read')) {
      safety.push({
        type: 'range',
        capability: 'distance.read',
        minimum: Number.parseFloat(distanceRange.match[1]!),
        maximum: Number.parseFloat(distanceRange.match[2]!),
        confidence: 0.95,
        evidence: [distanceRange.evidence],
        requiresHumanReview: false,
        documented: true,
      });
    }

    // "Gripper force must stay between 20 and 100 N."
    const forceBetween = findLineEvidence(
      doc,
      /gripper[^.\n]{0,60}?between\s*(\d+(?:\.\d+)?)\s*(?:and|to)\s*(\d+(?:\.\d+)?)\s*N\b/i,
    );
    if (forceBetween && capabilities.has('gripper.close')) {
      safety.push({
        type: 'range',
        capability: 'gripper.close',
        argument: 'force_newtons',
        minimum: Number.parseFloat(forceBetween.match[1]!),
        maximum: Number.parseFloat(forceBetween.match[2]!),
        confidence: 0.95,
        evidence: [forceBetween.evidence],
        requiresHumanReview: false,
        documented: true,
      });
    }

    // "X must not exceed N <unit>" and "maximum N <unit>" documented limits
    // mapped by unit to capability families.
    const unitLimits: Array<{
      pattern: RegExp;
      capability: string;
      argument: string;
      unit: string;
    }> = [
      {
        pattern:
          /(joint[^.\n]{0,30}?)?speed[^.\n]{0,40}?must not exceed\s*(\d+(?:\.\d+)?)\s*rad\/s/i,
        capability: 'motion.move_joint',
        argument: 'speed_rad_s',
        unit: 'rad/s',
      },
      {
        pattern: /(tool[^.\n]{0,30}?)?speed[^.\n]{0,40}?must not exceed\s*(\d+(?:\.\d+)?)\s*mm\/s/i,
        capability: 'motion.move_to',
        argument: 'speed_mm_s',
        unit: 'mm/s',
      },
      {
        pattern: /maximum\s*(\d+(?:\.\d+)?)\s*mA\s*per\s*pin/i,
        capability: 'gpio.write',
        argument: 'current',
        unit: 'mA',
      },
      {
        pattern: /payload\s*maximum\s*(\d+(?:\.\d+)?)\s*kg/i,
        capability: 'payload.set',
        argument: 'kg',
        unit: 'kg',
      },
    ];
    for (const limit of unitLimits) {
      const limitMatch = findLineEvidence(doc, limit.pattern);
      if (limitMatch && (capabilities.has(limit.capability) || limit.capability === 'gpio.write')) {
        const value = Number.parseFloat(limitMatch.match[1] ?? limitMatch.match[2] ?? '');
        if (!Number.isFinite(value)) continue;
        safety.push({
          type: 'range',
          capability: limit.capability,
          argument: limit.argument,
          maximum: value,
          confidence: 0.95,
          evidence: [limitMatch.evidence],
          requiresHumanReview: false,
          documented: true,
        });
      }
    }

    // Voltage/current ranges (instrument-style documentation):
    // "Output voltage range: 0 to 30 V" / "Current limit range: 0 to 5 A".
    for (const quantity of ['voltage', 'current'] as const) {
      const unit = quantity === 'voltage' ? 'V' : 'A';
      const argName = quantity === 'voltage' ? 'voltage' : 'current';
      const capabilityId = quantity === 'voltage' ? 'voltage.set' : 'current.set';
      const rangeMatch = findLineEvidence(
        doc,
        new RegExp(
          `${quantity}[^.\\n]{0,40}?(\\d+(?:\\.\\d+)?)\\s*(?:${unit}\\b)?\\s*(?:to|–|-)\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}\\b`,
          'i',
        ),
      );
      if (
        rangeMatch &&
        (capabilities.has(capabilityId) ||
          capabilities.has(quantity === 'voltage' ? 'voltage.read' : 'current.read'))
      ) {
        safety.push({
          type: 'range',
          capability: capabilityId,
          argument: argName,
          minimum: Number.parseFloat(rangeMatch.match[1]!),
          maximum: Number.parseFloat(rangeMatch.match[2]!),
          confidence: 0.95,
          evidence: [rangeMatch.evidence],
          requiresHumanReview: false,
          documented: true,
        });
      }
    }

    const inferredRange = findLineEvidence(doc, /(?:max(?:imum)?|up to)\s*(\d+)\s*°?\s*C/i);
    if (inferredRange && !safety.some((s) => s.capability === 'temperature.set' && s.documented)) {
      safety.push({
        type: 'candidate',
        capability: 'temperature.set',
        argument: 'temperature',
        maximum: Number.parseInt(inferredRange.match[1]!, 10),
        confidence: 0.65,
        evidence: [inferredRange.evidence],
        requiresHumanReview: true,
        documented: false,
        message: 'Inferred maximum temperature — requires human review before hard policy.',
      });
    }

    if (
      /experiment\.start.*door.*closed|door must be closed|requires door closed/i.test(doc.content)
    ) {
      safety.push({
        type: 'precondition',
        capability: 'experiment.start',
        field: 'door',
        equals: 'closed',
        confidence: 0.96,
        evidence: [{ sourceId: doc.id, path: doc.path, excerpt: 'door closed precondition' }],
        requiresHumanReview: false,
        documented: true,
      });
    }
  }

  if (
    capabilities.has('temperature.set') &&
    !safety.some((s) => s.capability === 'temperature.set')
  ) {
    uncertainties.push({
      id: 'no-temperature-range',
      message: 'NO SAFE RANGE FOUND for temperature.set in analyzed sources.',
      severity: 'critical',
    });
  }

  const rangeMatches = [...text.matchAll(/(\d+)\s*°?\s*C?\s*(?:to|-)\s*(\d+)\s*°?\s*C/gi)];
  if (rangeMatches.length > 1) {
    const mins = rangeMatches.map((m) => Number.parseInt(m[1]!, 10));
    const maxs = rangeMatches.map((m) => Number.parseInt(m[2]!, 10));
    const unique = new Set(mins.map((min, i) => `${min}-${maxs[i]}`));
    if (unique.size > 1) {
      uncertainties.push({
        id: 'conflicting-ranges',
        message: 'Conflicting temperature range documentation detected across sources.',
        severity: 'critical',
      });
    }
  }
}

function detectAmbiguities(
  documents: SourceDocument[],
  text: string,
  uncertainties: Uncertainty[],
  safety: CandidateSafetyConstraint[],
): void {
  if (/speed|velocity/i.test(text) && !/\b(km\/h|rpm|m\/s|mm\/s)\b/i.test(text)) {
    uncertainties.push({
      id: 'unknown-speed-unit',
      message: 'Unknown unit for speed parameter.',
      severity: 'warning',
    });
  }

  if (/experiment\.start/i.test(text) && /timing|TBD|unclear/i.test(text)) {
    uncertainties.push({
      id: 'experiment-timing',
      message: 'experiment.start timing semantics are unclear.',
      severity: 'info',
    });
  }

  if (safety.some((s) => s.requiresHumanReview)) {
    uncertainties.push({
      id: 'review-inferred-safety',
      message: 'One or more safety constraints were inferred and require human review.',
      severity: 'warning',
    });
  }

  for (const doc of documents) {
    if (/deprecated|obsolete/i.test(doc.content)) {
      uncertainties.push({
        id: `deprecated-${doc.id}`,
        message: `Method or API may be deprecated per ${doc.path}.`,
        severity: 'warning',
        evidence: [{ sourceId: doc.id, path: doc.path }],
      });
    }
  }
}

function inferState(text: string) {
  const fields = [];
  if (/temperature/i.test(text)) {
    fields.push({ name: 'temperature', type: 'number', description: 'Current temperature' });
  }
  if (/door/i.test(text)) {
    fields.push({ name: 'door', type: 'string', description: 'Door state open|closed' });
  }
  if (/position|pose|moveTo/i.test(text)) {
    fields.push({ name: 'position', type: 'object', description: 'End effector position' });
  }
  return fields.length > 0 ? fields : undefined;
}
