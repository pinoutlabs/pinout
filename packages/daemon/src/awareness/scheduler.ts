/**
 * Per-transport discovery scheduler.
 *
 * Discovery plugins stay READ-ONLY. Network probing is opt-in only.
 * Intervals are configurable; defaults keep serial/USB frequent and BLE/mDNS
 * slower to avoid radio/network chatter.
 */
import {
  bleDiscoveryPlugin,
  mdnsDiscoveryPlugin,
  runDiscovery,
  serialDiscoveryPlugin,
  usbDiscoveryPlugin,
  networkProbePlugin,
  type DiscoveryPlugin,
  type DiscoveryOptions,
  type DiscoveredCandidate,
} from '@pinout/discovery';

export type AwarenessTransportSchedule = 'serial' | 'usb' | 'ble' | 'mdns' | 'network';

export interface TransportIntervalConfig {
  serialMs: number;
  usbMs: number;
  bleMs: number;
  mdnsMs: number;
  /** Only used when network probing is explicitly enabled. */
  networkMs: number;
}

export const DEFAULT_TRANSPORT_INTERVALS: TransportIntervalConfig = {
  serialMs: 2_000,
  usbMs: 5_000,
  bleMs: 15_000,
  mdnsMs: 10_000,
  networkMs: 20_000,
};

export interface AwarenessSchedulerOptions {
  intervals?: Partial<TransportIntervalConfig>;
  /** Extra plugins (e.g. mock-devices). */
  extraPlugins?: DiscoveryPlugin[];
  /** When true, only run extraPlugins (skip live serial/usb/ble/mdns). */
  mockOnly?: boolean;
  /** Opt-in bounded network probe endpoints. */
  network?: DiscoveryOptions['network'];
  listSerialPorts?: DiscoveryOptions['listSerialPorts'];
  blePlugin?: DiscoveryPlugin;
  onCandidates?: (candidates: DiscoveredCandidate[], pluginNames: string[]) => void | Promise<void>;
  onError?: (plugin: string, message: string) => void;
  log?: (message: string) => void;
}

interface ScheduledPlugin {
  name: AwarenessTransportSchedule | string;
  plugin: DiscoveryPlugin;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
}

export class AwarenessDiscoveryScheduler {
  private readonly plugins: ScheduledPlugin[] = [];
  private stopped = true;
  private readonly intervals: TransportIntervalConfig;

  constructor(private readonly options: AwarenessSchedulerOptions = {}) {
    this.intervals = { ...DEFAULT_TRANSPORT_INTERVALS, ...options.intervals };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.plugins.length = 0;

    if (!this.options.mockOnly) {
      this.plugins.push({
        name: 'serial',
        plugin: serialDiscoveryPlugin(this.options.listSerialPorts),
        intervalMs: this.intervals.serialMs,
        timer: undefined,
        running: false,
      });
      this.plugins.push({
        name: 'usb',
        plugin: usbDiscoveryPlugin(),
        intervalMs: this.intervals.usbMs,
        timer: undefined,
        running: false,
      });
      this.plugins.push({
        name: 'ble',
        plugin: this.options.blePlugin ?? bleDiscoveryPlugin(),
        intervalMs: this.intervals.bleMs,
        timer: undefined,
        running: false,
      });
      this.plugins.push({
        name: 'mdns',
        plugin: mdnsDiscoveryPlugin(),
        intervalMs: this.intervals.mdnsMs,
        timer: undefined,
        running: false,
      });

      if (this.options.network?.enabled) {
        this.plugins.push({
          name: 'network',
          plugin: networkProbePlugin(),
          intervalMs: this.intervals.networkMs,
          timer: undefined,
          running: false,
        });
      }
    }

    for (const extra of this.options.extraPlugins ?? []) {
      this.plugins.push({
        name: extra.name,
        plugin: extra,
        intervalMs: this.intervals.serialMs,
        timer: undefined,
        running: false,
      });
    }

    for (const entry of this.plugins) {
      void this.runAndSchedule(entry);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.plugins) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    // Wait briefly for in-flight discovers to settle.
    await Promise.resolve();
  }

  /** Run every scheduled plugin once (tests / --discover immediate pass). */
  async scanOnce(): Promise<DiscoveredCandidate[]> {
    const plugins = this.plugins.length
      ? this.plugins.map((p) => p.plugin)
      : this.options.mockOnly
        ? [...(this.options.extraPlugins ?? [])]
        : [
            serialDiscoveryPlugin(this.options.listSerialPorts),
            usbDiscoveryPlugin(),
            this.options.blePlugin ?? bleDiscoveryPlugin(),
            mdnsDiscoveryPlugin(),
            ...(this.options.network?.enabled ? [networkProbePlugin()] : []),
            ...(this.options.extraPlugins ?? []),
          ];
    const run = await runDiscovery({
      plugins,
      ...(this.options.network ? { network: this.options.network } : {}),
      ...(this.options.listSerialPorts ? { listSerialPorts: this.options.listSerialPorts } : {}),
    });
    for (const error of run.errors) {
      this.options.onError?.(error.plugin, error.message);
    }
    await this.options.onCandidates?.(run.candidates, run.pluginsRun);
    return run.candidates;
  }

  private runAndSchedule(entry: ScheduledPlugin): void {
    if (this.stopped) return;
    entry.timer = setTimeout(() => {
      void this.tick(entry).finally(() => this.runAndSchedule(entry));
    }, entry.intervalMs);
  }

  private async tick(entry: ScheduledPlugin): Promise<void> {
    if (this.stopped || entry.running) return;
    entry.running = true;
    try {
      const run = await runDiscovery({
        plugins: [entry.plugin],
        ...(this.options.network ? { network: this.options.network } : {}),
        ...(this.options.listSerialPorts
          ? { listSerialPorts: this.options.listSerialPorts }
          : {}),
      });
      for (const error of run.errors) {
        this.options.onError?.(error.plugin, error.message);
      }
      if (run.candidates.length > 0) {
        this.options.log?.(
          `awareness/${entry.name}: ${run.candidates.length} candidate(s) (${run.durationMs}ms)`,
        );
      }
      await this.options.onCandidates?.(run.candidates, run.pluginsRun);
    } catch (error) {
      this.options.onError?.(
        entry.name,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      entry.running = false;
    }
  }
}
