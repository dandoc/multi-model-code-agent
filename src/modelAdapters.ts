import type { AgentConfig, ChatMessage, ModelAdapter } from './types.js';

function coerceOpenAIContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (
          part &&
          typeof part === 'object' &&
          'type' in part &&
          'text' in part &&
          (part as { type?: unknown }).type === 'text'
        ) {
          return String((part as { text: unknown }).text);
        }

        return '';
      })
      .join('');
  }

  return '';
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

class OllamaAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;

  async complete(messages: ChatMessage[], config: AgentConfig): Promise<string> {
    const response = await fetch(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages,
        options: {
          temperature: config.temperature,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama request failed (${response.status}): ${await readErrorBody(response)}`
      );
    }

    const payload = (await response.json()) as {
      message?: { content?: string };
    };

    return payload.message?.content?.trim() || '';
  }
}

class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider = 'openai' as const;

  async complete(messages: ChatMessage[], config: AgentConfig): Promise<string> {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is required for the openai provider.');
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible request failed (${response.status}): ${await readErrorBody(response)}`
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: unknown;
        };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    return coerceOpenAIContent(content).trim();
  }
}

export function createModelAdapter(config: AgentConfig): ModelAdapter {
  if (config.provider === 'openai') {
    return new OpenAICompatibleAdapter();
  }

  return new OllamaAdapter();
}
