/**
 * Declarative topic templates for home Wi-Fi lamps/plugs (Tasmota / Shelly style).
 *
 * Builds an {@link MqttMapping} so command publishes and state ingestion stay
 * explicit — topics without a mapping never become capabilities.
 */
import type { MqttMapping } from './mapping.js';

/** Well-known firmware topic layouts for local-home MQTT devices. */
export type MqttLampPreset = 'tasmota' | 'shelly' | 'custom';

export interface MqttLampTopicTemplates {
  /** Device identifier interpolated into topic templates (`{deviceId}`). */
  deviceId: string;
  /**
   * Preset layout. Defaults to `tasmota`.
   * - tasmota: `cmnd/{deviceId}/POWER` ↔ `stat/{deviceId}/POWER` with ON/OFF
   * - shelly: `shellies/{deviceId}/relay/0/command` ↔ `shellies/{deviceId}/relay/0` with on/off
   * - custom: require explicit commandTopic / stateTopic
   */
  preset?: MqttLampPreset;
  /** Command topic template; may include `{deviceId}`. */
  commandTopic?: string;
  /** State / status topic template (subscribed for observed evidence). */
  stateTopic?: string;
  /** Payload meaning energized / on. */
  onPayload?: string;
  /** Payload meaning de-energized / off. */
  offPayload?: string;
  /** MQTT QoS for command publishes (0 or 1). Default 0. */
  qos?: 0 | 1;
}

export interface ResolvedMqttLampTopics {
  deviceId: string;
  preset: MqttLampPreset;
  commandTopic: string;
  stateTopic: string;
  onPayload: string;
  offPayload: string;
  qos: 0 | 1;
}

const presetDefaults: Record<
  Exclude<MqttLampPreset, 'custom'>,
  { commandTopic: string; stateTopic: string; onPayload: string; offPayload: string }
> = {
  tasmota: {
    commandTopic: 'cmnd/{deviceId}/POWER',
    stateTopic: 'stat/{deviceId}/POWER',
    onPayload: 'ON',
    offPayload: 'OFF',
  },
  shelly: {
    commandTopic: 'shellies/{deviceId}/relay/0/command',
    stateTopic: 'shellies/{deviceId}/relay/0',
    onPayload: 'on',
    offPayload: 'off',
  },
};

function interpolateTopic(template: string, deviceId: string): string {
  return template.replace(/\{deviceId\}/g, deviceId);
}

/**
 * Resolve topic templates for a home lamp/plug.
 * Empty config yields a simulated Tasmota-style device id `lamp1`.
 */
export function resolveMqttLampTopics(
  rawConfig: Partial<MqttLampTopicTemplates> & Record<string, unknown> = {},
): ResolvedMqttLampTopics {
  const deviceId =
    typeof rawConfig.deviceId === 'string' && rawConfig.deviceId.trim().length > 0
      ? rawConfig.deviceId.trim()
      : 'lamp1';

  const preset: MqttLampPreset =
    rawConfig.preset === 'shelly' || rawConfig.preset === 'custom' || rawConfig.preset === 'tasmota'
      ? rawConfig.preset
      : 'tasmota';

  const defaults =
    preset === 'custom'
      ? {
          commandTopic: undefined as string | undefined,
          stateTopic: undefined as string | undefined,
          onPayload: 'ON',
          offPayload: 'OFF',
        }
      : presetDefaults[preset];

  const commandTemplate =
    typeof rawConfig.commandTopic === 'string' ? rawConfig.commandTopic : defaults.commandTopic;
  const stateTemplate =
    typeof rawConfig.stateTopic === 'string' ? rawConfig.stateTopic : defaults.stateTopic;

  if (!commandTemplate || !stateTemplate) {
    throw new Error(
      'MQTT lamp custom preset requires both "commandTopic" and "stateTopic" templates.',
    );
  }

  const onPayload =
    typeof rawConfig.onPayload === 'string' ? rawConfig.onPayload : (defaults.onPayload ?? 'ON');
  const offPayload =
    typeof rawConfig.offPayload === 'string'
      ? rawConfig.offPayload
      : (defaults.offPayload ?? 'OFF');

  const qos = rawConfig.qos === 1 ? 1 : 0;

  return {
    deviceId,
    preset,
    commandTopic: interpolateTopic(commandTemplate, deviceId),
    stateTopic: interpolateTopic(stateTemplate, deviceId),
    onPayload,
    offPayload,
    qos,
  };
}

/**
 * Declarative mapping used by the MQTT lamp backend:
 * - ingest state topic → operational field `on` (text payload)
 * - publish capability `lamp.power` → command topic with `{value}` payload
 *
 * Semantic capabilities (`lamp.on` / `lamp.off` / `lamp.set`) are gated by the
 * backend and encode ON/OFF into this publish rule — they are not free-form
 * bridge publishes.
 */
export function buildMqttLampMapping(topics: ResolvedMqttLampTopics): MqttMapping {
  return {
    ingests: [
      {
        topic: topics.stateTopic,
        as: { kind: 'state', field: 'on' },
        codec: 'text',
      },
    ],
    publishes: [
      {
        capability: 'lamp.power',
        topic: topics.commandTopic,
        payload: '{value}',
        qos: topics.qos,
      },
    ],
  };
}

/** Parse a device state payload into on/off; returns undefined if unrecognized. */
export function parseMqttLampPayload(
  text: string,
  onPayload: string,
  offPayload: string,
): boolean | undefined {
  const trimmed = text.trim();
  if (trimmed.localeCompare(onPayload, undefined, { sensitivity: 'base' }) === 0) {
    return true;
  }
  if (trimmed.localeCompare(offPayload, undefined, { sensitivity: 'base' }) === 0) {
    return false;
  }
  const upper = trimmed.toUpperCase();
  if (upper === 'ON' || upper === '1' || upper === 'TRUE') return true;
  if (upper === 'OFF' || upper === '0' || upper === 'FALSE') return false;
  return undefined;
}
