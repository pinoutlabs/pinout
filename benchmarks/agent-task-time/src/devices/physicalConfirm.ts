import * as readline from 'node:readline';
import type { PhysicalConfirmRecord, TaskId } from '../types.js';

export interface PhysicalConfirmDeps {
  ask: (prompt: string) => Promise<string>;
}

export function buildPhysicalConfirmPrompt(taskId: TaskId, profileLabel: string): string {
  if (taskId === 'blinkLed') {
    return `[REAL_HARDWARE] Did you observe the LED blink on ${profileLabel}? (yes/no): `;
  }
  if (taskId === 'servoSweep') {
    return `[REAL_HARDWARE] Did you observe the servo sweep to ~90 deg and back on ${profileLabel}? (yes/no): `;
  }
  return `[REAL_HARDWARE] Did the sensor/ADC path look plausible on ${profileLabel}? (yes/no): `;
}

export async function promptPhysicalConfirm(options: {
  taskId: TaskId;
  profileLabel: string;
  enabled: boolean;
  deps?: PhysicalConfirmDeps;
}): Promise<PhysicalConfirmRecord> {
  const promptText = buildPhysicalConfirmPrompt(options.taskId, options.profileLabel);
  if (!options.enabled) {
    return { prompted: false, promptText, operatorAnswer: 'skipped' };
  }
  const ask = options.deps?.ask ?? defaultAsk;
  const raw = (await ask(promptText)).trim().toLowerCase();
  const answer = raw === 'y' || raw === 'yes' ? 'yes' : raw === 'n' || raw === 'no' ? 'no' : 'skipped';
  return { prompted: true, promptText, operatorAnswer: answer };
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
