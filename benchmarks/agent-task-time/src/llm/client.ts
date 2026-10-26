import type {
  LlmCompletion,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from '../types.js';

export type { LlmCompletion };

export interface LlmClient {
  readonly provider: string;
  readonly modelRequested: string;
  complete(options: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    temperature: number;
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
    temperature: number;
  }): Promise<LlmCompletion> {
    if (!this.apiKey) {
      throw new Error('OpenAI-compatible client requires an API key.');
    }
    const started = performance.now();
    const body: Record<string, unknown> = {
      model: this.modelRequested,
      temperature: options.temperature,
      messages: options.messages.map(toOpenAiMessage),
    };
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
    temperature: number;
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
      temperature: options.temperature,
      max_tokens: 4096,
      messages,
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    };
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
