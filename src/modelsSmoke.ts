import {
  buildRuntimeTransitionPreflight,
  describeModelFamily,
  renderModelCatalogs,
  renderModelDiagnostics,
  renderRuntimeTransitionPreflight,
} from './providerModels.js';
import { buildSystemPrompt } from './prompt.js';
import { createTools } from './tools.js';
import { diagnoseProviderFailure } from './modelAdapters.js';

import type { AgentConfig } from './types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const config: AgentConfig = {
    provider: 'ollama',
    model: 'qwen3-coder:30b',
    baseUrl: 'http://127.0.0.1:11434',
    workdir: process.cwd(),
    autoApprove: false,
    maxTurns: 8,
    temperature: 0.2,
  };

  const qwenHints = describeModelFamily('ollama', 'qwen2.5-coder:7b');
  assert(
    qwenHints.some((hint) => hint.includes('balanced local coding default')),
    'Expected Qwen2.5 family hints to mention the balanced local coding baseline.'
  );

  const codexHints = describeModelFamily('codex', 'gpt-5.3-codex');
  assert(
    codexHints.some((hint) => hint.includes('faster Codex-oriented option')),
    'Expected GPT-5.3 Codex family hints to mention the faster Codex-oriented option.'
  );

  const filteredCurrent = await renderModelCatalogs(config, 'current', { query: 'qwen' });
  assert(
    filteredCurrent.includes('filter       qwen'),
    'Expected filtered current model output to show the active query.'
  );
  assert(
    filteredCurrent.includes('match hints') &&
      filteredCurrent.includes('Qwen'),
    'Expected filtered current model output to include family hints.'
  );

  const filteredCodex = await renderModelCatalogs(config, 'codex', { query: 'gpt-5' });
  assert(
    filteredCodex.includes('provider     codex') &&
      filteredCodex.includes('filter       gpt-5') &&
      filteredCodex.includes('match hints'),
    'Expected codex model search output to show the provider, filter, and hints.'
  );

  const missingMatches = await renderModelCatalogs(config, 'codex', { query: 'does-not-exist' });
  assert(
    missingMatches.includes('- (no models matched this filter)'),
    'Expected model search output to explain when a filter matched no models.'
  );

  const doctorAll = await renderModelDiagnostics(config, 'all', {
    probeOllama: async () => ({
      available: true,
      detail: 'The local `ollama list` command responded successfully.',
      models: ['qwen3-coder:30b', 'qwen2.5-coder:7b'],
    }),
    probeOpenAI: async () => ({
      reachable: false,
      detail: 'The OpenAI-compatible /models request failed with 401.',
      models: [],
    }),
    probeCodex: async () => ({
      available: true,
      loggedIn: true,
      detail: 'Logged in via ChatGPT',
    }),
  });
  assert(
    doctorAll.includes('mode         doctor') &&
      doctorAll.includes('provider     ollama') &&
      doctorAll.includes('provider     openai') &&
      doctorAll.includes('provider     codex'),
    'Expected model doctor output to render one section per provider.'
  );
  assert(
    doctorAll.includes('status       blocked') &&
      doctorAll.includes('API key'),
    'Expected OpenAI doctor output to explain missing API key failures.'
  );

  const doctorCurrent = await renderModelDiagnostics(config, 'current', {
    probeOllama: async () => ({
      available: true,
      detail: 'The local `ollama list` command responded successfully.',
      models: ['qwen3-coder:30b'],
    }),
  });
  assert(
      doctorCurrent.includes('status       ready') &&
      doctorCurrent.includes('installed models'),
    'Expected current-provider doctor output to show a ready Ollama installation.'
  );

  const invalidOpenAiDoctor = await renderModelDiagnostics(
    {
      ...config,
      provider: 'openai',
      model: '',
      baseUrl: '',
      apiKey: 'test-key',
    },
    'current',
    {
      probeOpenAI: async () => {
        throw new Error('The OpenAI probe should not run when the base URL is missing.');
      },
    }
  );
  assert(
    invalidOpenAiDoctor.includes('Skipped the live /models probe') &&
      invalidOpenAiDoctor.includes('status       blocked'),
    'Expected OpenAI doctor output to skip live probing when the base URL is invalid.'
  );

  const tools = createTools();
  const qwenPrompt = buildSystemPrompt(config, tools);
  assert(
    qwenPrompt.includes('Qwen3 Coder can handle broader reasoning') &&
      qwenPrompt.includes('Prefer one decisive tool call at a time'),
    'Expected the system prompt to include Qwen-local tuning guidance.'
  );

  const gemmaPrompt = buildSystemPrompt(
    {
      ...config,
      model: 'gemma3:12b',
    },
    tools
  );
  assert(
    gemmaPrompt.includes('Gemma-class local models need extra grounding'),
    'Expected the system prompt to include Gemma-specific grounding guidance.'
  );

  const codexPrompt = buildSystemPrompt(
    {
      ...config,
      provider: 'codex',
      model: 'gpt-5.4',
      baseUrl: '',
    },
    tools
  );
  assert(
    codexPrompt.includes('This is the Codex CLI path') &&
      codexPrompt.includes('adapt once quickly'),
    'Expected the system prompt to include Codex-specific operating guidance.'
  );

  const openAiPrompt = buildSystemPrompt(
    {
      ...config,
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
    },
    tools
  );
  assert(
    openAiPrompt.includes('This is an OpenAI-compatible remote path') &&
      openAiPrompt.includes('likely auth/base-url/model mismatch'),
    'Expected the system prompt to include OpenAI-compatible diagnostic guidance.'
  );

  const ollamaFailure = diagnoseProviderFailure(config, new Error('Ollama request failed (500): model "qwen3-coder:30b" not found'));
  assert(
    ollamaFailure.summary.includes('Ollama 모델') || ollamaFailure.summary.includes('요청한 Ollama 모델'),
    'Expected Ollama failures to explain missing local models.'
  );
  assert(
    ollamaFailure.nextSteps.some((step) => step.includes('ollama pull')) &&
      ollamaFailure.nextSteps.some((step) => step.includes('/models ollama')),
    'Expected Ollama failure guidance to suggest local model inspection and pull.'
  );

  const openAiFailure = diagnoseProviderFailure(
    {
      ...config,
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
    },
    new Error('OpenAI-compatible request failed (401): unauthorized')
  );
  assert(
    openAiFailure.summary.includes('인증') &&
      openAiFailure.nextSteps.some((step) => step.includes('/models doctor')),
    'Expected OpenAI failures to steer the user toward auth and doctor diagnostics.'
  );

  const codexFailure = diagnoseProviderFailure(
    {
      ...config,
      provider: 'codex',
      model: 'gpt-5.4',
      baseUrl: '',
    },
    new Error('Codex CLI request timed out twice. Try again, switch to a faster model, or narrow the request.')
  );
  assert(
    codexFailure.summary.includes('시간 안에 끝나지 않았') &&
      codexFailure.nextSteps.some((step) => step.includes('/max-turns')),
    'Expected Codex timeouts to suggest narrowing the request or tuning runtime settings.'
  );

  const openAiPreflight = await buildRuntimeTransitionPreflight(
    {
      ...config,
      provider: 'openai',
      model: '',
      baseUrl: '',
      apiKey: undefined,
    }
  );
  assert(
    openAiPreflight.status === 'warning' &&
      openAiPreflight.issues.some((issue) => issue.label === 'API key') &&
      openAiPreflight.issues.some((issue) => issue.label === 'model selection'),
    'Expected OpenAI runtime preflight to warn about missing API key and model selection.'
  );

  const ollamaPreflight = await buildRuntimeTransitionPreflight(
    {
      ...config,
      provider: 'ollama',
      model: 'qwen3-coder:30b',
    },
    {
      probeOllama: async () => ({
        available: true,
        detail: 'The local `ollama list` command responded successfully.',
        models: ['qwen2.5-coder:7b'],
      }),
    }
  );
  const ollamaPreflightText = renderRuntimeTransitionPreflight(
    {
      ...config,
      provider: 'ollama',
      model: 'qwen3-coder:30b',
    },
    ollamaPreflight
  );
  assert(
    ollamaPreflight.status === 'warning' &&
      ollamaPreflightText.includes('installed models') &&
      ollamaPreflightText.includes('ollama pull qwen3-coder:30b'),
    'Expected Ollama runtime preflight to warn when the selected model is not installed locally.'
  );

  const codexPreflight = await buildRuntimeTransitionPreflight(
    {
      ...config,
      provider: 'codex',
      model: 'gpt-5.4',
      baseUrl: '',
    },
    {
      probeCodex: async () => ({
        available: true,
        loggedIn: false,
        detail: 'Run `codex login` first.',
      }),
    }
  );
  assert(
    codexPreflight.status === 'warning' &&
      codexPreflight.issues.some((issue) => issue.label === 'ChatGPT login'),
    'Expected Codex runtime preflight to warn when the local CLI login is missing.'
  );

  console.log('[models-smoke] All model catalog checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[models-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
