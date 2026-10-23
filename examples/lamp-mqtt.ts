/**
 * Commissioned Lamp / Plug Module Example over MQTT broker simulator.
 *
 * Demonstrates:
 * 1. Tasmota-style topic templates (cmnd/.../POWER ↔ stat/.../POWER).
 * 2. Explicit arming with documented host-loss watchdog limitation.
 * 3. Semantic actuation: lamp.on, lamp.off, lamp.status.
 * 4. Multi-stage evidence (commanded / acknowledged / observed via state topic).
 * 5. Honest disagreement via setSimulatedReadbackLevel.
 *
 * Status: SIMULATED — uses in-process MqttBrokerSimulator, not a LAN Mosquitto.
 *
 * Usage:
 *   npx tsx examples/lamp-mqtt.ts
 *   npm run demo:lamp-mqtt
 */
import { createMqttLampBackend, type MqttLampBackend } from '@pinout/protocols-mqtt';
import type { LampStatus } from '@pinout/core';

async function main(): Promise<void> {
  console.log(
    '[lamp-mqtt-example] Initializing MQTT Lamp Backend over in-process broker simulator...',
  );

  const backend: MqttLampBackend = await createMqttLampBackend({
    deviceId: 'desk_lamp',
    preset: 'tasmota',
    polarity: 'active-high',
    safeLevel: 'low',
    requireWatchdog: false,
    enableStateReadback: true,
    provenance: 'simulated',
  });

  try {
    const topics = backend.getTopicTemplates();
    console.log('\n--- Topic templates ---');
    console.log(JSON.stringify(topics, null, 2));

    const initialStatus = (await backend.invoke('lamp.status', {})) as LampStatus;
    console.log('\n--- 1. Initial Lamp Status (Disarmed at Boot) ---');
    console.log(JSON.stringify(initialStatus, null, 2));

    console.log('\n[lamp-mqtt-example] Explicitly arming lamp via lamp.arm...');
    const armResult = await backend.invoke('lamp.arm', { timeoutMs: 5000 });
    console.log(`[lamp-mqtt-example] lamp.arm result:`, armResult);

    console.log('\n[lamp-mqtt-example] Invoking lamp.on...');
    const onResult = await backend.invoke('lamp.on', {});
    console.log(`[lamp-mqtt-example] lamp.on result:`, onResult);

    const onStatus = (await backend.invoke('lamp.status', {})) as LampStatus;
    console.log('\n--- 2. Status After lamp.on ---');
    console.log(
      `Evidence breakdown:\n` +
        `  • Commanded:    ${String(onStatus.commanded.on)} (at ${String(onStatus.commanded.at)})\n` +
        `  • Acknowledged: ${String(onStatus.acknowledged.on)} (at ${String(onStatus.acknowledged.at)})\n` +
        `  • Observed:     ${String(onStatus.observed.on)} (source: ${String(onStatus.observed.source)})\n` +
        `  • Provenance:   ${String(onStatus.provenance)}\n` +
        `  • Armed:        ${String(onStatus.armed)}`,
    );

    console.log(
      '\n[lamp-mqtt-example] Simulating state-topic disagreement (device reports OFF while commanded ON)...',
    );
    backend.setSimulatedReadbackLevel(false);
    const faultStatus = (await backend.invoke('lamp.status', {})) as LampStatus;
    console.log(
      `Fault status (no auto-correction):\n` +
        `  • Commanded:    ${String(faultStatus.commanded.on)}\n` +
        `  • Acknowledged: ${String(faultStatus.acknowledged.on)}\n` +
        `  • Observed:     ${String(faultStatus.observed.on)} (disagreement preserved honestly)`,
    );

    console.log('\n[lamp-mqtt-example] Invoking lamp.off...');
    await backend.invoke('lamp.off', {});

    console.log('\n[lamp-mqtt-example] Explicitly disarming lamp via lamp.disarm...');
    const disarmResult = await backend.invoke('lamp.disarm', {});
    console.log(`[lamp-mqtt-example] lamp.disarm result:`, disarmResult);

    console.log('\n[lamp-mqtt-example] Demo completed successfully (SIMULATED).');
  } finally {
    await backend.close();
  }
}

main().catch((error) => {
  console.error('[lamp-mqtt-example] Failed:', error);
  process.exit(1);
});
