import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentConfig, ModelProvider } from './types.js';

const execFileAsync = promisify(execFile);

type ProviderModelCatalog = {
  provider: ModelProvider;
  currentModel: string;
  defaultModel: string;
  models: string[];
  notes: string[];
};

type RenderCatalogOptions = {
  query?: string;
};

function getOllamaCommand(): string {
  return process.platform === 'win32' ? 'ollama.exe' : 'ollama';
}

export function providerModelEnvKey(provider: ModelProvider): string {
  switch (provider) {
    case 'ollama':
      return 'OLLAMA_MODEL_NAME';
    case 'openai':
      return 'OPENAI_MODEL_NAME';
    case 'codex':
      return 'CODEX_MODEL_NAME';
  }
}

export function providerBaseUrlEnvKey(provider: ModelProvider): 'OLLAMA_BASE_URL' | 'OPENAI_BASE_URL' | null {
  switch (provider) {
    case 'ollama':
      return 'OLLAMA_BASE_URL';
    case 'openai':
      return 'OPENAI_BASE_URL';
    case 'codex':
      return null;
  }
}

export function providerDefaultModel(provider: ModelProvider): string {
  switch (provider) {
    case 'ollama':
      return 'qwen2.5-coder:7b';
    case 'openai':
      return '';
    case 'codex':
      return '';
  }
}

export function providerDefaultBaseUrl(provider: ModelProvider): string {
  switch (provider) {
    case 'ollama':
      return 'http://127.0.0.1:11434';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'codex':
      return '';
  }
}

export function isModelCompatible(provider: ModelProvider, model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (provider === 'codex') {
    return /^(gpt-|o\d|codex-)/.test(normalized);
  }

  return true;
}

export function resolveStoredModelForProvider(
  provider: ModelProvider,
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    allowLegacy?: boolean;
  }
): string {
  const providerScoped = env[providerModelEnvKey(provider)];
  if (typeof providerScoped === 'string') {
    const normalizedProviderScoped = providerScoped.trim();
    if (!normalizedProviderScoped) {
      return providerDefaultModel(provider);
    }
    if (isModelCompatible(provider, normalizedProviderScoped)) {
      return normalizedProviderScoped;
    }
  }

  if (options?.allowLegacy ?? true) {
    const legacy = env.MODEL_NAME;
    if (typeof legacy === 'string') {
      const normalizedLegacy = legacy.trim();
      if (!normalizedLegacy) {
        return providerDefaultModel(provider);
      }
      if (isModelCompatible(provider, normalizedLegacy)) {
        return normalizedLegacy;
      }
    }
  }

  return providerDefaultModel(provider);
}

function currentModelLabel(model: string): string {
  return model.trim() || '(provider default)';
}

function normalizeModelSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function matchesModelQuery(model: string, query: string): boolean {
  const normalized = normalizeModelSearchQuery(query);
  if (!normalized) {
    return true;
  }

  return model.toLowerCase().includes(normalized);
}

export function describeModelFamily(provider: ModelProvider, model: string): string[] {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === '(provider default)') {
    return [];
  }

  if (normalized.includes('qwen3-coder')) {
    return ['Qwen3 Coder family: deeper local reasoning, usually slower than smaller Qwen coder variants.'];
  }

  if (normalized.includes('qwen2.5-coder')) {
    return ['Qwen2.5 Coder family: balanced local coding default and a solid fast baseline.'];
  }

  if (normalized.includes('gemma')) {
    return ['Gemma family: lighter local option; re-check grounding on larger repo analysis tasks.'];
  }

  if (normalized.includes('gpt-5.4')) {
    return ['GPT-5.4: strongest remote reasoning/coding option in this toolchain.'];
  }

  if (normalized.includes('gpt-5.3-codex')) {
    return ['GPT-5.3 Codex: faster Codex-oriented option when GPT-5.4 feels heavy.'];
  }

  if (provider === 'codex' || normalized.includes('codex')) {
    return ['Codex family: remote agentic coding path through the local codex CLI login.'];
  }

  if (normalized.includes('llama')) {
    return ['Llama family: general local option; coding quality depends heavily on the checkpoint.'];
  }

  return [];
}

async function listOllamaModels(): Promise<{ models: string[]; notes: string[] }> {
  try {
    const { stdout } = await execFileAsync(getOllamaCommand(), ['list'], {
      windowsHide: true,
      timeout: 15_000,
    });
    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(1)
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);

    if (models.length > 0) {
      return {
        models,
        notes: ['Discovered from `ollama list`.'],
      };
    }

    return {
      models: [providerDefaultModel('ollama')],
      notes: ['No local Ollama models were found, so showing the default recommendation only.'],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      models: [providerDefaultModel('ollama')],
      notes: [`Could not query Ollama locally: ${message}`],
    };
  }
}

async function listOpenAIModels(baseUrl: string, apiKey: string | undefined): Promise<{ models: string[]; notes: string[] }> {
  if (!apiKey) {
    return {
      models: [],
      notes: ['Set `OPENAI_API_KEY` to fetch a live model list from the OpenAI-compatible `/models` endpoint.'],
    };
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        models: [],
        notes: [`Model listing failed (${response.status}): ${body || 'No response body.'}`],
      };
    }

    const payload = (await response.json()) as {
      data?: Array<{
        id?: unknown;
      }>;
    };

    const models = (payload.data ?? [])
      .map((item) => (typeof item.id === 'string' ? item.id : ''))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));

    return {
      models,
      notes: [`Fetched live model ids from ${baseUrl.replace(/\/+$/, '')}/models.`],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      models: [],
      notes: [`Could not fetch remote models: ${message}`],
    };
  }
}

function listCodexModels(currentModel: string): { models: string[]; notes: string[] } {
  const models = ['(provider default)'];
  if (currentModel.trim()) {
    models.push(currentModel.trim());
  }

  models.push('gpt-5.4');
  models.push('gpt-5.3-codex');
  models.push('GPT-5.1-Codex Max (documented family)');
  models.push('GPT-5.1-Codex Mini (documented family)');

  return {
    models: [...new Set(models)],
    notes: [
      'Codex CLI does not expose a machine-readable account model list.',
      'The entries above are documented common Codex choices, not an account-verified live list.',
      'Leave the model blank to use the Codex account default for your login.',
      'Explicit model ids must be supported by your Codex account and CLI release.',
    ],
  };
}

async function buildCatalog(config: AgentConfig, provider: ModelProvider): Promise<ProviderModelCatalog> {
  const currentModel =
    config.provider === provider
      ? config.model
      : resolveStoredModelForProvider(provider, process.env, { allowLegacy: false });
  const defaultModel = providerDefaultModel(provider);

  if (provider === 'ollama') {
    const { models, notes } = await listOllamaModels();
    return { provider, currentModel, defaultModel, models, notes };
  }

  if (provider === 'openai') {
    const baseUrl =
      config.provider === 'openai'
        ? config.baseUrl
        : process.env.OPENAI_BASE_URL || providerDefaultBaseUrl('openai');
    const apiKey =
      config.provider === 'openai' ? config.apiKey : process.env.OPENAI_API_KEY || undefined;
    const { models, notes } = await listOpenAIModels(baseUrl, apiKey);
    return { provider, currentModel, defaultModel, models, notes };
  }

  const { models, notes } = listCodexModels(currentModel);
  return { provider, currentModel, defaultModel, models, notes };
}

function renderCatalog(catalog: ProviderModelCatalog, options: RenderCatalogOptions = {}): string {
  const filteredModels = options.query
    ? catalog.models.filter((model) => matchesModelQuery(model, options.query!))
    : catalog.models;
  const lines = [
    `provider     ${catalog.provider}`,
    `current      ${currentModelLabel(catalog.currentModel)}`,
    `default      ${currentModelLabel(catalog.defaultModel)}`,
    ...(options.query ? [`filter       ${options.query}`] : []),
    'available',
  ];

  if (filteredModels.length === 0) {
    lines.push(options.query ? '- (no models matched this filter)' : '- (no live list available)');
  } else {
    for (const model of filteredModels) {
      lines.push(`- ${model}`);
    }
  }

  const insightSeed = options.query
    ? filteredModels
    : [catalog.currentModel.trim()].filter(Boolean);
  const insights = [...new Set(insightSeed.flatMap((model) => describeModelFamily(catalog.provider, model)))];

  if (insights.length > 0) {
    lines.push(options.query ? 'match hints' : 'current hint');
    for (const insight of insights) {
      lines.push(`- ${insight}`);
    }
  }

  if (catalog.notes.length > 0) {
    lines.push('notes');
    for (const note of catalog.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join('\n');
}

export async function renderModelCatalogs(
  config: AgentConfig,
  scope: 'current' | 'all' | ModelProvider,
  options: RenderCatalogOptions = {}
): Promise<string> {
  const providers: ModelProvider[] =
    scope === 'all' ? ['ollama', 'openai', 'codex'] : [scope === 'current' ? config.provider : scope];
  const catalogs = await Promise.all(providers.map((provider) => buildCatalog(config, provider)));
  return catalogs.map((catalog) => renderCatalog(catalog, options)).join('\n\n');
}
