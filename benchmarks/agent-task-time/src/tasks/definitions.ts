import { getProfile } from '../devices/profiles.js';
import type { CheckerResult, DeviceSnapshot, ProfileId, TaskDefinition, TaskId } from '../types.js';

const targetServoAngle = 90;
const returnServoAngle = 0;

export const taskDefinitions: Record<TaskId, TaskDefinition> = {
  blinkLed: {
    id: 'blinkLed',
    title: 'Blink LED',
    intent: 'Drive the board LED pin high then low so a blink is observable in device state.',
    profiles: ['esp32', 'pico', 'uno'],
    buildPrompt(profileId) {
      const profile = getProfile(profileId);
      return [
        `Task: blink the onboard/status LED on ${profile.displayName} (SIMULATED).`,
        `Use GPIO pin ${profile.ledPin}.`,
        'Success criteria (checked automatically against device GPIO state/journal, not your claim):',
        `- Pin ${profile.ledPin} must have been driven HIGH at least once.`,
        `- Pin ${profile.ledPin} must have been driven LOW at least once after a HIGH (a blink cycle).`,
        'Arm the device before driving outputs if the protocol requires it.',
        'When finished, stop. Do not invent hardware results.',
      ].join('\n');
    },
    checkSuccess: checkBlinkLed,
  },
  servoSweep: {
    id: 'servoSweep',
    title: 'Servo sweep',
    intent: 'Sweep a servo to a target angle and back within the safe 0-180 range.',
    profiles: ['esp32', 'pico', 'uno'],
    buildPrompt(profileId) {
      const profile = getProfile(profileId);
      return [
        `Task: sweep a servo on ${profile.displayName} (SIMULATED).`,
        `Use servo/PWM pin ${profile.servoPin}.`,
        `Move the servo to ${targetServoAngle} degrees, then back to ${returnServoAngle} degrees.`,
        'Stay within the safe range 0-180 degrees.',
        'Success criteria (automatic checker on device servo journal/state):',
        `- Pin ${profile.servoPin} must record angle ${targetServoAngle} at least once.`,
        `- Pin ${profile.servoPin} must later record angle ${returnServoAngle}.`,
        'Arm the device before commanding the servo if required.',
      ].join('\n');
    },
    checkSuccess: checkServoSweep,
  },
  readSensor: {
    id: 'readSensor',
    title: 'Read sensor',
    intent: 'Read an ADC/sensor pin and obtain a numeric sample from the device.',
    profiles: ['esp32', 'pico', 'uno'],
    buildPrompt(profileId) {
      const profile = getProfile(profileId);
      return [
        `Task: read a sensor (ADC) value on ${profile.displayName} (SIMULATED).`,
        `Use ADC pin ${profile.adcPin} (adcMax=${profile.adcMax}).`,
        'Success criteria (automatic checker on device journal):',
        `- A gpio.analogRead (or equivalent) for pin ${profile.adcPin} must appear in the device journal with a numeric value.`,
        'Report the numeric reading in your final message, but only the device journal counts for success.',
      ].join('\n');
    },
    checkSuccess: checkReadSensor,
  },
};

export function getTask(taskId: TaskId): TaskDefinition {
  return taskDefinitions[taskId];
}

export function checkBlinkLed(snapshot: DeviceSnapshot, profileId: ProfileId): CheckerResult {
  const profile = getProfile(profileId);
  const pin = profile.ledPin;
  const events = snapshot.journal.filter(
    (entry) => entry.kind === 'gpio.level' && entry.pin === pin,
  );
  const sawHigh = events.some((entry) => entry.value === true);
  const highIndex = events.findIndex((entry) => entry.value === true);
  const sawLowAfter =
    highIndex >= 0 && events.slice(highIndex + 1).some((entry) => entry.value === false);

  const success = sawHigh && sawLowAfter;
  return {
    success,
    reason: success
      ? `LED pin ${pin} blinked HIGH then LOW in the SIMULATED journal.`
      : `LED pin ${pin} did not complete a HIGH then LOW blink in the journal (sawHigh=${sawHigh}, sawLowAfter=${sawLowAfter}).`,
    observed: {
      pin,
      eventCount: events.length,
      events: events.map((entry) => ({ atMs: entry.atMs, value: entry.value })),
      finalLevel: snapshot.levels[String(pin)] ?? null,
    },
  };
}

export function checkServoSweep(snapshot: DeviceSnapshot, profileId: ProfileId): CheckerResult {
  const profile = getProfile(profileId);
  const pin = profile.servoPin;
  const events = snapshot.journal.filter(
    (entry) => entry.kind === 'gpio.servo' && entry.pin === pin,
  );
  const targetIndex = events.findIndex((entry) => entry.value === targetServoAngle);
  const returned =
    targetIndex >= 0 &&
    events.slice(targetIndex + 1).some((entry) => entry.value === returnServoAngle);
  const success = targetIndex >= 0 && returned;
  return {
    success,
    reason: success
      ? `Servo pin ${pin} swept to ${targetServoAngle} then back to ${returnServoAngle}.`
      : `Servo pin ${pin} did not sweep to ${targetServoAngle} and back to ${returnServoAngle}.`,
    observed: {
      pin,
      eventCount: events.length,
      events: events.map((entry) => ({ atMs: entry.atMs, value: entry.value })),
      finalAngle: snapshot.servos[String(pin)] ?? null,
      targetServoAngle,
      returnServoAngle,
    },
  };
}

export function checkReadSensor(snapshot: DeviceSnapshot, profileId: ProfileId): CheckerResult {
  const profile = getProfile(profileId);
  const pin = profile.adcPin;
  const events = snapshot.journal.filter(
    (entry) => entry.kind === 'gpio.analogRead' && entry.pin === pin && typeof entry.value === 'number',
  );
  const success = events.length > 0;
  return {
    success,
    reason: success
      ? `ADC pin ${pin} produced ${events.length} numeric sample(s) in the SIMULATED journal.`
      : `No numeric gpio.analogRead journal entry for ADC pin ${pin}.`,
    observed: {
      pin,
      eventCount: events.length,
      samples: events.map((entry) => ({ atMs: entry.atMs, value: entry.value })),
      seededAnalogValue: profile.seededAnalogValue,
      analogLevels: snapshot.analogLevels,
    },
  };
}
