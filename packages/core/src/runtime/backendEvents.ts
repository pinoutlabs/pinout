/**
 * Shared subscribe/emit helper for DeviceBackend implementations.
 * Keeps multi-device and composite backends from re-implementing the same bus.
 */
export type BackendEventHandler = (event: string, payload: Record<string, unknown>) => void;

export interface BackendEventBus {
  subscribe(handler: BackendEventHandler): () => void;
  emit(event: string, payload: Record<string, unknown>): void;
  clear(): void;
  readonly size: number;
}

export function createBackendEventBus(): BackendEventBus {
  const listeners = new Set<BackendEventHandler>();
  return {
    subscribe(handler: BackendEventHandler): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    emit(event: string, payload: Record<string, unknown>): void {
      for (const listener of listeners) {
        listener(event, payload);
      }
    },
    clear(): void {
      listeners.clear();
    },
    get size(): number {
      return listeners.size;
    },
  };
}
