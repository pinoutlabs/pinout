export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  additionalProperties?: boolean;
}

export interface CapabilitySafety {
  physicalOutput: boolean;
  reversible: boolean;
  notes?: string;
}

export interface CapabilityDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  safety: CapabilitySafety;
}

export interface DeviceInfo {
  boardId?: string;
  firmware: string;
  version: string;
  protocol: number;
  capabilities: string[];
  features?: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: CapabilitySafety;
}

export interface Transport {
  readonly kind: string;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  readonly readable: AsyncIterable<Uint8Array>;
}

export type DeviceEventHandler = (payload: Record<string, unknown>) => void;

export interface ConnectOptions {
  transport: Transport;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
