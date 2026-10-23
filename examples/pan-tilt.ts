/**
 * Commissioned pan-tilt desk mount example (simulated).
 *
 * Demonstrates:
 * 1. One or two hobby servos with commissioned angle limits and safe angles.
 * 2. Explicit arming (`panTilt.arm`) before motion.
 * 3. `panTilt.setAngles` / `panTilt.setAngle` within limits.
 * 4. Honest status: commanded/acknowledged without fake observed position.
 * 5. `panTilt.disarm` → safe angles, then actuation blocked.
 *
 * Evidence: SIMULATED. Physical ESP32 PWM uses firmware `gpio.servo`
 * (COMPILE_TESTED only; no HIL claim in this example).
 *
 * Usage:
 *   npx tsx examples/pan-tilt.ts
 */
import { PinoutRuntime, panTiltModuleId } from '@pinout/core';

async function main(): Promise<void> {
  const runtime = new PinoutRuntime();
  const deviceId = 'desk-pan-tilt-01';

  try {
    await runtime.registerFromModule(panTiltModuleId, {
      id: deviceId,
      simulated: true,
      backendOptions: {
        pan: { pin: 13, minAngle: 0, maxAngle: 180, safeAngle: 90 },
        tilt: { pin: 14, minAngle: 20, maxAngle: 160, safeAngle: 90 },
      },
    });

    console.log('[pan-tilt] Initial status (disarmed):');
    console.log(JSON.stringify(await runtime.invoke(deviceId, 'panTilt.status', {}), null, 2));

    console.log('\n[pan-tilt] Arming...');
    console.log(await runtime.invoke(deviceId, 'panTilt.arm', { timeoutMs: 5000 }));

    console.log('\n[pan-tilt] setAngles pan=45 tilt=60...');
    console.log(await runtime.invoke(deviceId, 'panTilt.setAngles', { pan: 45, tilt: 60 }));

    console.log('\n[pan-tilt] Status after move:');
    const status = await runtime.invoke(deviceId, 'panTilt.status', {});
    console.log(JSON.stringify(status, null, 2));
    console.log(
      `Evidence: commanded pan=${String(status.commanded.pan)} ack=${String(status.acknowledged.pan)} observed=${String(status.observed.source)}`,
    );

    console.log('\n[pan-tilt] Disarm (safe angles)...');
    console.log(await runtime.invoke(deviceId, 'panTilt.disarm', {}));
    console.log(JSON.stringify(await runtime.invoke(deviceId, 'panTilt.status', {}), null, 2));

    console.log('\n[pan-tilt] Demo completed (SIMULATED).');
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error('[pan-tilt] Failed:', error);
  process.exit(1);
});
