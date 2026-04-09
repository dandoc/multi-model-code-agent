import { renderLiveProviderSmokeResults, runLiveProviderSmoke } from './liveProviderMatrix.js';

import type { AgentConfig, ChatMessage, ModelProvider } from './types.js';
import type { ProviderDiagnostics } from './providerModels.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function createConfig(provider: ModelProvider): AgentConfig {
  return {
    provider,
    model: provider === 'codex' ? 'gpt-5.4' : provider === 'openai' ? 'gpt-4.1' : 'qwen3-coder:30b',
    baseUrl: provider === 'codex' ? '' : provider === 'openai' ? 'https://api.example.test/v1' : 'http://127.0.0.1:11434',
    apiKey: provider === 'openai' ? 'test-key' : undefined,
    workdir: process.cwd(),
    autoApprove: false,
    maxTurns: 8,
    temperature: 0.2,
    requestTimeoutMs: 45_000,
  };
}

async function main(): Promise<void> {
  const config = createConfig('ollama');
  const diagnostics: ProviderDiagnostics[] = [
    {
      provider: 'ollama',
      currentModel: 'qwen3-coder:30b',
      baseUrl: 'http://127.0.0.1:11434',
      status: 'ready',
      checks: [{ level: 'ok', label: 'local CLI', detail: 'ready' }],
    },
    {
      provider: 'openai',
      currentModel: 'gpt-4.1',
      baseUrl: 'https://api.example.test/v1',
      status: 'warning',
      checks: [
        {
          level: 'warn',
          label: 'API key',
          detail: 'No API key is configured for the OpenAI-compatible provider.',
          hint: 'Set OPENAI_API_KEY first.',
        },
      ],
    },
    {
      provider: 'codex',
      currentModel: 'gpt-5.4',
      baseUrl: '',
      status: 'ready',
      checks: [{ level: 'ok', label: 'ChatGPT login', detail: 'ready' }],
    },
  ];

  const results = await runLiveProviderSmoke(config, 'all', 'all', {
    collectDiagnostics: async () => diagnostics,
    targetConfigFactory: (_config, provider) => createConfig(provider),
    adapterFactory: (targetConfig) => ({
      provider: targetConfig.provider,
      complete: async (messages: ChatMessage[]) => {
        if (targetConfig.provider === 'ollama') {
          if (messages[0]?.content.includes('JSON object')) {
            return '{"type":"message","message":"OK"}';
          }
          return 'OK';
        }
        if (targetConfig.provider === 'codex') {
          throw new Error('Codex CLI request timed out twice. Try again, switch to a faster model, or narrow the request.');
        }
        throw new Error('The blocked OpenAI smoke should not execute.');
      },
    }),
    now: (() => {
      let current = 1_000;
      return () => {
        current += 250;
        return current;
      };
    })(),
  });

  assert(results.length === 3, `Expected 3 live smoke results, got ${results.length}.`);

  const ollama = results.find((result) => result.provider === 'ollama');
  assert(ollama?.status === 'passed', 'Expected Ollama live smoke to pass.');
  assert(ollama?.checks.length === 2, 'Expected Ollama live smoke to run both quick and protocol checks.');
  assert(
    ollama?.checks.some((check) => check.name === 'quick' && check.status === 'passed' && check.replyPreview === 'OK'),
    'Expected Ollama quick smoke to return an OK preview.'
  );
  assert(
    ollama?.checks.some((check) => check.name === 'protocol' && check.status === 'passed'),
    'Expected Ollama protocol smoke to parse the structured message envelope.'
  );

  const openai = results.find((result) => result.provider === 'openai');
  assert(openai?.status === 'blocked', 'Expected OpenAI live smoke to be blocked by readiness checks.');
  assert(
    openai?.detailLines.some((line) => line.includes('API key')),
    'Expected blocked OpenAI smoke to explain the API key issue.'
  );

  const codex = results.find((result) => result.provider === 'codex');
  assert(codex?.status === 'failed', 'Expected Codex live smoke to surface adapter failures.');
  assert(
    codex?.summary.includes('시간') || codex?.summary.toLowerCase().includes('timeout'),
    `Expected Codex failure summary to mention timeout guidance, got ${codex?.summary}.`
  );

  const protocolOnly = await runLiveProviderSmoke(config, 'current', 'protocol', {
    collectDiagnostics: async () => diagnostics.slice(0, 1),
    targetConfigFactory: (_config, provider) => createConfig(provider),
    adapterFactory: (targetConfig) => ({
      provider: targetConfig.provider,
      complete: async () => '{"type":"message","message":"WRONG"}',
    }),
    now: (() => {
      let current = 5_000;
      return () => {
        current += 100;
        return current;
      };
    })(),
  });
  assert(
    protocolOnly[0]?.status === 'failed' &&
      protocolOnly[0]?.checks[0]?.name === 'protocol' &&
      protocolOnly[0]?.checks[0]?.detailLines.some((line) => line.includes('Parsed message: WRONG')),
    'Expected protocol-only smoke to fail when the parsed JSON message does not match OK.'
  );

  const rendered = renderLiveProviderSmokeResults(results);
  assert(
    rendered.includes('mode         smoke') &&
      rendered.includes('status       passed') &&
      rendered.includes('status       blocked') &&
      rendered.includes('status       failed'),
    'Expected rendered live smoke output to show per-provider smoke statuses.'
  );
  assert(
    rendered.includes('checks') &&
      rendered.includes('quick') &&
      rendered.includes('protocol') &&
      rendered.includes('reply: OK'),
    'Expected rendered live smoke output to show per-check results and reply previews.'
  );

  console.log('[live-provider-matrix-smoke] All live smoke matrix checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[live-provider-matrix-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
