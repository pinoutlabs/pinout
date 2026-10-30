import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMoveJCommand,
  buildMoveLCommand,
  buildScript,
  buildSleepCommand,
  buildStopJCommand,
  buildStopLCommand,
  createUrScriptClient,
  createUrSimulator,
  formatPose,
  UR_DEFAULT_MOVE_ACCELERATION,
  UR_DEFAULT_MOVE_SPEED,
} from '../src/index.js';
import { expectErrorCode } from './errorAssertions.js';

const pose = { x: 0.1, y: 0, z: 0.4, rx: 0, ry: 3.14, rz: 0 };

describe('URScript builders', () => {
  it('formats movel and movej with documented defaults', () => {
    expect(UR_DEFAULT_MOVE_SPEED).toBe(0.1);
    expect(UR_DEFAULT_MOVE_ACCELERATION).toBe(1.2);
    expect(buildMoveLCommand(pose)).toBe('movel(p[0.1, 0, 0.4, 0, 3.14, 0], a=1.2, v=0.1, r=0)');
    expect(buildMoveJCommand(pose, { speed: 2, acceleration: 3, blendRadius: 0.01 })).toBe(
      'movej(p[0.1, 0, 0.4, 0, 3.14, 0], a=3, v=2, r=0.01)',
    );
    expect(formatPose(pose)).toBe('p[0.1, 0, 0.4, 0, 3.14, 0]');
  });

  it('builds stop and sleep commands', () => {
    expect(buildStopLCommand()).toBe('stopl(5)');
    expect(buildStopJCommand(2)).toBe('stopj(2)');
    expect(buildSleepCommand(0.5)).toBe('sleep(0.5)');
  });

  it('validates poses and numeric arguments', () => {
    expectErrorCode(() => buildMoveLCommand({ ...pose, y: Number.NaN }), 'UR_SCRIPT_INVALID_POSE');
    expectErrorCode(
      () => buildMoveLCommand({ ...pose, z: Number.POSITIVE_INFINITY }),
      'UR_SCRIPT_INVALID_POSE',
    );
    expectErrorCode(() => buildMoveLCommand(pose, { speed: 0 }), 'UR_SCRIPT_INVALID_ARGUMENT');
    expectErrorCode(
      () => buildMoveLCommand(pose, { blendRadius: -1 }),
      'UR_SCRIPT_INVALID_ARGUMENT',
    );
    expectErrorCode(() => buildSleepCommand(-1), 'UR_SCRIPT_INVALID_ARGUMENT');
  });

  it('joins script lines with a trailing newline', () => {
    expect(buildScript(['  set_payload(1)  ', '', 'stopl(5)'])).toBe('set_payload(1)\nstopl(5)\n');
  });
});

describe('UrScriptClient against the simulator', () => {
  const closers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it('sends lines that the simulator applies to its virtual TCP pose', async () => {
    const sim = createUrSimulator();
    const script = createUrScriptClient({ transport: sim.script });
    closers.push(script);
    await script.start();
    // The simulator starts powered off, so power on through the dashboard side.
    sim.controller.dashboardCommand('power on');

    await script.sendLine(buildMoveLCommand({ x: 0.2, y: 0.1, z: 0.5, rx: 0, ry: 0.5, rz: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sim.controller.tcp).toEqual([0.2, 0.1, 0.5, 0, 0.5, 0]);
    expect(sim.controller.motionLog).toEqual([[0.2, 0.1, 0.5, 0, 0.5, 0]]);

    await script.sendLine(buildStopLCommand(7));
    expect(sim.controller.lastStop).toMatchObject({ kind: 'stopl', acceleration: 7 });
  });

  it('records unsupported lines as simulator errors', async () => {
    const sim = createUrSimulator();
    const script = createUrScriptClient({ transport: sim.script });
    closers.push(script);
    await script.start();
    await script.sendScript(['not urscript at all', 'set_payload(1.0)']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sim.controller.scriptLog).toEqual(['not urscript at all', 'set_payload(1.0)']);
    expect(sim.controller.scriptErrors.some((entry) => /unsupported script line/.test(entry))).toBe(
      true,
    );
  });

  it('rejects motion while powered off and when a program is required', async () => {
    const sim = createUrSimulator();
    const script = createUrScriptClient({ transport: sim.script });
    closers.push(script);
    await script.start();
    await script.sendLine(buildMoveLCommand(pose));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sim.controller.scriptErrors.some((entry) => /powered off/.test(entry))).toBe(true);
    expect(sim.controller.motionLog).toHaveLength(0);

    const gatedSim = createUrSimulator({ requireProgramRunning: true });
    const gatedScript = createUrScriptClient({ transport: gatedSim.script });
    closers.push(gatedScript);
    await gatedScript.start();
    gatedSim.controller.dashboardCommand('power on');
    await gatedScript.sendLine(buildMoveLCommand(pose));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      gatedSim.controller.scriptErrors.some((entry) => /no program is playing/.test(entry)),
    ).toBe(true);
    expect(gatedSim.controller.motionLog).toHaveLength(0);
  });

  it('tracks bytes written, requires non-empty payloads, and reports closure', async () => {
    const sim = createUrSimulator();
    const script = createUrScriptClient({ transport: sim.script });
    closers.push(script);
    await script.start();
    sim.controller.dashboardCommand('power on');
    await script.sendLine('set_payload(0.5)');
    expect(script.bytesWritten).toBe('set_payload(0.5)\n'.length);
    await expect(script.sendScript('   ')).rejects.toMatchObject({ code: 'UR_SCRIPT_EMPTY' });
    await script.close();
    await expect(script.sendScript('stopl(5)')).rejects.toMatchObject({ code: 'UR_SCRIPT_CLOSED' });
  });
});
