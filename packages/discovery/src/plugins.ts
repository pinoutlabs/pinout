/**
 * Built-in discovery plugins. All are READ-ONLY: they enumerate and observe,
 * they never open ports or send anything beyond passive queries (mDNS query
 * packets, single opt-in TCP health checks).
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { listSerialPorts } from '@pinout/core';
import type { DiscoveredCandidate, DiscoveryOptions, DiscoveryPlugin, Evidence } from './core.js';
import { candidateId } from './core.js';

// ---------------------------------------------------------------------------
// Serial ports
// ---------------------------------------------------------------------------

interface SerialIdentityRule {
  test: RegExp;
  moduleId: string;
  vendor: string;
  deviceClass?: string;
  confidence: number;
}

const SERIAL_RULES: SerialIdentityRule[] = [
  {
    test: /esp32|cp210|silicon labs|ch340|ch9102/i,
    moduleId: 'pinout/esp32',
    vendor: 'Espressif',
    deviceClass: 'microcontroller',
    confidence: 0.5,
  },
  {
    test: /pico|rp2|raspberry pi/i,
    moduleId: 'pinout/micropython-bridge',
    vendor: 'Raspberry Pi',
    deviceClass: 'microcontroller',
    confidence: 0.5,
  },
  {
    test: /arduino/i,
    moduleId: 'pinout/board',
    vendor: 'Arduino',
    deviceClass: 'microcontroller',
    confidence: 0.35,
  },
];

export function serialDiscoveryPlugin(listPorts = listSerialPorts): DiscoveryPlugin {
  return {
    name: 'serial',
    async discover(_options: DiscoveryOptions): Promise<DiscoveredCandidate[]> {
      // Never OPEN the ports: some adapters reset their target on open.
      const ports = await listPorts();
      return ports.map((port) => {
        const evidence: Evidence[] = [];
        const identities: Array<{
          moduleId: string;
          vendor?: string;
          deviceClass?: string;
          reason: string;
        }> = [];
        let confidence = 0.25;
        if (port.manufacturer) {
          evidence.push({
            source: 'usb-manufacturer',
            detail: `${port.path}: manufacturer '${port.manufacturer}'`,
            weight: 0.5,
          });
          for (const rule of SERIAL_RULES) {
            if (rule.test.test(port.manufacturer)) {
              identities.push({
                moduleId: rule.moduleId,
                vendor: rule.vendor,
                ...(rule.deviceClass !== undefined ? { deviceClass: rule.deviceClass } : {}),
                reason: `manufacturer string matches ${rule.vendor}`,
              });
              confidence = Math.max(confidence, rule.confidence);
            }
          }
        }
        evidence.push({
          source: 'serial-enumeration',
          detail: `serial device present at ${port.path}`,
          weight: 0.3,
        });
        if (identities.length === 0) {
          identities.push({
            moduleId: 'unknown/serial',
            reason: 'no matching signature from the manufacturer string',
          });
        }
        return {
          id: candidateId({ kind: 'serial', address: port.path }),
          endpoint: {
            kind: 'serial',
            address: port.path,
            ...(port.vendorId !== undefined || port.productId !== undefined
              ? {
                  details: {
                    vendorId: port.vendorId,
                    productId: port.productId,
                    manufacturer: port.manufacturer,
                  },
                }
              : {}),
          },
          possibleIdentity: identities,
          evidence,
          confidence,
          interfaces: ['serial'],
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// USB VID/PID (no device opening)
// ---------------------------------------------------------------------------

const USB_RULES: Array<{
  vid: string;
  pid?: string;
  moduleId: string;
  vendor: string;
  confidence: number;
  detail: string;
}> = [
  {
    vid: '10c4',
    pid: 'ea60',
    moduleId: 'pinout/esp32',
    vendor: 'Espressif',
    confidence: 0.5,
    detail: 'CP210x USB-UART bridge (common on ESP32 boards)',
  },
  {
    vid: '1a86',
    moduleId: 'pinout/esp32',
    vendor: 'WCH',
    confidence: 0.45,
    detail: 'CH34x USB-UART bridge',
  },
  {
    vid: '2e8a',
    moduleId: 'pinout/micropython-bridge',
    vendor: 'Raspberry Pi',
    confidence: 0.5,
    detail: 'Raspberry Pi vendor ID (RP2040/Pico)',
  },
  {
    vid: '2341',
    moduleId: 'pinout/board',
    vendor: 'Arduino',
    confidence: 0.45,
    detail: 'Arduino vendor ID',
  },
];

export function usbDiscoveryPlugin(): DiscoveryPlugin {
  return {
    name: 'usb',
    async discover(_options: DiscoveryOptions): Promise<DiscoveredCandidate[]> {
      const devices = await enumerateUsbDevices();
      return devices.map((device) => {
        const evidence: Evidence[] = [
          {
            source: 'usb-vid-pid',
            detail: `USB device ${device.vendorId}:${device.productId} present`,
            weight: 0.35,
          },
        ];
        const identities: Array<{
          moduleId: string;
          vendor?: string;
          deviceClass?: string;
          reason: string;
        }> = [];
        let confidence = 0.2;
        for (const rule of USB_RULES) {
          if (
            rule.vid === device.vendorId &&
            (rule.pid === undefined || rule.pid === device.productId)
          ) {
            identities.push({ moduleId: rule.moduleId, vendor: rule.vendor, reason: rule.detail });
            evidence.push({ source: 'usb-known-device', detail: rule.detail, weight: 0.45 });
            confidence = Math.max(confidence, rule.confidence);
          }
        }
        if (identities.length === 0) {
          identities.push({
            moduleId: 'unknown/usb',
            reason: 'USB device with no known VID/PID signature',
          });
        }
        const details = {
          vendorId: device.vendorId,
          productId: device.productId,
          ...(device.manufacturer !== undefined ? { manufacturer: device.manufacturer } : {}),
          ...(device.product !== undefined ? { product: device.product } : {}),
        };
        return {
          id: candidateId({ kind: 'usb', address: `${device.vendorId}:${device.productId}` }),
          endpoint: { kind: 'usb', address: `${device.vendorId}:${device.productId}`, details },
          possibleIdentity: identities,
          evidence,
          confidence,
          interfaces: ['usb'],
        };
      });
    },
  };
}

interface UsbDevice {
  vendorId: string;
  productId: string;
  manufacturer?: string;
  product?: string;
}

async function enumerateUsbDevices(): Promise<UsbDevice[]> {
  const platform = process.platform;
  if (platform === 'darwin') {
    return macOsUsbDevices();
  }
  if (platform === 'linux') {
    return linuxUsbDevices();
  }
  // Windows: not implemented — return empty rather than guessing.
  return [];
}

async function macOsUsbDevices(): Promise<UsbDevice[]> {
  return new Promise((resolve) => {
    const child = execFile(
      'system_profiler',
      ['SPUSBDataType', '-json'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { SPUSBDataType?: Array<Record<string, unknown>> };
          const devices: UsbDevice[] = [];
          const walk = (items: Array<Record<string, unknown>>): void => {
            for (const item of items) {
              const vendorId = item.vendor_id as string | undefined;
              const productId = item.product_id as string | undefined;
              if (vendorId && productId) {
                devices.push({
                  vendorId: String(vendorId).replace(/^0x/, '').toLowerCase().padStart(4, '0'),
                  productId: String(productId).replace(/^0x/, '').toLowerCase().padStart(4, '0'),
                  ...(typeof item.manufacturer === 'string'
                    ? { manufacturer: item.manufacturer }
                    : {}),
                  ...(typeof item._name === 'string' ? { product: item._name } : {}),
                });
              }
              if (Array.isArray(item._items)) {
                walk(item._items as Array<Record<string, unknown>>);
              }
            }
          };
          walk(parsed.SPUSBDataType ?? []);
          resolve(devices);
        } catch {
          resolve([]);
        }
      },
    );
    child.on('error', () => resolve([]));
  });
}

function linuxUsbDevices(): UsbDevice[] {
  const base = '/sys/bus/usb/devices';
  if (!existsSync(base)) return [];
  const devices: UsbDevice[] = [];
  for (const entry of readdirSync(base)) {
    const idVendorPath = join(base, entry, 'idVendor');
    const idProductPath = join(base, entry, 'idProduct');
    if (!existsSync(idVendorPath) || !existsSync(idProductPath)) continue;
    if (!/^\d+-[\d.]+$/.test(entry)) continue; // root hubs and interfaces excluded
    try {
      devices.push({
        vendorId: readFileSync(idVendorPath, 'utf8').trim().toLowerCase(),
        productId: readFileSync(idProductPath, 'utf8').trim().toLowerCase(),
      });
    } catch {
      // device vanished mid-enumeration
    }
  }
  return devices;
}

// ---------------------------------------------------------------------------
// mDNS (zero-dependency: one query packet, bounded collection window)
// ---------------------------------------------------------------------------

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

/** Encode a minimal DNS query for a PTR record. */
export function encodeMdnsQuery(name: string): Buffer {
  const labels = name.split('.').filter((label) => label.length > 0);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  const question = Buffer.concat([...parts, Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0); // id
  header.writeUInt16BE(0x0000, 2); // standard query
  header.writeUInt16BE(1, 4); // 1 question
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt16BE(12, 0); // PTR
  trailer.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, question, trailer]);
}

export interface MdnsAnswer {
  name: string;
  type: number;
}

/** Parse the answer names from an mDNS response (header + name walking). */
export function parseMdnsResponse(packet: Buffer): MdnsAnswer[] {
  if (packet.length < 12) return [];
  const questionCount = packet.readUInt16BE(4);
  const answerCount = packet.readUInt16BE(6);
  let offset = 12;

  const skipName = (): boolean => {
    let guard = 0;
    for (;;) {
      if (offset >= packet.length || guard > 64) return false;
      const length = packet[offset]!;
      if (length === 0) {
        offset += 1;
        return true;
      }
      if ((length & 0xc0) === 0xc0) {
        offset += 2;
        return true;
      }
      offset += 1 + length;
      guard += 1;
    }
  };

  const readName = (): string => {
    const labels: string[] = [];
    let cursor = offset;
    let jumped = false;
    let guard = 0;
    for (;;) {
      if (cursor >= packet.length || guard > 64) break;
      const length = packet[cursor]!;
      if (length === 0) {
        if (!jumped) offset = cursor + 1;
        break;
      }
      if ((length & 0xc0) === 0xc0) {
        const pointer = ((length & 0x3f) << 8) | packet[cursor + 1]!;
        if (!jumped) offset = cursor + 2;
        cursor = pointer;
        jumped = true;
        guard += 1;
        continue;
      }
      labels.push(packet.subarray(cursor + 1, cursor + 1 + length).toString('utf8'));
      cursor += 1 + length;
      guard += 1;
    }
    return labels.join('.');
  };

  for (let i = 0; i < questionCount; i += 1) {
    if (!skipName()) return [];
    offset += 4;
  }

  const answers: MdnsAnswer[] = [];
  for (let i = 0; i < answerCount && offset + 10 <= packet.length; i += 1) {
    const name = readName();
    const type = packet.readUInt16BE(offset);
    offset += 10;
    const dataLength = packet.readUInt16BE(offset - 2);
    offset += dataLength;
    answers.push({ name, type });
  }
  return answers;
}

export function mdnsDiscoveryPlugin(durationMs = 1500): DiscoveryPlugin {
  return {
    name: 'mdns',
    async discover(_options: DiscoveryOptions): Promise<DiscoveredCandidate[]> {
      if (durationMs <= 0) return [];
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      const found: DiscoveredCandidate[] = [];

      return new Promise((resolve) => {
        const finish = (): void => {
          try {
            socket.close();
          } catch {
            // already closed
          }
          resolve(found);
        };

        socket.on('error', () => finish());
        socket.on('message', (packet: Buffer, _info: RemoteInfo) => {
          for (const answer of parseMdnsResponse(packet)) {
            const name = answer.name.toLowerCase();
            if (!name.includes('pinout')) continue;
            found.push({
              id: candidateId({ kind: 'mdns', address: name }),
              endpoint: { kind: 'mdns', address: name, details: { recordType: answer.type } },
              possibleIdentity: [
                { moduleId: 'pinout/bridge', reason: 'advertised a Pinout service over mDNS' },
              ],
              evidence: [
                {
                  source: 'mdns',
                  detail: `_pinout service '${name}' responded to a query`,
                  weight: 0.9,
                },
              ],
              confidence: 0.85,
              interfaces: ['network'],
            });
          }
        });

        try {
          socket.bind(() => {
            try {
              socket.addMembership(MDNS_GROUP);
            } catch {
              // multicast membership unsupported: queries still unicast-fail
            }
            socket.send(encodeMdnsQuery('_pinout._udp.local'), MDNS_PORT, MDNS_GROUP);
            const timer = setTimeout(finish, durationMs);
            if (typeof timer === 'object' && 'unref' in timer) timer.unref();
          });
        } catch {
          finish();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Opt-in, bounded network endpoint probing
// ---------------------------------------------------------------------------

const NETWORK_RULES: Array<{ port: number; moduleId: string; confidence: number; detail: string }> =
  [
    { port: 502, moduleId: 'protocol/modbus-tcp', confidence: 0.4, detail: 'Modbus TCP port open' },
    {
      port: 4840,
      moduleId: 'protocol/opc-ua',
      confidence: 0.5,
      detail: 'OPC UA default port open',
    },
    { port: 1883, moduleId: 'protocol/mqtt', confidence: 0.4, detail: 'MQTT port open' },
    { port: 8883, moduleId: 'protocol/mqtt', confidence: 0.4, detail: 'MQTT TLS port open' },
    {
      port: 8787,
      moduleId: 'pinout/daemon',
      confidence: 0.9,
      detail: 'Pinout daemon health check answered ok',
    },
  ];

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Read-only health check for a candidate Pinout daemon. */
function probePinoutDaemon(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let buffered = '';
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(`GET /v1/health HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (buffered.includes('{"ok":true')) done(true);
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(buffered.includes('{"ok":true')));
  });
}

export function networkProbePlugin(): DiscoveryPlugin {
  return {
    name: 'network-probe',
    async discover(options: DiscoveryOptions): Promise<DiscoveredCandidate[]> {
      // OPT-IN ONLY. We probe explicitly supplied host:port endpoints —
      // never a subnet scan (out of scope, and rude on shared networks).
      const endpoints = options.network?.endpoints ?? [];
      if (!options.network?.enabled || endpoints.length === 0) return [];
      const timeoutMs = options.timeoutMs ?? 300;

      const results = await Promise.all(
        endpoints.map(async (endpoint: { host: string; port: number; probe?: 'pinout-daemon' }) => {
          // HTTP is only sent to the conventional daemon port or when the
          // caller explicitly flags an endpoint as a Pinout daemon. Other
          // endpoints receive a connect-only probe, keeping discovery
          // passive for Modbus/MQTT/SCPI services.
          const daemonOk =
            endpoint.port === 8787 || endpoint.probe === 'pinout-daemon'
              ? await probePinoutDaemon(endpoint.host, endpoint.port, timeoutMs)
              : false;
          if (daemonOk) {
            return [
              {
                id: candidateId({ kind: 'network', address: endpoint.host, port: endpoint.port }),
                endpoint: { kind: 'network' as const, address: endpoint.host, port: endpoint.port },
                possibleIdentity: [
                  { moduleId: 'pinout/daemon', reason: 'Pinout daemon health check answered ok' },
                ],
                evidence: [
                  {
                    source: 'http-health',
                    detail: 'GET /v1/health answered {"ok":true}',
                    weight: 0.9,
                  } as Evidence,
                ],
                confidence: 0.9,
                interfaces: ['network'],
              } satisfies DiscoveredCandidate,
            ];
          }
          const open = await probeTcp(endpoint.host, endpoint.port, timeoutMs);
          if (!open) return [];
          return NETWORK_RULES.filter(
            (rule) => rule.port === endpoint.port && rule.moduleId !== 'pinout/daemon',
          ).map((rule): DiscoveredCandidate => ({
            id: candidateId({ kind: 'network', address: endpoint.host, port: endpoint.port }),
            endpoint: { kind: 'network' as const, address: endpoint.host, port: endpoint.port },
            possibleIdentity: [{ moduleId: rule.moduleId, reason: rule.detail }],
            evidence: [{ source: 'tcp-probe', detail: rule.detail, weight: rule.confidence }],
            confidence: rule.confidence,
            interfaces: ['network'],
          }));
        }),
      );
      return results.flat();
    },
  };
}
