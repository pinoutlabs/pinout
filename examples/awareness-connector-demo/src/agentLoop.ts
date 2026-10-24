/**
 * Scripted MCP agent session for the awareness → connector story.
 * No LLM — deterministic tool calls. Transcript is labeled SIMULATED.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFile } from 'node:fs/promises';
import { createAwarenessConnectorMcpServer } from './mcpBridge.js';

export interface AgentLoopOptions {
  baseUrl: string;
  token: string;
  unknownAwarenessId: string;
  transcriptPath: string;
  connectorId?: string;
}

export interface AgentLoopResult {
  transcript: string;
  toolNames: string[];
  connectorId: string;
}

function line(role: 'system' | 'agent' | 'tool' | 'human', text: string): string {
  return `[${role}] ${text}`;
}

export async function runScriptedAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const server = createAwarenessConnectorMcpServer({
    baseUrl: options.baseUrl,
    token: options.token,
    owner: 'scripted-agent',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pinout-awareness-demo-agent', version: '0.0.1-alpha.1' });

  const transcript: string[] = [
    '# Awareness → connector MCP agent transcript',
    '',
    '> **SIMULATED** — scripted agent loop against mock devices. Pinout has never run on real hardware in this repository. No radio, broker, or USB was used.',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
  ];

  const toolNames: string[] = [];
  let connectorId = options.connectorId ?? '';

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    toolNames.push(...listed.tools.map((t) => t.name));
    transcript.push(line('system', `MCP tools available: ${toolNames.join(', ')}`));
    transcript.push('');

    transcript.push(line('agent', 'What devices are nearby?'));
    const nearby = await client.callTool({ name: 'pinout__nearby_devices', arguments: {} });
    transcript.push(line('tool', 'pinout__nearby_devices'));
    transcript.push('```json');
    transcript.push(JSON.stringify(nearby.structuredContent ?? nearby, null, 2));
    transcript.push('```');
    transcript.push('');

    transcript.push(
      line('agent', `Describe the unknown BLE lamp (${options.unknownAwarenessId}).`),
    );
    const described = await client.callTool({
      name: 'pinout__describe_nearby',
      arguments: { awarenessId: options.unknownAwarenessId },
    });
    transcript.push(line('tool', 'pinout__describe_nearby'));
    transcript.push('```json');
    transcript.push(JSON.stringify(described.structuredContent ?? described, null, 2));
    transcript.push('```');
    transcript.push('');

    if (!connectorId) {
      transcript.push(
        line('agent', 'No module matched — request a quarantined connector (read-only first).'),
      );
      const generated = await client.callTool({
        name: 'pinout__generate_connector',
        arguments: { awarenessId: options.unknownAwarenessId },
      });
      transcript.push(line('tool', 'pinout__generate_connector'));
      transcript.push('```json');
      transcript.push(JSON.stringify(generated.structuredContent ?? generated, null, 2));
      transcript.push('```');
      const structured = generated.structuredContent as { connector?: { id?: string } } | undefined;
      connectorId = structured?.connector?.id ?? `conn-${options.unknownAwarenessId}`;
      transcript.push('');
    }

    transcript.push(line('agent', `Check connector status for ${connectorId}.`));
    const status = await client.callTool({
      name: 'pinout__connector_status',
      arguments: { connectorId },
    });
    transcript.push(line('tool', 'pinout__connector_status'));
    transcript.push('```json');
    transcript.push(JSON.stringify(status.structuredContent ?? status, null, 2));
    transcript.push('```');
    transcript.push('');

    transcript.push(line('agent', 'List all connectors.'));
    const all = await client.callTool({ name: 'pinout__list_connectors', arguments: {} });
    transcript.push(line('tool', 'pinout__list_connectors'));
    transcript.push('```json');
    transcript.push(JSON.stringify(all.structuredContent ?? all, null, 2));
    transcript.push('```');
    transcript.push('');

    transcript.push(
      line(
        'human',
        'Reminder: physical-output ranges require an explicit HUMAN APPROVES step outside the agent. Agents must not invent approved ranges.',
      ),
    );
    transcript.push('');
    transcript.push('---');
    transcript.push('');
    transcript.push('## Honesty');
    transcript.push('');
    transcript.push('- Evidence level for generated connectors ≤ `COMPILE_TESTED`.');
    transcript.push('- Nothing auto-armed.');
    transcript.push('- All devices were fixtures (`examples/awareness-connector-demo/fixtures/`).');
  } finally {
    await client.close();
    await server.close();
  }

  const text = `${transcript.join('\n')}\n`;
  await writeFile(options.transcriptPath, text, 'utf8');
  return { transcript: text, toolNames, connectorId };
}
