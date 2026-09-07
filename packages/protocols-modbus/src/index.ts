export {
  ModbusError,
  crc16,
  encodeReadRequest,
  encodeWriteSingle,
  encodeWriteMultipleCoils,
  encodeWriteMultipleRegisters,
  encodeMbap,
  decodeMbap,
  tryDecodeMbap,
  encodeRtu,
  decodeRtu,
  decodePdu,
  exceptionError,
  EXCEPTION_NAMES,
} from './wire.js';
export type { MbapFrame, ModbusFunctionCode, PduDecodeResult } from './wire.js';
export { ModbusTcpClient, type ModbusTcpOptions } from './tcpClient.js';
export { ModbusRtuClient, type ModbusRtuOptions } from './rtuClient.js';
export { createRegisterMapDevice } from './registerMap.js';
export type {
  RegisterArea,
  RegisterAccess,
  RegisterMapEntry,
  RegisterMapDevice,
  RegisterMapOptions,
} from './registerMap.js';
export {
  SimulatedModbusServer,
  createSimulatedModbusServer,
  type SimulatedModbusServerOptions,
} from './simulator.js';
export {
  ModbusLampBackend,
  createModbusLampBackend,
  validateModbusLampConfig,
  type ModbusLampConfig,
  type ValidatedModbusLampConfig,
} from './lampBackend.js';
export {
  RegisterMapDeviceBackend,
  createRegisterMapBackend,
  type RegisterMapBackendOptions,
} from './registerMapBackend.js';
