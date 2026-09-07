export { connect } from './connect.js';
export { loadPinoutConfig } from './config.js';
export { Device } from './device.js';
export { simulatedEsp32 } from './drivers/esp32/simulatedTransport.js';
export { listSerialPorts, serialPort } from './serial.js';
export { loopbackTransport, LoopbackTransport } from './transports/loopbackTransport.js';
export { tcpTransport } from './transports/tcpTransport.js';
export { udpTransport, UdpTransport, type UdpTransportOptions } from './transports/udpTransport.js';
export {
  webSocketTransport,
  type WebSocketTransportOptions,
} from './transports/webSocketTransport.js';
export {
  capabilityCatalog,
  describeCapabilities,
  describeCapability,
  firstPartyCapabilities,
  gpioAnalogReadCapability,
  gpioBatchWriteCapability,
  gpioModeCapability,
  gpioPulseCapability,
  gpioPwmCapability,
  gpioReadCapability,
  gpioStopAllCapability,
  gpioToggleCapability,
  gpioUnwatchCapability,
  gpioWatchCapability,
  gpioWriteCapability,
  i2cBeginCapability,
  i2cReadCapability,
  i2cScanCapability,
  i2cWriteCapability,
  spiBeginCapability,
  spiTransferCapability,
  gpioServoCapability,
  gpioMotorCapability,
  sysHelloCapability,
  sysInfoCapability,
  sysPingCapability,
  toAgentTools,
} from './capabilities.js';
export {
  PinoutError,
  ValidationError,
  UnsupportedCapabilityError,
  TransportError,
  TimeoutError,
  ProtocolError,
  DisconnectedError,
  DeviceError,
  AbortedError,
  PinoutStructuredError,
  toStructuredError,
  RETRYABLE_CODES,
} from './errors.js';
export type { StructuredError, ErrorCategory } from './errors.js';
export type {
  Capability,
  ActionCapability,
  SensorCapability,
  StreamCapability,
  StateCapability,
  EventCapability,
  DangerLevel,
  OperationSnapshot,
  OperationStatus,
  Lease,
  LeaseMode,
  SupportStatus,
  DeviceClass as SpecDeviceClass,
  DeviceHealthStatus,
  Unit as SpecUnit,
} from './spec/types.js';
export {
  SPEC_VERSION,
  isCompatibleSpecVersion,
  convert as convertUnit,
  toCanonical as toCanonicalUnit,
  requiresLease,
  formatIsoTimestamp,
  getTimestampMs,
  unknownEvidence,
  createEvidenceState,
  recordCommanded,
  recordAcknowledged,
  recordObserved,
  computeFreshness,
  isStale,
  hasObservedValue,
} from './spec/index.js';
export type {
  EvidenceSource,
  EvidenceProvenance,
  EvidenceValue,
  EvidenceState,
  StatePrerequisite,
  DeviceStateEvidence,
} from './spec/index.js';
export {
  PolicyError,
  PolicyConstraintViolation,
  PolicyPreconditionFailed,
  PolicyActionDenied,
} from './policy/errors.js';
export { validateInputSchema, validateOutputSchema } from './schema.js';
export {
  decodeLine,
  encodeEvent,
  encodeFailure,
  encodeRequest,
  encodeResponse,
  maxProtocolLineBytes,
  parseDeviceInfo,
  parseLine,
  protocolVersion,
} from './protocol.js';
export {
  esp32BridgeActions,
  esp32BridgeCapabilities,
  handleBridgeAction,
  esp32BridgeInfo,
  createGpioState,
  readPinLevel,
  setPinLevel,
} from './drivers/esp32/bridge.js';
export {
  assertEsp32AdcPin,
  assertEsp32AnalogPin,
  assertEsp32ModePin,
  assertEsp32PwmPin,
  assertEsp32ReadPin,
  assertEsp32WritePin,
  assertGpioMode,
  assertGpioPin,
  assertGpioValue,
  esp32AdcPins,
  esp32DefaultI2c,
  esp32DefaultLedPin,
  esp32DefaultSpi,
  esp32DevKitPins,
  esp32StrapPins,
  isEsp32StrapPin,
  maxEsp32BusPayloadBytes,
  resolveEsp32BoardPin,
} from './drivers/esp32/pins.js';
export { esp32DevKitPinMap, resolveEsp32DevKitPin } from './drivers/esp32/boardMap.js';
export { PinoutRuntime, DuplicateDeviceError, DeviceNotFoundError } from './runtime/runtime.js';
export type { PinoutRuntimeOptions } from './runtime/runtime.js';
export { createRuntimeFromConfig, type FromConfigOptions } from './runtime/fromConfig.js';
export { PINOUT_VERSION } from './version.js';
export {
  defineModule,
  type DefineModuleInput,
  type ModuleDeviceMetadata,
} from './module/defineModule.js';
export { action, sensorRead, type ActionInput } from './module/action.js';
export {
  policiesFromDeclarative,
  mergeModulePolicies,
  type DeclarativePolicyMap,
} from './module/policies.js';
export {
  runModuleConformance,
  formatConformanceReport,
  type ConformanceResult,
} from './module/conformance.js';
export {
  MODULE_MANIFEST_FILENAME,
  parseModuleManifest,
  readModuleManifestFromFile,
  type PinoutModuleManifest,
} from './module/manifest.js';
export { loadModuleFromDirectory, type LoadedModule } from './module/loadModule.js';
export {
  ModuleNotFoundError,
  ModuleAlreadyInstalledError,
  ModuleInvalidError,
  ModuleIncompatibleError,
  ModuleLoadFailedError,
  DeviceAlreadyExistsError,
  DeviceConfigInvalidError,
  DeviceBackendFailedError,
} from './module/errors.js';
export {
  ensurePinoutHome,
  installModuleFromPath,
  uninstallModule,
  inspectInstalledModule,
  readModulesIndex,
  type InstalledModuleRecord,
} from './home/moduleStore.js';
export {
  readDevicesFile,
  writeDevicesFile,
  addDeviceDefinition,
  removeDeviceDefinition,
  inspectDeviceDefinition,
  type DeviceDefinition,
  type DevicesFile,
} from './home/deviceStore.js';
export {
  resolvePinoutHome,
  resolveDevicesConfigPath,
  PINOUT_HOME_ENV,
  PINOUT_CONFIG_ENV,
} from './home/paths.js';
export {
  listAvailableModules,
  ensureModuleLoaded,
  loadAllInstalledModules,
  resetRuntimeModulesForTests,
} from './modules/registry.js';
export { DeviceInstance } from './runtime/deviceInstance.js';
export { ProtocolDeviceBackend } from './runtime/protocolBackend.js';
export {
  CompositeDeviceBackend,
  createCompositeBackend,
  createCompositeDevice,
} from './runtime/composite.js';
export type {
  CompositeBackendOptions,
  CompositeRoute,
  CreateCompositeDeviceOptions,
} from './runtime/composite.js';
export {
  createHeterogeneousRuntime,
  defaultHeterogeneousDeviceIds,
} from './runtime/createHeterogeneousRuntime.js';
export {
  createRoboticsWorkbench,
  defaultRoboticsDeviceIds,
} from './runtime/createRoboticsWorkbench.js';
export {
  AgentToolNameCollisionError,
  runtimeToAgentTools,
  deviceToRuntimeAgentTools,
  buildMcpToolName,
  parseMcpToolName,
  type RuntimeAgentTool,
} from './runtime/agentTools.js';
export { runtimeToToolDefinitions, classifyToolDanger } from './runtime/toolExport.js';
export {
  validateBoardDescriptor,
  loadBoardDescriptors,
  pinRole,
  BoardDescriptorError,
} from './boards/descriptors.js';
export type { BoardDescriptor } from './boards/descriptors.js';
export type { ToolDefinition, ToolDanger } from './runtime/toolExport.js';
export type { InvokeOptions } from './runtime/deviceInstance.js';
export { getModule, listModules, registerModule } from './modules/registry.js';
export {
  esp32Module,
  esp32ModuleId,
  createEsp32SimulatedTransport,
} from './modules/esp32Module.js';
export { robotArmModule, robotArmModuleId } from './modules/robotArmModule.js';
export { chamberModule, chamberModuleId } from './modules/chamberModule.js';
export { dcMotorModule, dcMotorModuleId } from './modules/dcMotorModule.js';
export { servoModule, servoModuleId } from './modules/servoModule.js';
export { stepperModule, stepperModuleId } from './modules/stepperModule.js';
export { distanceModule, distanceModuleId } from './modules/distanceModule.js';
export { imuModule, imuModuleId } from './modules/imuModule.js';
export { encoderModule, encoderModuleId } from './modules/encoderModule.js';
export { limitSwitchModule, limitSwitchModuleId } from './modules/limitSwitchModule.js';
export { forceModule, forceModuleId } from './modules/forceModule.js';
export { mobileBaseModule, mobileBaseModuleId } from './modules/mobileBaseModule.js';
export {
  relayModule,
  valveModule,
  pumpModule,
  powerSupplyModule,
  createSimulatedRelayBackend,
  createSimulatedValveBackend,
  createSimulatedPumpBackend,
  createSimulatedPowerSupplyBackend,
} from './modules/semanticModules.js';
export { relayModuleId } from './modules/relayModule.js';
export { valveModuleId } from './modules/valveModule.js';
export { pumpModuleId } from './modules/pumpModule.js';
export { powerSupplyModuleId } from './modules/powerSupplyModule.js';
export {
  lampModule,
  lampModuleId,
  createSimulatedLampBackend,
  createEsp32LampBackend,
  SimulatedLampBackend,
  Esp32LampBackend,
  validateLampConfig,
  lampCapabilities,
  runLampConformance,
} from './modules/lampModule.js';
export type {
  LampConfig,
  ValidatedLampConfig,
  LampStatus,
  LampPolarity,
  LampSafeLevel,
  LampArmedState,
  LampObservedSource,
  LampCommandedState,
  LampAcknowledgedState,
  LampObservedState,
  LampEvidenceBundle,
  LampBackendLike,
  LampConformanceCheck,
  LampConformanceOptions,
  LampConformanceResult,
  LampCheckStatus,
} from './modules/lampModule.js';
export {
  coffeeMachineModule,
  coffeeMachineModuleId,
  coffeeMachineSafetyRules,
} from './modules/coffeeMachineModule.js';
export {
  createSimulatedCoffeeMachineBackend,
  SimulatedCoffeeMachineBackend,
} from './modules/coffeeMachine/simulator.js';
export {
  createEsp32CoffeeMachineBackend,
  Esp32CoffeeMachineBackend,
  type Esp32CoffeeMachineOptions,
} from './modules/coffeeMachine/esp32Backend.js';
export { createSimulatedRobotArmBackend } from './modules/robotArm/simulator.js';
export { createSimulatedChamberBackend } from './modules/chamber/simulator.js';
export { createSimulatedDcMotorBackend } from './modules/dcMotor/simulator.js';
export { createSimulatedServoBackend } from './modules/servo/simulator.js';
export { createSimulatedStepperBackend } from './modules/stepper/simulator.js';
export { createSimulatedDistanceBackend } from './modules/distance/simulator.js';
export { createSimulatedImuBackend } from './modules/imu/simulator.js';
export { createSimulatedEncoderBackend } from './modules/encoder/simulator.js';
export { createSimulatedLimitSwitchBackend } from './modules/limitSwitch/simulator.js';
export { createSimulatedForceBackend } from './modules/force/simulator.js';
export { createSimulatedMobileBaseBackend } from './modules/mobileBase/simulator.js';
export { evaluatePolicies } from './policy/engine.js';
export { SafetyEngine, mergeModuleAndDeploymentRules } from './policy/safety.js';
export type {
  SafetyRule,
  RateRule,
  InterlockRule,
  SequenceRule,
  ApprovalRule,
  LeaseRule,
  DeadmanRule,
  ResourceRule,
  ConstraintConflict,
  ApprovalRecord,
} from './policy/safety.js';
export {
  OperationManager,
  isTerminalOperationStatus,
  StopUnconfirmedError,
} from './operation/operationManager.js';
export { BoundedIdempotencyStore } from './operation/idempotencyStore.js';
export type {
  IdempotencyStoreOptions,
  IdempotencyTombstone,
  IdempotencyLookup,
} from './operation/idempotencyStore.js';
export type {
  OperationHandle,
  OperationRunContext,
  BeginOperationOptions,
  OperationBeginResult,
  ReconciliationResolution,
  ReconciliationRecord,
  ReconcileOptions,
  ExtendedOperationStatus,
} from './operation/operationManager.js';
export { LeaseManager } from './lease/leaseManager.js';
export type {
  LeaseScopeInput,
  AcquireLeaseOptions,
  LeaseConflictDetails,
} from './lease/leaseManager.js';
export { HaltCoordinator, safetyStateEventName } from './halt/haltCoordinator.js';
export type { SafetyStateName, SafetyStateChange, HaltVerdict } from './halt/haltCoordinator.js';
export { DeviceGraph } from './graph/deviceGraph.js';
export type { DeviceGraphNodeInput, GraphQuery, ResolvedAddress } from './graph/deviceGraph.js';
export {
  Journal,
  MemoryJournalStorage,
  FileJournalStorage,
  loadJournalEntries,
  redactPayload,
} from './journal/journal.js';
export { buildReplaySession, replayJournal, formatReplaySession } from './journal/replay.js';
export type { ReplaySession, ReplayTimelineEntry, ReplayHandler } from './journal/replay.js';
export type {
  JournalEntry,
  JournalEntryKind,
  JournalQuery,
  JournalStorage,
  JournalOptions,
} from './journal/journal.js';
export {
  vector3,
  quaternion,
  quaternionFromAxisAngle,
  quaternionMultiply,
  quaternionConjugate,
  pose,
  frameReference,
  makeTransform,
  rotateVector,
  applyTransform,
  composeTransforms,
  invertTransform,
  transformChain,
  transformFrameReference,
} from './frames/frames.js';
export { StreamBus } from './stream/streamBus.js';
export type {
  StreamDescriptor,
  StreamFrame,
  StreamHandle,
  StreamStats,
  BackpressurePolicy,
  SubscribeOptions,
} from './stream/streamBus.js';

export type {
  Transport,
  ConnectOptions,
  CapabilityDescriptor,
  CapabilitySafety,
  DeviceEventHandler,
  DeviceInfo,
  AgentTool,
  JsonSchema,
  RequestOptions,
} from './types.js';
export type {
  DeviceClass,
  DeviceIdentity,
  DeviceHealth,
  DeviceDescriptor,
  DeviceSummary,
  DeviceLifecycleStatus,
  RuntimeEventEnvelope,
  RuntimeEventHandler,
  PinoutModuleDefinition,
  RegisterModuleDeviceOptions,
  DeviceBackend,
  BackendInvocationContext,
} from './runtime/types.js';
export type { PolicyRule, PolicyContext } from './policy/types.js';
export type { LogContext, LogLevel, Logger } from './logger.js';
export type { PinoutEnvConfig } from './config.js';
