import type {
  CandidateArgument,
  CandidateCapability,
  EvidenceReference,
  HardwareInterfaceIR,
  Uncertainty,
} from '../types/ir.js';
import { applyCapabilitySafetyInference } from '../safety/capabilitySafety.js';

/**
 * Observed MQTT topic + payload samples → capabilities with inferred schemas.
 * Never invents topics that were not observed.
 */
export interface MqttSample {
  topic: string;
  payload: unknown;
  direction?: 'publish' | 'subscribe' | 'unknown';
  retained?: boolean;
}

export interface MqttObservationDump {
  vendor?: string;
  model?: string;
  broker?: string;
  samples?: MqttSample[];
}

export function ingestMqttObservations(
  raw: unknown,
  options: { sourceId?: string; path?: string } = {},
): HardwareInterfaceIR {
  const sourceId = options.sourceId ?? 'mqtt';
  const path = options.path ?? 'mqtt-samples.json';
  const evidence: EvidenceReference[] = [{ sourceId, path, excerpt: 'MQTT topic samples' }];
  const uncertainties: Uncertainty[] = [];

  if (!isRecord(raw)) {
    return applyCapabilitySafetyInference({
      device: { confidence: 0.1, evidence, description: 'Invalid MQTT observation dump' },
      interfaces: [{ kind: 'mqtt', confidence: 0.3, evidence }],
      capabilities: [],
      safety: [],
      evidence,
      uncertainties: [
        {
          id: 'mqtt-invalid',
          message: 'MQTT dump is not a JSON object; no topics inferred.',
          severity: 'critical',
          confidence: 1,
          evidence,
        },
      ],
    });
  }

  const dump = raw as MqttObservationDump;
  const samples = Array.isArray(dump.samples) ? dump.samples : [];
  if (samples.length === 0) {
    uncertainties.push({
      id: 'mqtt-empty',
      message: 'No MQTT samples observed; refusing to invent topics or capabilities.',
      severity: 'warning',
      confidence: 1,
      evidence,
    });
  }

  const byTopic = new Map<string, MqttSample[]>();
  for (const sample of samples) {
    if (!sample || typeof sample.topic !== 'string' || sample.topic.trim().length === 0) {
      uncertainties.push({
        id: `mqtt-bad-sample-${byTopic.size}`,
        message: 'Skipping sample without a topic string.',
        severity: 'info',
        evidence,
      });
      continue;
    }
    const topic = sample.topic.trim();
    const list = byTopic.get(topic) ?? [];
    list.push(sample);
    byTopic.set(topic, list);
  }

  const capabilities: CandidateCapability[] = [];
  for (const [topic, topicSamples] of [...byTopic.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const direction = inferDirection(topic, topicSamples);
    const schema = inferPayloadSchema(topicSamples.map((s) => s.payload));
    const id = mqttCapabilityId(topic, direction);
    const isCommand = direction === 'publish' || /\/(cmd|set|command)\b/i.test(topic);
    const isSensor = direction === 'subscribe' || /\/(state|status|tele|sensor)\b/i.test(topic);

    const args: Record<string, CandidateArgument> = {};
    if (isCommand && schema) {
      for (const [key, arg] of Object.entries(schema)) {
        args[key] = arg;
      }
    }

    const capability: CandidateCapability = {
      id,
      description: `MQTT ${direction} on ${topic}`,
      confidence: 0.78,
      evidence: [
        {
          sourceId,
          path,
          excerpt: `${topic} (${topicSamples.length} sample(s))`,
        },
      ],
      implementationStatus: 'skeleton',
      vendorNames: [topic],
      safetyClass: isCommand ? 'physicalOutput' : isSensor ? 'readOnly' : 'unknown',
      requiresApproval: isCommand,
    };
    if (Object.keys(args).length > 0) {
      capability.arguments = args;
    }
    if (!isCommand && schema) {
      capability.output = schema;
    }
    if (isCommand) {
      capability.reversible = true;
      capability.reversibilityNotes =
        'Publish may actuate; reverse command not confirmed from samples alone.';
    }
    capabilities.push(capability);

    if (!schema) {
      uncertainties.push({
        id: `mqtt-schema-${slugTopic(topic)}`,
        message: `Could not infer a strict schema for topic ${topic}; payload shape remains unknown.`,
        severity: 'info',
        confidence: 0.7,
        evidence,
      });
    }
  }

  const ir: HardwareInterfaceIR = {
    device: {
      vendor: dump.vendor ?? 'Unknown MQTT',
      model: dump.model ?? 'mqtt-device',
      deviceClass: inferMqttDeviceClass(capabilities),
      description: 'Device inferred from observed MQTT topics and payloads.',
      confidence: capabilities.length > 0 ? 0.7 : 0.25,
      evidence,
    },
    interfaces: [
      {
        kind: 'mqtt',
        description: dump.broker ? `MQTT broker ${dump.broker}` : 'MQTT',
        confidence: 0.88,
        evidence,
        ...(dump.broker ? { endpoint: dump.broker } : {}),
      },
    ],
    capabilities,
    safety: [],
    evidence,
    uncertainties,
  };

  return applyCapabilitySafetyInference(ir);
}

function inferDirection(topic: string, samples: MqttSample[]): 'publish' | 'subscribe' | 'unknown' {
  const explicit = samples.find((s) => s.direction === 'publish' || s.direction === 'subscribe');
  if (explicit?.direction === 'publish' || explicit?.direction === 'subscribe') {
    return explicit.direction;
  }
  if (/\/(cmd|set|command)\b/i.test(topic)) {
    return 'publish';
  }
  if (/\/(state|status|tele|sensor|stat)\b/i.test(topic)) {
    return 'subscribe';
  }
  return 'unknown';
}

function inferPayloadSchema(payloads: unknown[]): Record<string, CandidateArgument> | undefined {
  const objects = payloads.filter(isRecord);
  if (objects.length === 0) {
    // Primitive payloads → single value field when consistent.
    const primitives = payloads.filter(
      (p) => typeof p === 'number' || typeof p === 'string' || typeof p === 'boolean',
    );
    if (primitives.length === 0) {
      return undefined;
    }
    const types = new Set(primitives.map((p) => typeof p));
    if (types.size !== 1) {
      return undefined;
    }
    const typeName = [...types][0] as 'number' | 'string' | 'boolean';
    return {
      value: {
        name: 'value',
        type: typeName === 'number' ? 'number' : typeName,
        required: true,
        description: 'Inferred from MQTT payload samples',
      },
    };
  }

  const keys = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      keys.add(key);
    }
  }

  const schema: Record<string, CandidateArgument> = {};
  for (const key of [...keys].sort()) {
    const values = objects.map((obj) => obj[key]).filter((v) => v !== undefined);
    const arg = inferArgFromValues(key, values);
    if (arg) {
      schema[key] = arg;
    }
  }
  return Object.keys(schema).length > 0 ? schema : undefined;
}

function inferArgFromValues(name: string, values: unknown[]): CandidateArgument | undefined {
  if (values.length === 0) {
    return undefined;
  }
  if (values.every((v) => typeof v === 'boolean')) {
    return { name, type: 'boolean', required: true };
  }
  if (values.every((v) => typeof v === 'number')) {
    const nums = values as number[];
    const allInt = nums.every((n) => Number.isInteger(n));
    const arg: CandidateArgument = {
      name,
      type: allInt ? 'integer' : 'number',
      required: true,
    };
    // Observed min/max are DATA hints for review — not hard documented safety.
    arg.minimum = Math.min(...nums);
    arg.maximum = Math.max(...nums);
    return arg;
  }
  if (values.every((v) => typeof v === 'string')) {
    const uniq = [...new Set(values as string[])];
    const arg: CandidateArgument = { name, type: 'string', required: true };
    if (uniq.length > 0 && uniq.length <= 8) {
      arg.enumValues = uniq;
    }
    return arg;
  }
  return { name, type: 'object', required: false, description: 'Heterogeneous sample values' };
}

function mqttCapabilityId(topic: string, direction: string): string {
  return `mqtt.${direction}.${slugTopic(topic)}`;
}

function slugTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

function inferMqttDeviceClass(capabilities: CandidateCapability[]): string {
  const blob = capabilities.map((c) => `${c.id} ${(c.vendorNames ?? []).join(' ')}`).join(' ');
  if (/relay|lamp|power|switch|cmnd/i.test(blob) && /sensor|tele|temp|humid/i.test(blob)) {
    return 'composite.sensor-actuator';
  }
  if (/relay|lamp|power|switch|cmnd/i.test(blob)) {
    return 'actuator.relay';
  }
  if (/sensor|tele|temp|humid/i.test(blob)) {
    return 'sensor.environment';
  }
  return 'device.mqtt';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
