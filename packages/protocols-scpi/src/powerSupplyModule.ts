import type { CapabilityDescriptor, DeviceBackend, PinoutModuleDefinition } from '@pinout/core';
import {
  ScpiPowerSupplyBackend,
  type ScpiPowerSupplyBackendOptions,
} from './powerSupplyBackend.js';

export const scpiPowerSupplyModuleId = 'pinout/scpi-power-supply';

const emptyObject = { type: 'object' as const, additionalProperties: false, properties: {} };

const channelProperty = { type: 'integer' as const, minimum: 1 };

export const scpiPowerSupplyCapabilities: CapabilityDescriptor[] = [
  {
    name: 'psu.identify',
    description: 'Read IEEE 488.2 *IDN? identity.',
    inputSchema: emptyObject,
    outputSchema: {
      type: 'object',
      required: ['manufacturer', 'model', 'serialNumber', 'firmwareVersion'],
      properties: {
        manufacturer: { type: 'string' },
        model: { type: 'string' },
        serialNumber: { type: 'string' },
        firmwareVersion: { type: 'string' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'psu.setVoltage',
    description: 'Program the output voltage limit (:VOLT<ch>).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['volts'],
      properties: { channel: channelProperty, volts: { type: 'number' } },
    },
    outputSchema: {
      type: 'object',
      required: ['channel', 'volts'],
      properties: { channel: channelProperty, volts: { type: 'number' } },
    },
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'psu.setCurrent',
    description: 'Program the output current limit (:CURR<ch>).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['amps'],
      properties: { channel: channelProperty, amps: { type: 'number' } },
    },
    outputSchema: {
      type: 'object',
      required: ['channel', 'amps'],
      properties: { channel: channelProperty, amps: { type: 'number' } },
    },
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'psu.enableOutput',
    description: 'Enable the channel output (:OUTP<ch> ON).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { channel: channelProperty },
    },
    outputSchema: {
      type: 'object',
      required: ['channel', 'outputEnabled'],
      properties: { channel: channelProperty, outputEnabled: { type: 'boolean' } },
    },
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'psu.disableOutput',
    description: 'Disable the channel output (:OUTP<ch> OFF).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { channel: channelProperty },
    },
    outputSchema: {
      type: 'object',
      required: ['channel', 'outputEnabled'],
      properties: { channel: channelProperty, outputEnabled: { type: 'boolean' } },
    },
    safety: { physicalOutput: true, reversible: true },
  },
  {
    name: 'psu.readVoltage',
    description: 'Measure output voltage (:MEAS:VOLT<ch>?).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { channel: channelProperty },
    },
    outputSchema: {
      type: 'object',
      required: ['channel', 'volts'],
      properties: { channel: channelProperty, volts: { type: 'number' } },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'psu.readCurrent',
    description: 'Measure output current (:MEAS:CURR<ch>?).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { channel: channelProperty },
    },
    outputSchema: {
      type: 'object',
      required: ['channel', 'amps'],
      properties: { channel: channelProperty, amps: { type: 'number' } },
    },
    safety: { physicalOutput: false, reversible: true },
  },
  {
    name: 'psu.status',
    description: 'Combined commanded and measured power-supply state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { channel: channelProperty },
    },
    outputSchema: {
      type: 'object',
      required: ['channel', 'outputEnabled'],
      properties: {
        channel: channelProperty,
        outputEnabled: { type: 'boolean' },
        volts: { type: 'number' },
        amps: { type: 'number' },
      },
    },
    safety: { physicalOutput: false, reversible: true },
  },
];

export const scpiPowerSupplyModule: PinoutModuleDefinition = {
  id: scpiPowerSupplyModuleId,
  version: '0.1.0',
  deviceClass: 'supply.power',
  vendor: 'Pinout',
  model: 'SCPI Power Supply',
  capabilities: scpiPowerSupplyCapabilities,
  capabilityNames: scpiPowerSupplyCapabilities.map((capability) => capability.name),
  policies: [],
  supportedTransportKinds: ['simulated', 'loopback', 'serial', 'tcp'],
  createSimulatedBackend(options: Record<string, unknown> = {}): DeviceBackend {
    return ScpiPowerSupplyBackend.createSimulated(options as ScpiPowerSupplyBackendOptions);
  },
  createProtocolBackend(options: Record<string, unknown>): Promise<DeviceBackend> {
    return ScpiPowerSupplyBackend.create({
      ...(options as ScpiPowerSupplyBackendOptions),
      simulated: false,
    });
  },
};
