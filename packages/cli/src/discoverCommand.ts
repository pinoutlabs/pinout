/**
 * `pinout discover` — enumerate candidate devices WITHOUT actuating them.
 *
 * Serial + USB + mDNS + BLE (advertisement-only) run by default; network
 * probing is opt-in via --network and bounded to explicitly supplied endpoints
 * (--probe host:port, repeatable). BLE never connects or writes GATT.
 */
import type { Command } from 'commander';
import {
  formatCandidatesTable,
  runDiscovery,
  serialDiscoveryPlugin,
  usbDiscoveryPlugin,
  mdnsDiscoveryPlugin,
  networkProbePlugin,
  bleDiscoveryPlugin,
} from '@pinout/discovery';

export interface DiscoverOutput {
  json: boolean;
  log: (value: unknown) => void;
  error: (message: string) => void;
}

export function registerDiscoverCommand(program: Command, outputFor: () => DiscoverOutput): void {
  program
    .command('discover')
    .description('Find candidate devices (read-only; never opens or actuates hardware).')
    .option('--network', 'enable bounded network probing of explicitly supplied endpoints', false)
    .option(
      '--probe <host:port>',
      'endpoint to probe with --network (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--timeout <ms>', 'per-probe / BLE scan timeout in milliseconds', '300')
    .option('--no-mdns', 'skip mDNS scanning')
    .option('--no-ble', 'skip BLE advertisement scanning')
    .action(
      async (options: {
        network: boolean;
        probe?: string[];
        timeout: string;
        mdns: boolean;
        ble: boolean;
      }) => {
        const out = outputFor();
        const endpoints = (options.probe ?? [])
          .map((pair) => {
            const separator = pair.lastIndexOf(':');
            if (separator === -1) return null;
            return {
              host: pair.slice(0, separator),
              port: Number.parseInt(pair.slice(separator + 1), 10),
            };
          })
          .filter(
            (endpoint): endpoint is { host: string; port: number } =>
              endpoint !== null && Number.isFinite(endpoint.port),
          );

        const plugins = [serialDiscoveryPlugin(), usbDiscoveryPlugin()];
        if (options.mdns) plugins.push(mdnsDiscoveryPlugin());
        if (options.ble) plugins.push(bleDiscoveryPlugin());
        if (options.network) plugins.push(networkProbePlugin());

        const run = await runDiscovery({
          plugins,
          timeoutMs: Number.parseInt(options.timeout, 10),
          network: { enabled: options.network, endpoints },
        });

        if (out.json) {
          out.log(run);
        } else {
          for (const line of formatCandidatesTable(run.candidates)) {
            out.log(line);
          }
          for (const error of run.errors) {
            out.log(`  plugin error [${error.plugin}]: ${error.message}`);
          }
          if (!options.network) {
            out.log('');
            out.log('Network probing is opt-in: pass --network --probe host:port to include it.');
          }
        }
      },
    );
}
