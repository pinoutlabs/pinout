import { modelOmitsTemperature } from './temperature.js';
import type {
  LlmCompletion,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from '../types.js';

export type { LlmCompletion };
export { modelOmitsTemperature, resolveTemperaturePolicy } from './temperature.js';
export type { TemperatureRecord } from './temperature.js';

export interface LlmClient {
  readonly provider: string;
  readonly modelRequested: string;
  complete(options: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    /** Value to send; omit (undefined) for models that reject temperature. */
    temperature?: number;
  }): Promise<LlmCompletion>;
}

export function createLlmClient(options: {
  provider: string;
  model: string;
  apiKey?: string;
  apiBaseUrl?: string;
}): LlmClient {
  const provider = options.provider.toLowerCase();
  if (provider === 'anthropic') {
    return new AnthropicClient(options.model, options.apiKey, options.apiBaseUrl);
  }
  if (provider === 'openai' && !options.apiBaseUrl) {
    // Bug fix: newer OpenAI models (e.g. gpt-6.1-sol) reject function tools on
    // /v1/chat/completions ("use /v1/responses"). Use the Responses API for the
    // first-party OpenAI provider. Same request shape for both arms.
    return new OpenAiResponsesClient(options.provider, options.model, options.apiKey);
  }
  return new OpenAiCompatibleClient(
    options.provider,
    options.model,
    options.apiKey,
    options.apiBaseUrl ?? defaultBaseUrl(provider),
  );
}

function defaultBaseUrl(provider: string): string {
  if (provider === 'openai' || provider === 'openai-compatible') {
    return 'https://api.openai.com/v1';
  }
  if (provider === 'google' || provider === 'gemini') {
    return 'https://generativelanguage.googleapis.com/v1beta/openai';
  }
  return 'https://api.openai.com/v1';
}

class OpenAiCompatibleClient implements LlmClient {
  readonly provider: string;
  readonly modelRequested: string;

  constructor(
    provider: string,
    model: string,
    private readonly apiKey: string | undefined,
    private readonly apiBaseUrl: string,
  ) {
    this.provider = provider;
    this.modelRequested = model;
  }

  async complete(options: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    temperature?: number;
  }): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new Error('OpenAI-compatible client requires an API key.');
    }
    const started = performance.now();
    const body: Record<string, unknown> = {
      model: this.modelRequested,
      messages: options.messages.map(toOpenAiMessage),
    };
    if (options.temperature !== undefined && !modelOmitsTemperature(this.modelRequested)) {
      body.temperature = options.temperature;
    }
    if (options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const latencyMs = performance.now() - started;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM provider error ${response.status}: ${text.slice(0, 500)}`);
    }
    const payload = (await response.json()) as OpenAiChatResponse;
    const choice = payload.choices?.[0]?.message;
    if (!choice) {
      throw new Error('LLM response contained no choices.');
    }
    const usage = normalizeUsage(payload.usage);
    const toolCalls = (choice.tool_calls ?? []).map((call, index) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        parsed = { _raw: call.function.arguments };
      }
      return {
        id: call.id ?? `call_${index}`,
        name: call.function.name,
        arguments: parsed,
      };
    });

    const message: LlmMessage = {
      role: 'assistant',
      content: choice.content ?? '',
    };
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
    return {
      message,
      model: payload.model ?? this.modelRequested,
      rawModelId: payload.model ?? this.modelRequested,
      usage,
      latencyMs,
    };
  }
}

/**
 * OpenAI Responses API client (stateless: store=false, full transcript resent
 * each turn exactly like the chat-completions path). Reasoning-family models
 * (o*, gpt-5*, gpt-6*) reject `temperature`, so it is omitted for them.
 */
class OpenAiResponsesClient implements LlmClient {
  readonly provider: string;
  readonly modelRequested: string;

  constructor(
    provider: string,
    model: string,
    private readonly apiKey: string | undefined,
  ) {
    this.provider = provider;
    this.modelRequested = model;
  }

  async complete(options: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    temperature?: number;
  }): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new Error('OpenAI client requires an API key.');
    }
    const started = performance.now();
    const input: Array<Record<string, unknown>> = [];
    for (const message of options.messages) {
      if (message.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: message.content,
        });
      } else if (message.role === 'assistant') {
        if (message.content) input.push({ role: 'assistant', content: message.content });
        for (const call of message.toolCalls ?? []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
        }
      } else {
        input.push({ role: message.role, content: message.content });
      }
    }
    const body: Record<string, unknown> = {
      model: this.modelRequested,
      input,
      store: false,
    };
    if (
      options.temperature !== undefined &&
      !modelOmitsTemperature(this.modelRequested)
    ) {
      body.temperature = options.temperature;
    }
    if (options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false,
      }));
      body.tool_choice = 'auto';
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const latencyMs = performance.now() - started;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM provider error ${response.status}: ${text.slice(0, 500)}`);
    }
    const payload = (await response.json()) as OpenAiResponsesResponse;
    const textParts: string[] = [];
    const toolCalls: LlmToolCall[] = [];
    for (const item of payload.output ?? []) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && part.text) textParts.push(part.text);
        }
      } else if (item.type === 'function_call') {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(item.arguments || '{}') as Record<string, unknown>;
        } catch {
          parsed = { _raw: item.arguments };
        }
        toolCalls.push({
          id: item.call_id ?? `call_${toolCalls.length}`,
          name: item.name ?? 'unknown',
          arguments: parsed,
        });
      }
    }
    const message: LlmMessage = { role: 'assistant', content: textParts.join('\n') };
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
    return {
      message,
      model: payload.model ?? this.modelRequested,
      rawModelId: payload.model ?? this.modelRequested,
      usage: {
        promptTokens: payload.usage?.input_tokens ?? 0,
        completionTokens: payload.usage?.output_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0,
      },
      latencyMs,
    };
  }
}

interface OpenAiResponsesResponse {
  model?: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic';
  readonly modelRequested: string;

  constructor(
    model: string,
    private readonly apiKey: string | undefined,
    private readonly apiBaseUrl?: string,
  ) {
    this.modelRequested = model;
  }

  async complete(options: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    temperature?: number;
  }): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new Error('Anthropic client requires ANTHROPIC_API_KEY.');
    }
    const started = performance.now();
    const system = options.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages = options.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: message.toolCallId,
                content: message.content,
              },
            ],
          };
        }
        if (message.role === 'assistant' && message.toolCalls?.length) {
          return {
            role: 'assistant',
            content: [
              ...(message.content
                ? [{ type: 'text', text: message.content }]
                : []),
              ...message.toolCalls.map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.arguments,
              })),
            ],
          };
        }
        return { role: message.role, content: message.content };
      });

    const body: Record<string, unknown> = {
      model: this.modelRequested,
      max_tokens: 4096,
      messages,
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (system) body.system = system;

    const base = (this.apiBaseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const latencyMs = performance.now() - started;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic error ${response.status}: ${text.slice(0, 500)}`);
    }
    const payload = (await response.json()) as AnthropicResponse;
    const textParts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    for (const block of payload.content ?? []) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `tool_${toolCalls.length}`,
          name: block.name ?? 'unknown',
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    const message: LlmMessage = {
      role: 'assistant',
      content: textParts.join('\n'),
    };
    if (toolCalls.length > 0) message.toolCalls = toolCalls as LlmToolCall[];
    return {
      message,
      model: payload.model ?? this.modelRequested,
      rawModelId: payload.model ?? this.modelRequested,
      usage: {
        promptTokens: payload.usage?.input_tokens ?? 0,
        completionTokens: payload.usage?.output_tokens ?? 0,
        totalTokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
      },
      latencyMs,
    };
  }
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeUsage(usage: OpenAiChatResponse['usage']): LlmUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface AnthropicResponse {
  model?: string;
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}
