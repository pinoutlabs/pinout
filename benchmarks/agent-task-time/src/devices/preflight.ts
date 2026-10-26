import type { CommandRunner } from './commandRunner.js';
import { getProfile } from './profiles.js';
import type { ProfileId } from '../types.js';

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

export interface PreflightDeps {
  commandRunner: CommandRunner;
  listSerialPorts: () => Promise<SerialPortInfo[]>;
  probeDaemon: (url: string, token?: string) => Promise<{ ok: boolean; detail: string }>;
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  ports: SerialPortInfo[];
  toolchains: Record<string, string | undefined>;
  daemon: { url?: string; ok: boolean; detail: string; alreadyRunning: boolean };
  selectedPort?: string;
}

const profileToolchains: Record<ProfileId, string[]> = {
  esp32: ['esptool.py', 'esptool', 'arduino-cli'],
  pico: ['mpremote', 'picotool'],
  uno: ['arduino-cli'],
};

export async function runRealBoardPreflight(options: {
  profiles: ProfileId[];
  arms: Array<'raw' | 'pinout'>;
  serialPort?: string;
  daemonUrl?: string;
  daemonToken?: string;
  deps: PreflightDeps;
}): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ports = await options.deps.listSerialPorts();
  const toolchains: Record<string, string | undefined> = {};

  if (ports.length === 0) {
    errors.push('No serial ports detected. Connect a board and retry.');
  }

  let selectedPort = options.serialPort;
  if (selectedPort) {
    if (!ports.some((port) => port.path === selectedPort)) {
      errors.push(
        `Configured serial port '${selectedPort}' was not found. Detected: ${
          ports.map((port) => port.path).join(', ') || '(none)'
        }.`,
      );
    }
  } else if (ports.length === 1) {
    selectedPort = ports[0]!.path;
    warnings.push(`No --serial-port set; using sole detected port ${selectedPort}.`);
  } else if (ports.length > 1) {
    errors.push(
      `Multiple serial ports detected (${ports.map((p) => p.path).join(', ')}). Pass --serial-port.`,
    );
  }

  if (options.arms.includes('raw')) {
    for (const profileId of options.profiles) {
      const needed = profileToolchains[profileId];
      let foundAny = false;
      for (const binary of needed) {
        const path = await options.deps.commandRunner.which(binary);
        toolchains[binary] = path;
        if (path) foundAny = true;
      }
      if (!foundAny) {
        errors.push(
          `Raw arm for ${getProfile(profileId).displayName} needs one of: ${needed.join(', ')}. None found on PATH.`,
        );
      }
    }
  }

  const daemon: PreflightResult['daemon'] = {
    ok: false,
    detail: 'not checked',
    alreadyRunning: false,
  };
  if (options.daemonUrl !== undefined) daemon.url = options.daemonUrl;
  if (options.arms.includes('pinout')) {
    const url = options.daemonUrl ?? 'http://127.0.0.1:8787';
    const probe = await options.deps.probeDaemon(url, options.daemonToken);
    daemon.url = url;
    daemon.ok = probe.ok;
    daemon.detail = probe.detail;
    daemon.alreadyRunning = probe.ok;
    if (!probe.ok) {
      errors.push(
        `pinoutd is required for Arm B (Pinout) in --device real. Probe of ${url} failed: ${probe.detail}. Start pinoutd with the board attached before the bench.`,
      );
    }
  }

  const result: PreflightResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    ports,
    toolchains,
    daemon,
  };
  if (selectedPort !== undefined) result.selectedPort = selectedPort;
  return result;
}

export async function defaultProbeDaemon(
  url: string,
  token?: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/health`, { headers });
    if (!response.ok) {
      // Some pinoutd builds expose /health or root; try a second path.
      const alt = await fetch(`${url.replace(/\/$/, '')}/health`, { headers });
      if (!alt.ok) {
        return { ok: false, detail: `HTTP ${response.status} on /v1/health` };
      }
      return { ok: true, detail: 'HTTP health ok' };
    }
    return { ok: true, detail: 'HTTP /v1/health ok' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
