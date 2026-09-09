import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { esp32BridgeCapabilities } from '../src/drivers/esp32/bridge.js';
import { decodeLine, encodeRequest, parseLine } from '../src/protocol.js';

const vectorPath = join(process.cwd(), 'fixtures', 'protocol', 'v1', 'messages.jsonl');

describe('protocol v1 golden vectors', () => {
  const lines = readFileSync(vectorPath, 'utf8').trim().split(/\r?\n/);
  it('decodes every shared wire vector', () => {
    for (const line of lines) expect(decodeLine(line).kind).toBe('message');
  });
  it('preserves canonical request encoding', () => {
    expect(encodeRequest('req-1', 'sys.ping')).toBe(`${lines[0]}\n`);
  });
  it('round-trips vectors through the public parser', () => {
    expect(parseLine(lines[1]!)).toMatchObject({ id: 'req-1', ok: true });
    expect(parseLine(lines[3]!)).toMatchObject({ event: 'ready' });
  });
  it('keeps the firmware capability advertisement in exact host order', () => {
    const firmware = readFileSync(
      join(process.cwd(), 'firmware', 'esp32-bridge', 'src', 'main.cpp'),
      'utf8',
    );
    const fillIdentity = firmware.match(
      /void fillIdentity\(JsonObject payload\) \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(fillIdentity).toBeDefined();
    const advertised = [...fillIdentity!.matchAll(/capabilities\.add\("([^"]+)"\);/g)].map(
      (match) => match[1],
    );
    expect(advertised).toEqual([...esp32BridgeCapabilities]);
  });
});
