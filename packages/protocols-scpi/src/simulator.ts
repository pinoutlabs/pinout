import { loopbackTransport, type LoopbackTransport } from '@pinout/core';
import { parseScpiCommand } from './parser.js';

export interface ScpiPsuChannelState {
  voltage: number;
  current: number;
  outputEnabled: boolean;
}

export interface ScpiPsuSimulatorOptions {
  /** `*IDN?` response (manufacturer,model,serial,firmware). */
  identity?: string;
  /** Number of 1-based channels to pre-create (default 2). */
  channelCount?: number;
}

/**
 * Stateful in-process SCPI power-supply responder over a loopback transport.
 *
 * Handles at least: `*IDN?`, `:VOLT<ch>`, `:CURR<ch>`, `:OUTP<ch> ON|OFF`,
 * `:MEAS:VOLT<ch>?`, `:MEAS:CURR<ch>?`, `:MEAS:POW<ch>?`, `*RST`.
 * Mnemonics are parsed leniently via {@link parseScpiCommand}.
 */
export class ScpiPsuSimulator {
  readonly transport: LoopbackTransport;
  readonly identity: string;
  private readonly channels = new Map<number, ScpiPsuChannelState>();

  constructor(options: ScpiPsuSimulatorOptions = {}) {
    this.identity = options.identity ?? 'Pinout,SimulatedPSU,SIM-001,0.1';
    const channelCount = options.channelCount ?? 2;
    for (let channel = 1; channel <= channelCount; channel += 1) {
      this.channels.set(channel, defaultChannelState());
    }
    this.transport = loopbackTransport({
      onWrite: (data) => this.handleWrite(data),
    });
  }

  getChannel(channel: number): ScpiPsuChannelState {
    return this.ensureChannel(channel);
  }

  private handleWrite(data: string): string | undefined {
    const line = data.replace(/\r?\n$/, '').trim();
    if (line.length === 0) {
      return undefined;
    }
    let parsed;
    try {
      parsed = parseScpiCommand(line);
    } catch {
      return undefined;
    }
    const pathKey = parsed.path.join(':');
    const channel = parsed.channel ?? 1;
    const state = this.ensureChannel(channel);

    if (parsed.query && parsed.path[0] === '*IDN') {
      return this.identity;
    }
    if (!parsed.query && parsed.path[0] === '*RST') {
      for (const entry of this.channels.values()) {
        entry.voltage = 0;
        entry.current = 0;
        entry.outputEnabled = false;
      }
      return undefined;
    }
    if (!parsed.query && pathKey === 'VOLTAGE') {
      const volts = asFiniteNumber(parsed.args[0]);
      if (volts !== undefined) {
        state.voltage = volts;
      }
      return undefined;
    }
    if (!parsed.query && pathKey === 'CURRENT') {
      const amps = asFiniteNumber(parsed.args[0]);
      if (amps !== undefined) {
        state.current = amps;
      }
      return undefined;
    }
    if (!parsed.query && pathKey === 'OUTPUT') {
      state.outputEnabled = asOnOff(parsed.args[0]);
      return undefined;
    }
    if (parsed.query && pathKey === 'MEASURE:VOLTAGE') {
      return formatMeasured(state.outputEnabled ? state.voltage : 0);
    }
    if (parsed.query && pathKey === 'MEASURE:CURRENT') {
      return formatMeasured(0);
    }
    if (parsed.query && pathKey === 'MEASURE:POWER') {
      const volts = state.outputEnabled ? state.voltage : 0;
      return formatMeasured(volts * 0);
    }
    if (parsed.query && pathKey === 'OUTPUT') {
      return state.outputEnabled ? '1' : '0';
    }
    return undefined;
  }

  private ensureChannel(channel: number): ScpiPsuChannelState {
    const existing = this.channels.get(channel);
    if (existing) {
      return existing;
    }
    const created = defaultChannelState();
    this.channels.set(channel, created);
    return created;
  }
}

export function createScpiPsuSimulator(options: ScpiPsuSimulatorOptions = {}): ScpiPsuSimulator {
  return new ScpiPsuSimulator(options);
}

function defaultChannelState(): ScpiPsuChannelState {
  return { voltage: 0, current: 0, outputEnabled: false };
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asOnOff(value: unknown): boolean {
  if (value === true || value === 1 || value === 'ON' || value === 'on') {
    return true;
  }
  if (typeof value === 'string' && value.toUpperCase() === 'ON') {
    return true;
  }
  return false;
}

function formatMeasured(value: number): string {
  return String(value);
}
