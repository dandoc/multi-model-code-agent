import { createModelAdapter } from './modelAdapters.js';

import type { AgentConfig, ChatMessage } from './types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const SAMPLE_MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function createConfig(provider: AgentConfig['provider']): AgentConfig {
  return {
    provider,
    model: provider === 'openai' ? 'gpt-4.1' : provider === 'codex' ? 'gpt-5.4' : 'qwen2.5-coder:7b',
    baseUrl: provider === 'openai' ? 'https://api.example.test/v1' : 'http://127.0.0.1:11434',
    apiKey: provider === 'openai' ? 'test-key' : undefined,
    workdir: process.cwd(),
    autoApprove: false,
    maxTurns: 8,
    temperature: 0.2,
  };
}

async function withMockFetch(
  mock: typeof fetch,
  fn: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runOpenAiRetrySmoke(): Promise<void> {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('temporary overload', { status: 503 });
      }

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok after retry' } }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }) as typeof fetch,
    async () => {
      const adapter = createModelAdapter(createConfig('openai'));
      const reply = await adapter.complete(SAMPLE_MESSAGES, createConfig('openai'));
      assert(reply === 'ok after retry', `Expected OpenAI retry smoke to recover, got: ${reply}`);
    }
  );

  assert(calls === 2, `Expected OpenAI transient retry to call fetch twice, got ${calls}.`);
}

async function runOpenAiNoRetrySmoke(): Promise<void> {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    }) as typeof fetch,
    async () => {
      const adapter = createModelAdapter(createConfig('openai'));
      let failed = false;
      try {
        await adapter.complete(SAMPLE_MESSAGES, createConfig('openai'));
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        assert(
          message.includes('401'),
          `Expected OpenAI non-retryable failure to surface 401 details, got: ${message}`
        );
      }

      assert(failed, 'Expected OpenAI 401 failure to throw.');
    }
  );

  assert(calls === 1, `Expected OpenAI 401 to skip retries, got ${calls} fetch calls.`);
}

async function runOllamaRetrySmoke(): Promise<void> {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed');
      }

      return new Response(
        JSON.stringify({
          message: { content: 'ollama recovered' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }) as typeof fetch,
    async () => {
      const adapter = createModelAdapter(createConfig('ollama'));
      const reply = await adapter.complete(SAMPLE_MESSAGES, createConfig('ollama'));
      assert(reply === 'ollama recovered', `Expected Ollama retry smoke to recover, got: ${reply}`);
    }
  );

  assert(calls === 2, `Expected Ollama transient retry to call fetch twice, got ${calls}.`);
}

async function main(): Promise<void> {
  await runOpenAiRetrySmoke();
  await runOpenAiNoRetrySmoke();
  await runOllamaRetrySmoke();
  console.log('[adapter-smoke] All adapter retry checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[adapter-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
