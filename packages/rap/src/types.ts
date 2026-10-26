/** RAP protocol message and toolset types (Infinity Reactive Agent Protocol). */

export interface RapToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  displayScript?: string;
}

export interface RapToolsetManifest {
  name: string;
  description?: string;
  endpoint: string;
  tools: RapToolDef[];
  needsMigration?: boolean;
}

export interface RapInvocation {
  operation: string;
  arguments: Record<string, unknown>;
  id: string;
  call_id?: string | null;
  callback_url: string;
  group_id: string;
  user_id?: string | null;
  thread_ancestors?: string[] | null;
}

export interface RapCancelToolCall {
  thread_id: string;
  tool_call_id: string;
}

export interface RapCloseThread {
  thread_id: string;
}

export interface RapToolResultCallback {
  type: 'tool_result';
  group_id: string;
  id: string;
  call_id?: string | null;
  text?: string;
  content?: Array<Record<string, unknown>>;
  display_as?: Array<Record<string, unknown>>;
  subscription?: boolean;
}

export interface RapViewUpdateCallback {
  type: 'view_update';
  group_id: string;
  view: string;
  content: Record<string, unknown>;
}

export type RapCallbackMessage = RapToolResultCallback | RapViewUpdateCallback;

export type PendingCallStatus =
  | 'accepted'
  | 'running'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface PendingCallRecord {
  key: string;
  groupId: string;
  id: string;
  callId?: string;
  callbackUrl: string;
  operation: string;
  arguments: Record<string, unknown>;
  status: PendingCallStatus;
  daemonOperationId?: string;
  resultText?: string;
  deliveryAttempts: number;
  createdAt: number;
  updatedAt: number;
  deviceIds: string[];
  leaseIds: string[];
  cancelled: boolean;
}

export interface ThreadState {
  groupId: string;
  deviceIds: string[];
  leaseIds: string[];
  pendingKeys: string[];
  closed: boolean;
}
