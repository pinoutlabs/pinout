import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeLine } from '../src/lineReader.js';
import { esp32BridgeCapabilities } from '../src/drivers/esp32/bridge.js';
import { decodeLine, encodeRequest, maxProtocolLineBytes, parseLine } from '../src/protocol.js';
import { simulatedEsp32 } from '../src/drivers/esp32/simulatedTransport.js';

const vectorPath = join(process.cwd(), 'fixtures', 'protocol', 'v1', 'messages.jsonl');

describe('protocol v1 golden vectors', () => {
  const lines = readFileSync(vectorPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('{"fixture":'));
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

  it('classifies malformed fixtures and returns their structured simulator errors', async () => {
    const fixtures = records
      .filter((line) => line.startsWith('{"fixture":'))
      .map((line) => JSON.parse(line) as MalformedFixture);
    const transport = simulatedEsp32();
    await transport.open();
    const messages: Array<Record<string, unknown>> = [];
    const pump = (async () => {
      for await (const chunk of transport.readable) {
        messages.push(JSON.parse(new TextDecoder().decode(chunk)) as Record<string, unknown>);
      }
    })();

    for (const fixture of fixtures) {
      const input = materialize(fixture.input);
      expect(decodeLine(input).kind).toBe(fixture.expected.decode);
      await transport.write(encodeLine(input));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await transport.close();
    await pump;

    const errors = messages
      .filter((message) => message.error && typeof message.error === 'object')
      .map((message) => (message.error as { code?: string }).code);
    expect(errors).toEqual(fixtures.map((fixture) => fixture.expected.code));
    expect(maxProtocolLineBytes).toBe(1024);
  });

  it('rejects an unknown action before it can change simulated GPIO state', async () => {
    const fixture = records
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.fixture === 'unknown-action') as MalformedFixture;
    const transport = simulatedEsp32({ autoArm: true });
    await transport.open();
    const before = [...transport.state.levels.entries()];
    const messages: Array<Record<string, unknown>> = [];
    const pump = (async () => {
      for await (const chunk of transport.readable) {
        messages.push(JSON.parse(new TextDecoder().decode(chunk)) as Record<string, unknown>);
      }
    })();
    await transport.write(encodeLine(materialize(fixture.input)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await transport.close();
    await pump;

    expect(
      messages.some(
        (message) => (message.error as { code?: string } | undefined)?.code === 'UNKNOWN_ACTION',
      ),
    ).toBe(true);
    expect([...transport.state.levels.entries()]).toEqual(before);
  });
});

interface MalformedFixture {
  fixture: string;
  input: string | { prefix: string; repeat: number; suffix: string };
  expected: { decode: string; code: string };
}

function materialize(input: MalformedFixture['input']): string {
  if (typeof input === 'string') return input;
  return `${input.prefix}${'x'.repeat(input.repeat)}${input.suffix}`;
}
