import { createHash } from 'node:crypto';
import {
  boardForInfo,
  connect,
  esp32Module,
  listSerialPorts,
  ProtocolDeviceBackend,
  serialPort,
  type PinoutRuntime,
  type SerialPortInfo,
  type Transport,
} from '@pinout/core';

export interface BoardDiscoveryOptions {
  listPorts?: () => Promise<SerialPortInfo[]>;
  transport?: (port: SerialPortInfo) => Transport;
  log?: (message: string) => void;
  /** Already configured ports are owned by the normal registry. */
  excludedPaths?: string[];
}

/** Explicit --discover opt-in: serial opening may reset boards. Never flashes firmware. */
export class BoardDiscovery {
  private readonly attached = new Map<string, { id: string; backend: ProtocolDeviceBackend }>();
  private readonly retryAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pending: Promise<void> | undefined;
  constructor(
    private readonly runtime: PinoutRuntime,
    private readonly options: BoardDiscoveryOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.scan();
    this.schedule();
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    for (const { id } of this.attached.values()) await this.runtime.unregister(id);
    this.attached.clear();
  }
  scan(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.scanOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.scan()
        .catch((e) => this.options.log?.(String(e)))
        .finally(() => this.schedule());
    }, 2000);
  }
  private async scanOnce(): Promise<void> {
    const ports = await (this.options.listPorts ?? listSerialPorts)();
    const canonical = (path: string) => path.replace('/dev/tty.', '/dev/cu.');
    const paths = new Set(ports.map((p) => canonical(p.path)));
    for (const [path, entry] of this.attached) {
      let present = paths.has(path);
      if (present) {
        try {
          await entry.backend.getDevice().invoke('sys.ping');
        } catch {
          present = false;
        }
      }
      if (!present) {
        await this.runtime.unregister(entry.id);
        this.attached.delete(path);
        this.options.log?.(
          `Disconnected ${entry.id}; outputs require explicit re-arming after reconnect.`,
        );
      }
    }
    for (const original of ports) {
      if (this.stopped) return;
      const path = canonical(original.path);
      if (this.attached.has(path) || this.options.excludedPaths?.some((p) => canonical(p) === path))
        continue;
      // USB adapters are candidates, never proof of board identity.
      if (
        !['2341', '2a03', '303a', '10c4', '1a86', '0403'].includes(
          (original.vendorId ?? '').toLowerCase(),
        )
      )
        continue;
      if ((this.retryAt.get(path) ?? 0) > Date.now()) continue;
      this.retryAt.set(path, Date.now() + 15000);
      const port = { ...original, path };
      let device;
      try {
        const transport =
          this.options.transport?.(port) ?? serialPort({ path, resetOnConnect: false });
        device = await connect({ transport, timeoutMs: 2500 });
        if (!device.info.boardId || !['esp32-bridge', 'uno-bridge'].includes(device.info.firmware))
          throw new Error(
            'Flash the matching Pinout bridge first; firmware must advertise boardId.',
          );
        const board = boardForInfo(device.info)!;
        const backend = new ProtocolDeviceBackend(device, { requireWatchdog: true });
        // Never inherit an armed session from a previous process.
        await backend.disarm();
        const suffix = createHash('sha256')
          .update(`${port.vendorId}:${port.productId}:${port.serialNumber ?? path}`)
          .digest('hex')
          .slice(0, 10);
        const id = `${board.boardId}-${suffix}`;
        await this.runtime.registerModuleDevice(
          {
            ...esp32Module,
            id: 'pinout/board',
            vendor: board.family === 'avr' ? 'Arduino' : 'Espressif',
            model: board.boardId,
            createProtocolBackend: async () => backend,
          },
          { id, simulated: false, transport, backendOptions: {} },
        );
        this.attached.set(path, { id, backend });
        this.options.log?.(`Connected ${id} at ${path} (disarmed).`);
      } catch (e) {
        await device?.close().catch(() => undefined);
        this.options.log?.(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
