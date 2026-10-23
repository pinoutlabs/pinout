/**
 * Declarative MQTT mapping (spec v1).
 *
 * topic → state/event ingestion, and capability → publish actions. Writes
 * always require an explicit `publish` entry; topics without a mapping never
 * become capabilities.
 */
import { MqttError } from './errors.js';

export interface TopicIngestRule {
  /** MQTT topic filter or exact topic, e.g. `plant/line1/temp`. */
  topic: string;
  /** Where the observation goes: a state field or an event name. */
  as: { kind: 'state'; field: string; unit?: string } | { kind: 'event'; event: string };
  /** Payload codec: json (extract `field`), raw-text number, or plain string. */
  codec?: 'json' | 'number' | 'text';
  /** For codec 'json': the key to extract. */
  jsonField?: string;
}

export interface PublishRule {
  /** Capability id exposed to the runtime, e.g. `pump.start`. */
  capability: string;
  topic: string;
  /**
   * Payload template when `codec` is omitted or `'template'`.
   * `{value}` interpolates the invoke arg `value`. Ignored when `codec` is `'json'`.
   */
  payload: string;
  qos?: 0 | 1;
  /**
   * `template` (default): interpolate `{arg}` placeholders in `payload`.
   * `json`: publish `JSON.stringify(args)` and ignore `payload` (use `''`).
   */
  codec?: 'template' | 'json';
}

export interface MqttMapping {
  ingests: TopicIngestRule[];
  publishes: PublishRule[];
}

export interface MappedIngestion {
  rule: TopicIngestRule;
  value: number | string | boolean | Record<string, unknown>;
}

export function decodeIngestion(rule: TopicIngestRule, payload: Buffer): MappedIngestion {
  const text = payload.toString('utf8');
  switch (rule.codec ?? 'text') {
    case 'number': {
      const value = Number(text);
      if (!text.trim() || !Number.isFinite(value)) {
        throw new MqttError(
          'MQTT_PAYLOAD_NOT_NUMBER',
          `Topic '${rule.topic}' payload '${text}' is not a finite number.`,
        );
      }
      return { rule, value };
    }
    case 'json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new MqttError(
          'MQTT_PAYLOAD_NOT_JSON',
          `Topic '${rule.topic}' payload is not valid JSON.`,
        );
      }
      if (rule.jsonField !== undefined) {
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          !Object.hasOwn(parsed, rule.jsonField)
        ) {
          throw new MqttError(
            'MQTT_PAYLOAD_FIELD_MISSING',
            `Payload must contain field '${rule.jsonField}'.`,
          );
        }
        const field = (parsed as Record<string, unknown>)[rule.jsonField];
        return { rule, value: field as number | string | boolean | Record<string, unknown> };
      }
      return { rule, value: parsed as Record<string, unknown> };
    }
    default:
      return { rule, value: text };
  }
}

export function encodePublishPayload(rule: PublishRule, args: Record<string, unknown>): string {
  if (rule.codec === 'json') {
    return JSON.stringify(args);
  }
  return rule.payload.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = args[key];
    if (value === undefined) {
      throw new MqttError(
        'MQTT_PAYLOAD_ARG_MISSING',
        `Publish rule for '${rule.capability}' requires argument '${key}'.`,
      );
    }
    return String(value);
  });
}

/** Topic prefix for the local ESP32 Wi-Fi/MQTT bridge contract. */
export function esp32MqttTopicPrefix(deviceId: string): string {
  return `pinout/esp32/${deviceId}`;
}

/** Match an exact topic or single-level (+) filters against a topic. */
export function topicMatches(filter: string, topic: string): boolean {
  if (topic.startsWith('$') && !filter.startsWith('$')) return false;
  if (filter === topic) return true;
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');
  let i = 0;
  for (; i < filterParts.length; i += 1) {
    const part = filterParts[i]!;
    if (part === '#') return i === filterParts.length - 1;
    if (i >= topicParts.length) return false;
    if (part === '+') continue;
    if (part !== topicParts[i]) return false;
  }
  return i === topicParts.length;
}
