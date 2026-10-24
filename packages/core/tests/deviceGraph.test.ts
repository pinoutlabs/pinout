import { describe, expect, it } from 'vitest';
import { DeviceGraph } from '../src/graph/deviceGraph.js';

function buildRobotCell(): DeviceGraph {
  const graph = new DeviceGraph();
  graph.register({
    id: 'robot-cell-01',
    deviceClass: 'cell',
    moduleId: 'pinout/composite',
    capabilities: ['cell.power'],
    label: 'Robot Cell 1',
    tags: ['bay-3'],
  });
  graph.register({
    id: 'arm',
    deviceClass: 'robot.manipulator',
    moduleId: 'pinout/robot-arm',
    capabilities: ['motion.home', 'motion.move_to', 'joints.read', 'pose.read'],
    vendor: 'Universal Robots',
    model: 'UR5e',
  });
  graph.register({
    id: 'gripper',
    deviceClass: 'robot.gripper',
    moduleId: 'pinout/gripper',
    capabilities: ['gripper.close', 'gripper.open', 'gripper.force'],
  });
  graph.register({
    id: 'wrist-camera',
    deviceClass: 'sensor.camera',
    moduleId: 'pinout/camera',
    capabilities: ['stream.rgb', 'snapshot'],
  });
  graph.register({
    id: 'esp-01',
    deviceClass: 'gpio',
    moduleId: 'pinout/esp32',
    capabilities: ['gpio.write', 'gpio.read'],
  });
  graph.register({
    id: 'force-sensor',
    deviceClass: 'sensor.force',
    moduleId: 'pinout/force',
    capabilities: ['force.read'],
  });
  graph.link('robot-cell-01', 'arm');
  graph.link('robot-cell-01', 'gripper');
  graph.link('robot-cell-01', 'wrist-camera');
  graph.link('arm', 'force-sensor');
  return graph;
}

describe('DeviceGraph', () => {
  it('registers devices and links composition', () => {
    const graph = buildRobotCell();
    expect(graph.get('robot-cell-01')?.children).toEqual(['arm', 'gripper', 'wrist-camera']);
    expect(graph.get('force-sensor')?.parent).toBe('arm');
    expect(graph.children('arm').map((d) => d.identity.id)).toEqual(['force-sensor']);
  });

  it('rejects duplicate registration', () => {
    const graph = new DeviceGraph();
    graph.register({ id: 'a', deviceClass: 'x', moduleId: 'm', capabilities: [] });
    expect(() =>
      graph.register({ id: 'a', deviceClass: 'x', moduleId: 'm', capabilities: [] }),
    ).toThrowError(/already registered/);
  });

  it('rejects cycles', () => {
    const graph = buildRobotCell();
    expect(() => graph.link('arm', 'robot-cell-01')).toThrowError(/cycle/);
    expect(() => graph.link('arm', 'arm')).toThrowError(/its own child/);
  });

  it('resolves dotted addresses across composition boundaries', () => {
    const graph = buildRobotCell();
    expect(graph.resolve('robot-cell-01.arm.motion.move_to')).toEqual({
      deviceId: 'arm',
      capability: 'motion.move_to',
      path: ['robot-cell-01', 'arm'],
    });
    expect(graph.resolve('robot-cell-01.gripper.gripper.close')).toEqual({
      deviceId: 'gripper',
      capability: 'gripper.close',
      path: ['robot-cell-01', 'gripper'],
    });
    expect(graph.resolve('robot-cell-01.wrist-camera.stream.rgb')).toMatchObject({
      deviceId: 'wrist-camera',
      capability: 'stream.rgb',
    });
    // Direct single-device addressing still works.
    expect(graph.resolve('esp-01.gpio.write')).toMatchObject({
      deviceId: 'esp-01',
      capability: 'gpio.write',
      path: ['esp-01'],
    });
  });

  it('prefers child-device hops over capability prefixes when both match', () => {
    const graph = buildRobotCell();
    // 'motion' is a capability prefix, not a child; 'arm' is the child.
    const resolved = graph.resolve('robot-cell-01.arm.joints.read');
    expect(resolved.deviceId).toBe('arm');
    expect(resolved.capability).toBe('joints.read');
  });

  it('resolves through multiple levels of nesting', () => {
    const graph = buildRobotCell();
    const resolved = graph.resolve('robot-cell-01.arm.force-sensor.force.read');
    expect(resolved).toEqual({
      deviceId: 'force-sensor',
      capability: 'force.read',
      path: ['robot-cell-01', 'arm', 'force-sensor'],
    });
  });

  it('throws for unknown roots and capability-less addresses', () => {
    const graph = buildRobotCell();
    expect(() => graph.resolve('ghost.gpio.write')).toThrowError(/Unknown root device 'ghost'/);
    expect(() => graph.resolve('robot-cell-01')).toThrowError(
      /must include a device and a capability/,
    );
  });

  it('queries by class, capability, module, tag, parent, and simulation', () => {
    const graph = buildRobotCell();
    expect(graph.query({ deviceClass: 'robot.manipulator' }).map((d) => d.identity.id)).toEqual([
      'arm',
    ]);
    expect(graph.query({ capability: 'motion.move_to' })).toHaveLength(1);
    expect(graph.query({ tag: 'bay-3' }).map((d) => d.identity.id)).toEqual(['robot-cell-01']);
    expect(graph.query({ parent: 'robot-cell-01' }).map((d) => d.identity.id)).toEqual([
      'arm',
      'gripper',
      'wrist-camera',
    ]);
    expect(graph.query({}).length).toBeGreaterThan(0);
    expect(graph.query({ moduleId: 'pinout/force' })).toHaveLength(1);
  });

  it('computes subtrees breadth-first', () => {
    const graph = buildRobotCell();
    expect(graph.subtree('robot-cell-01')).toEqual([
      'arm',
      'gripper',
      'wrist-camera',
      'force-sensor',
    ]);
    expect(graph.subtree('force-sensor')).toEqual([]);
  });

  it('throws DEVICE_NOT_FOUND for unknown requires()', () => {
    const graph = new DeviceGraph();
    expect(() => graph.require('nope')).toThrowError(/Unknown device 'nope'/);
  });

  it('upserts presence, health, support, and transport for awareness', () => {
    const graph = new DeviceGraph();
    graph.upsert({
      id: 'cand_1',
      deviceClass: 'microcontroller',
      moduleId: 'pinout/esp32',
      capabilities: [],
      simulated: true,
      support: 'SIMULATED',
      transport: { kind: 'serial', endpoint: '/dev/cu.mock' },
    });
    graph.updateHealth('cand_1', { status: 'CONNECTED', lifecycle: 'ready' });
    graph.updateSupport('cand_1', 'COMPILE_TESTED');
    graph.updateTransport('cand_1', { kind: 'ble', endpoint: 'aa:bb:cc:dd:ee:ff' });
    const node = graph.get('cand_1');
    expect(node?.health.status).toBe('CONNECTED');
    expect(node?.support).toBe('COMPILE_TESTED');
    expect(node?.transport.kind).toBe('ble');
    graph.upsert({
      id: 'cand_1',
      deviceClass: 'microcontroller',
      moduleId: 'pinout/esp32',
      capabilities: ['gpio.write'],
      support: 'SIMULATED',
      transport: { kind: 'serial', endpoint: '/dev/cu.mock' },
    });
    expect(graph.get('cand_1')?.capabilities).toEqual(['gpio.write']);
  });
});
