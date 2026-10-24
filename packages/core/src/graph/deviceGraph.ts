/**
 * DeviceGraph (spec v1).
 *
 * Real systems are composed: a robot cell contains an arm, a gripper, a
 * camera. The graph lets applications address components without caring which
 * vendor provides them:
 *
 *     robot-cell-01.arm.motion.move_to
 *     robot-cell-01.gripper.gripper.close
 *
 * Resolution walks child-device segments first; the remaining dotted tail is
 * the capability name (capability ids may themselves contain dots, e.g.
 * `motion.move_to`).
 */
import { PinoutStructuredError } from '../errors.js';
import type { DeviceDescriptor } from '../spec/types.js';

export interface DeviceGraphNodeInput {
  id: string;
  deviceClass: string;
  moduleId: string;
  capabilities: string[];
  simulated?: boolean;
  label?: string;
  vendor?: string;
  model?: string;
  tags?: string[];
  support?: DeviceDescriptor['support'];
  transport?: DeviceDescriptor['transport'];
}

export interface GraphQuery {
  deviceClass?: string;
  capability?: string;
  moduleId?: string;
  tag?: string;
  parent?: string;
  simulated?: boolean;
}

export interface ResolvedAddress {
  deviceId: string;
  capability: string;
  /** Device path walked, e.g. ['robot-cell-01', 'arm']. */
  path: string[];
}

export class DeviceGraph {
  private readonly nodes = new Map<string, DeviceDescriptor>();

  register(input: DeviceGraphNodeInput): DeviceDescriptor {
    if (this.nodes.has(input.id)) {
      throw new PinoutStructuredError(
        'DEVICE_ALREADY_REGISTERED',
        'DEVICE',
        `Device '${input.id}' is already registered.`,
        {
          device: input.id,
        },
      );
    }
    const descriptor: DeviceDescriptor = {
      identity: {
        id: input.id,
        moduleId: input.moduleId,
        deviceClass: input.deviceClass,
        ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
      },
      capabilities: [...input.capabilities],
      health: { status: 'UNKNOWN', lifecycle: 'connecting', lastUpdated: 0 },
      simulated: input.simulated ?? true,
      children: [],
      tags: [...(input.tags ?? [])],
      transport: input.transport ?? { kind: 'simulated' },
      support: input.support ?? 'IMPLEMENTED',
    };
    this.nodes.set(input.id, descriptor);
    return { ...descriptor };
  }

  /** Attach `childId` as a component of `parentId`. */
  link(parentId: string, childId: string): void {
    // Operate on internal storage: get()/require() return defensive copies.
    const parent = this.nodes.get(parentId);
    const child = this.nodes.get(childId);
    if (!parent || !child) {
      throw new PinoutStructuredError(
        'DEVICE_NOT_FOUND',
        'DEVICE',
        `Unknown device in link('${parentId}', '${childId}').`,
      );
    }
    if (childId === parentId) {
      throw new PinoutStructuredError(
        'GRAPH_CYCLE',
        'CONFIG',
        `Device '${parentId}' cannot be its own child.`,
      );
    }
    if (this.descendsFrom(parentId, childId)) {
      throw new PinoutStructuredError(
        'GRAPH_CYCLE',
        'CONFIG',
        `Linking '${parentId}' under '${childId}' would create a cycle.`,
      );
    }
    if (!parent.children.includes(childId)) {
      parent.children.push(childId);
    }
    child.parent = parentId;
  }

  get(id: string): DeviceDescriptor | undefined {
    const node = this.nodes.get(id);
    return node ? { ...node, children: [...node.children], tags: [...node.tags] } : undefined;
  }

  require(id: string): DeviceDescriptor {
    const node = this.get(id);
    if (!node) {
      throw new PinoutStructuredError('DEVICE_NOT_FOUND', 'DEVICE', `Unknown device '${id}'.`, {
        device: id,
      });
    }
    return node;
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  children(id: string): DeviceDescriptor[] {
    return this.require(id).children.map((childId) => this.require(childId));
  }

  /** All descendant ids, breadth-first. */
  subtree(id: string): string[] {
    const out: string[] = [];
    const queue = [...this.require(id).children];
    while (queue.length > 0) {
      const next = queue.shift()!;
      out.push(next);
      queue.push(...this.require(next).children);
    }
    return out;
  }

  /**
   * Resolve a dotted address to a device + capability.
   *
   * `robot-cell-01.arm.motion.move_to` → device `arm` (child of robot-cell-01),
   * capability `motion.move_to`. `esp-01.gpio.write` → device `esp-01`,
   * capability `gpio.write`.
   */
  resolve(address: string): ResolvedAddress {
    const segments = address.split('.').filter((s) => s.length > 0);
    if (segments.length < 2) {
      throw new PinoutStructuredError(
        'VALIDATION_ERROR',
        'VALIDATION',
        `Address '${address}' must include a device and a capability.`,
      );
    }

    const rootId = segments[0]!;
    if (!this.nodes.has(rootId)) {
      throw new PinoutStructuredError(
        'DEVICE_NOT_FOUND',
        'DEVICE',
        `Unknown root device '${rootId}' in address '${address}'.`,
        { device: rootId },
      );
    }

    let currentId = rootId;
    const path: string[] = [rootId];
    let index = 1;

    while (index < segments.length) {
      const node = this.require(currentId);
      const childId = node.children.find((child) => child === segments[index]);
      if (childId === undefined) break;
      currentId = childId;
      path.push(childId);
      index += 1;
    }

    const capability = segments.slice(index).join('.');
    if (!capability) {
      throw new PinoutStructuredError(
        'VALIDATION_ERROR',
        'VALIDATION',
        `Address '${address}' ends at device '${currentId}' with no capability.`,
      );
    }

    return { deviceId: currentId, capability, path };
  }

  query(filter: GraphQuery): DeviceDescriptor[] {
    const out: DeviceDescriptor[] = [];
    for (const node of this.nodes.values()) {
      if (filter.deviceClass && node.identity.deviceClass !== filter.deviceClass) continue;
      if (filter.moduleId && node.identity.moduleId !== filter.moduleId) continue;
      if (filter.capability && !node.capabilities.includes(filter.capability)) continue;
      if (filter.tag && !node.tags.includes(filter.tag)) continue;
      if (filter.parent !== undefined && node.parent !== filter.parent) continue;
      if (filter.simulated !== undefined && node.simulated !== filter.simulated) continue;
      out.push({ ...node, children: [...node.children], tags: [...node.tags] });
    }
    return out;
  }

  /**
   * Register or refresh a node from awareness/presence observations.
   * Updates health, support, and transport in place when the id exists.
   */
  upsert(input: DeviceGraphNodeInput): DeviceDescriptor {
    const existing = this.nodes.get(input.id);
    if (!existing) return this.register(input);
    existing.identity = {
      ...existing.identity,
      moduleId: input.moduleId,
      deviceClass: input.deviceClass,
      ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
    };
    existing.capabilities = [...input.capabilities];
    existing.simulated = input.simulated ?? existing.simulated;
    if (input.tags) existing.tags = [...input.tags];
    if (input.support) existing.support = input.support;
    if (input.transport) existing.transport = input.transport;
    return this.get(input.id)!;
  }

  updateHealth(id: string, health: Partial<DeviceDescriptor['health']>): DeviceDescriptor {
    const node = this.nodes.get(id);
    if (!node) {
      throw new PinoutStructuredError('DEVICE_NOT_FOUND', 'DEVICE', `Unknown device '${id}'.`, {
        device: id,
      });
    }
    node.health = {
      ...node.health,
      ...health,
      lastUpdated: health.lastUpdated ?? Date.now(),
    };
    return this.get(id)!;
  }

  updateSupport(id: string, support: DeviceDescriptor['support']): DeviceDescriptor {
    const node = this.nodes.get(id);
    if (!node) {
      throw new PinoutStructuredError('DEVICE_NOT_FOUND', 'DEVICE', `Unknown device '${id}'.`, {
        device: id,
      });
    }
    node.support = support;
    return this.get(id)!;
  }

  updateTransport(id: string, transport: DeviceDescriptor['transport']): DeviceDescriptor {
    const node = this.nodes.get(id);
    if (!node) {
      throw new PinoutStructuredError('DEVICE_NOT_FOUND', 'DEVICE', `Unknown device '${id}'.`, {
        device: id,
      });
    }
    node.transport = transport;
    return this.get(id)!;
  }

  private descendsFrom(ancestorId: string, candidateId: string): boolean {
    // True when `candidateId` is an ancestor of `ancestorId`.
    let current = this.nodes.get(ancestorId)?.parent;
    while (current !== undefined) {
      if (current === candidateId) return true;
      current = this.nodes.get(current)?.parent;
    }
    return false;
  }
}
