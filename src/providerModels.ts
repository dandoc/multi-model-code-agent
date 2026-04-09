import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getCodexLoginStatus } from './modelAdapters.js';
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

type DiagnosticLevel = 'ok' | 'warn' | 'error' | 'info';
type DiagnosticStatus = 'ready' | 'warning' | 'blocked';

export type DiagnosticCheck = {
  level: DiagnosticLevel;
  label: string;
  detail: string;
  hint?: string;
};

export type ProviderDiagnostics = {
  provider: ModelProvider;
  currentModel: string;
  baseUrl: string;
  status: DiagnosticStatus;
  checks: DiagnosticCheck[];
};

type RuntimePreflightIssueLevel = 'warn' | 'error';

type RuntimePreflightIssue = {
  level: RuntimePreflightIssueLevel;
  label: string;
  detail: string;
  hint?: string;
};

export type RuntimeTransitionPreflight = {
  provider: ModelProvider;
  currentModel: string;
  baseUrl: string;
  status: DiagnosticStatus;
  issues: RuntimePreflightIssue[];
};

type OllamaProbeResult = {
  available: boolean;
  detail: string;
  models: string[];
};

type OpenAIProbeResult = {
  reachable: boolean;
  detail: string;
  models: string[];
};

type CodexProbeResult = Awaited<ReturnType<typeof getCodexLoginStatus>>;

type ProviderDiagnosticDeps = {
  probeOllama?: () => Promise<OllamaProbeResult>;
  probeOpenAI?: (baseUrl: string, apiKey: string) => Promise<OpenAIProbeResult>;
  probeCodex?: (config: AgentConfig) => Promise<CodexProbeResult>;
};

type RuntimePreflightDeps = {
  probeOllama?: () => Promise<OllamaProbeResult>;
  probeCodex?: (config: AgentConfig) => Promise<CodexProbeResult>;
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

async function probeOllamaAvailability(): Promise<OllamaProbeResult> {
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

    return {
      available: true,
      detail: 'The local `ollama list` command responded successfully.',
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      detail: `Could not run \`ollama list\`: ${message}`,
      models: [],
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

async function probeOpenAIEndpoint(baseUrl: string, apiKey: string): Promise<OpenAIProbeResult> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return {
        reachable: false,
        detail: `The OpenAI-compatible /models request failed with ${response.status}.`,
        models: [],
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
      reachable: true,
      detail: 'The OpenAI-compatible /models endpoint responded successfully.',
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      detail: `Could not reach the OpenAI-compatible /models endpoint: ${message}`,
      models: [],
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

export function resolveProviderRuntime(
  config: AgentConfig,
  provider: ModelProvider
): { model: string; baseUrl: string; apiKey?: string } {
  if (config.provider === provider) {
    return {
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    };
  }

  return {
    model: resolveStoredModelForProvider(provider, process.env, { allowLegacy: false }),
    baseUrl:
      provider === 'codex'
        ? ''
        : (process.env[providerBaseUrlEnvKey(provider) ?? ''] ?? providerDefaultBaseUrl(provider)),
    apiKey: provider === 'openai' ? process.env.OPENAI_API_KEY || undefined : undefined,
  };
}

function pushDiagnostic(
  checks: DiagnosticCheck[],
  level: DiagnosticLevel,
  label: string,
  detail: string,
  hint?: string
): void {
  checks.push({ level, label, detail, hint });
}

function pushPreflightIssue(
  issues: RuntimePreflightIssue[],
  level: RuntimePreflightIssueLevel,
  label: string,
  detail: string,
  hint?: string
): void {
  issues.push({ level, label, detail, hint });
}

function computeDiagnosticStatus(checks: DiagnosticCheck[]): DiagnosticStatus {
  if (checks.some((check) => check.level === 'error')) {
    return 'blocked';
  }

  if (checks.some((check) => check.level === 'warn')) {
    return 'warning';
  }

  return 'ready';
}

function computePreflightStatus(issues: RuntimePreflightIssue[]): DiagnosticStatus {
  if (issues.some((issue) => issue.level === 'error')) {
    return 'blocked';
  }

  if (issues.some((issue) => issue.level === 'warn')) {
    return 'warning';
  }

  return 'ready';
}

function isLikelyHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

async function buildProviderDiagnostics(
  config: AgentConfig,
  provider: ModelProvider,
  deps: ProviderDiagnosticDeps = {}
): Promise<ProviderDiagnostics> {
  const runtime = resolveProviderRuntime(config, provider);
  const currentModel = runtime.model.trim();
  const baseUrl = runtime.baseUrl.trim();
  const checks: DiagnosticCheck[] = [];

  if (currentModel && !isModelCompatible(provider, currentModel)) {
    pushDiagnostic(
      checks,
      'error',
      'model compatibility',
      `The configured model "${currentModel}" does not look compatible with provider ${provider}.`,
      'Use /models to inspect compatible choices or /model default to reset.'
    );
  } else if (!currentModel && provider !== 'codex') {
    const blankModelDetail =
      provider === 'openai'
          ? 'No explicit model is set for the OpenAI-compatible provider.'
          : `No explicit model is set, so the default recommendation (${providerDefaultModel(provider)}) will be used.`;
    pushDiagnostic(
      checks,
      provider === 'openai' ? 'warn' : 'info',
      'model selection',
      blankModelDetail,
      provider === 'openai' ? 'Set /model <name> before running requests against an OpenAI-compatible endpoint.' : undefined
    );
  } else if (provider !== 'codex') {
    pushDiagnostic(checks, 'ok', 'model selection', `Configured model: ${currentModel}`);
  }

  if (provider === 'ollama') {
    if (!baseUrl) {
      pushDiagnostic(
        checks,
        'error',
        'base URL',
        'No Ollama base URL is configured.',
        `Set /base-url ${providerDefaultBaseUrl('ollama')} or update OLLAMA_BASE_URL.`
      );
    } else if (!isLikelyHttpUrl(baseUrl)) {
      pushDiagnostic(
        checks,
        'error',
        'base URL',
        `The Ollama base URL "${baseUrl}" does not look like an http(s) endpoint.`,
        'Use a URL like http://127.0.0.1:11434.'
      );
    } else {
      pushDiagnostic(checks, 'ok', 'base URL', `Using Ollama base URL ${baseUrl}.`);
    }

    const probe = await (deps.probeOllama ?? probeOllamaAvailability)();
    if (!probe.available) {
      pushDiagnostic(
        checks,
        'error',
        'local CLI',
        probe.detail,
        'Install Ollama and confirm `ollama list` works in this shell.'
      );
    } else {
      pushDiagnostic(checks, 'ok', 'local CLI', probe.detail);
      const expectedModel = currentModel || providerDefaultModel('ollama');
      if (expectedModel && !probe.models.includes(expectedModel)) {
        pushDiagnostic(
          checks,
          'warn',
          'installed models',
          `The expected Ollama model "${expectedModel}" is not present in the local list.`,
          `Run \`ollama pull ${expectedModel}\` or switch to one of the installed models with /model.`
        );
      } else if (expectedModel) {
        pushDiagnostic(checks, 'ok', 'installed models', `The expected Ollama model "${expectedModel}" is installed locally.`);
      }
    }
  } else if (provider === 'openai') {
    if (!baseUrl) {
      pushDiagnostic(
        checks,
        'error',
        'base URL',
        'No OpenAI-compatible base URL is configured.',
        'Set /base-url <https://your-endpoint/v1> before using the openai provider.'
      );
    } else if (!isLikelyHttpUrl(baseUrl)) {
      pushDiagnostic(
        checks,
        'error',
        'base URL',
        `The OpenAI-compatible base URL "${baseUrl}" does not look like an http(s) endpoint.`,
        'Use a URL like https://api.openai.com/v1 or your compatible provider URL.'
      );
    } else {
      pushDiagnostic(checks, 'ok', 'base URL', `Using OpenAI-compatible base URL ${baseUrl}.`);
    }

    const baseUrlLooksValid = Boolean(baseUrl) && isLikelyHttpUrl(baseUrl);

    if (!runtime.apiKey) {
      pushDiagnostic(
        checks,
        'error',
        'API key',
        'No API key is configured for the OpenAI-compatible provider.',
        'Set OPENAI_API_KEY in .env or use /api-key <value> for the current session.'
      );
    } else {
      pushDiagnostic(checks, 'ok', 'API key', 'An API key is configured for the OpenAI-compatible provider.');
      if (!baseUrlLooksValid) {
        pushDiagnostic(
          checks,
          'warn',
          'live endpoint',
          'Skipped the live /models probe because the configured base URL is missing or invalid.',
          'Fix the base URL first, then re-run /models doctor.'
        );
      } else {
        const probe = await (deps.probeOpenAI ?? probeOpenAIEndpoint)(baseUrl, runtime.apiKey);
        if (!probe.reachable) {
          pushDiagnostic(
            checks,
            'warn',
            'live endpoint',
            probe.detail,
            'A 401/403 usually means the API key is missing or invalid; connection errors often mean the base URL is wrong.'
          );
        } else {
          pushDiagnostic(checks, 'ok', 'live endpoint', probe.detail);
          if (currentModel && probe.models.length > 0 && !probe.models.includes(currentModel)) {
            pushDiagnostic(
              checks,
              'warn',
              'live model list',
              `The configured model "${currentModel}" was not found in the live /models response.`,
              'Use /models openai to inspect the live model list or switch the configured model.'
            );
          } else if (currentModel && probe.models.length > 0) {
            pushDiagnostic(checks, 'ok', 'live model list', `The configured model "${currentModel}" appears in the live /models response.`);
          }
        }
      }
    }
  } else {
    const probe = await (deps.probeCodex ?? getCodexLoginStatus)(config);
    if (!probe.available) {
      pushDiagnostic(
        checks,
        'error',
        'Codex CLI',
        probe.detail,
        'Install the Codex CLI and make sure `codex` is available in this shell.'
      );
    } else if (!probe.loggedIn) {
      pushDiagnostic(
        checks,
        'error',
        'ChatGPT login',
        probe.detail,
        'Run `codex login` and verify `codex login status` before using the codex provider.'
      );
    } else {
      pushDiagnostic(checks, 'ok', 'ChatGPT login', 'Codex CLI is available and login status looks healthy.');
    }

    pushDiagnostic(
      checks,
      currentModel ? 'ok' : 'info',
      'model selection',
      currentModel
        ? `Codex will request the explicit model "${currentModel}".`
        : 'No explicit Codex model is set, so the account default will be used.'
    );
  }

  return {
    provider,
    currentModel,
    baseUrl,
    status: computeDiagnosticStatus(checks),
    checks,
  };
}

function renderProviderDiagnostics(diagnostics: ProviderDiagnostics): string {
  const lines = [
    `provider     ${diagnostics.provider}`,
    'mode         doctor',
    `status       ${diagnostics.status}`,
    `current      ${currentModelLabel(diagnostics.currentModel)}`,
  ];

  if (diagnostics.provider !== 'codex') {
    lines.push(`baseUrl      ${diagnostics.baseUrl || '(not set)'}`);
  }

  lines.push('checks');
  for (const check of diagnostics.checks) {
    const prefix = `${check.level.padEnd(5)} ${check.label}`;
    lines.push(`- ${prefix}: ${check.detail}`);
    if (check.hint) {
      lines.push(`  hint: ${check.hint}`);
    }
  }

  return lines.join('\n');
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

export async function renderModelDiagnostics(
  config: AgentConfig,
  scope: 'current' | 'all' | ModelProvider,
  deps: ProviderDiagnosticDeps = {}
): Promise<string> {
  const diagnostics = await collectProviderDiagnostics(config, scope, deps);
  return diagnostics.map((entry) => renderProviderDiagnostics(entry)).join('\n\n');
}

export async function collectProviderDiagnostics(
  config: AgentConfig,
  scope: 'current' | 'all' | ModelProvider,
  deps: ProviderDiagnosticDeps = {}
): Promise<ProviderDiagnostics[]> {
  const providers: ModelProvider[] =
    scope === 'all' ? ['ollama', 'openai', 'codex'] : [scope === 'current' ? config.provider : scope];
  return await Promise.all(
    providers.map((provider) => buildProviderDiagnostics(config, provider, deps))
  );
}

export async function buildRuntimeTransitionPreflight(
  nextConfig: AgentConfig,
  deps: RuntimePreflightDeps = {}
): Promise<RuntimeTransitionPreflight> {
  const issues: RuntimePreflightIssue[] = [];
  const currentModel = nextConfig.model.trim();
  const baseUrl = nextConfig.baseUrl.trim();

  if (currentModel && !isModelCompatible(nextConfig.provider, currentModel)) {
    pushPreflightIssue(
      issues,
      'error',
      'model compatibility',
      `The model "${currentModel}" does not look compatible with provider ${nextConfig.provider}.`,
      'Use /models to inspect choices or /model default to reset.'
    );
  }

  if (nextConfig.provider === 'ollama') {
    if (!baseUrl) {
      pushPreflightIssue(
        issues,
        'warn',
        'base URL',
        'No Ollama base URL is configured yet.',
        `Set /base-url ${providerDefaultBaseUrl('ollama')} if your local server uses the default endpoint.`
      );
    } else if (!isLikelyHttpUrl(baseUrl)) {
      pushPreflightIssue(
        issues,
        'warn',
        'base URL',
        `The Ollama base URL "${baseUrl}" does not look like an http(s) endpoint.`,
        'Use a URL like http://127.0.0.1:11434.'
      );
    }

    const probe = await (deps.probeOllama ?? probeOllamaAvailability)();
    if (!probe.available) {
      pushPreflightIssue(
        issues,
        'warn',
        'local CLI',
        probe.detail,
        'Install Ollama and confirm `ollama list` works before sending a request.'
      );
    } else if (currentModel && !probe.models.includes(currentModel)) {
      pushPreflightIssue(
        issues,
        'warn',
        'installed models',
        `The Ollama model "${currentModel}" is not present in the local list.`,
        `Run \`ollama pull ${currentModel}\` or switch to one of the installed models with /model.`
      );
    }
  } else if (nextConfig.provider === 'openai') {
    if (!baseUrl) {
      pushPreflightIssue(
        issues,
        'warn',
        'base URL',
        'No OpenAI-compatible base URL is configured yet.',
        'Set /base-url <https://your-endpoint/v1> before sending a request.'
      );
    } else if (!isLikelyHttpUrl(baseUrl)) {
      pushPreflightIssue(
        issues,
        'warn',
        'base URL',
        `The OpenAI-compatible base URL "${baseUrl}" does not look like an http(s) endpoint.`,
        'Use a URL like https://api.openai.com/v1 or your compatible provider URL.'
      );
    }

    if (!nextConfig.apiKey) {
      pushPreflightIssue(
        issues,
        'warn',
        'API key',
        'No API key is configured for the OpenAI-compatible provider.',
        'Set OPENAI_API_KEY in .env or use /api-key <value> for the current session.'
      );
    }

    if (!currentModel) {
      pushPreflightIssue(
        issues,
        'warn',
        'model selection',
        'No explicit model is set for the OpenAI-compatible provider.',
        'Use /model <name> before sending a request.'
      );
    }
  } else {
    const probe = await (deps.probeCodex ?? getCodexLoginStatus)(nextConfig);
    if (!probe.available) {
      pushPreflightIssue(
        issues,
        'warn',
        'Codex CLI',
        probe.detail,
        'Install the Codex CLI and make sure `codex` is available in this shell.'
      );
    } else if (!probe.loggedIn) {
      pushPreflightIssue(
        issues,
        'warn',
        'ChatGPT login',
        probe.detail,
        'Run `codex login` before sending a request with the codex provider.'
      );
    }
  }

  return {
    provider: nextConfig.provider,
    currentModel,
    baseUrl,
    status: computePreflightStatus(issues),
    issues,
  };
}

export function renderRuntimeTransitionPreflight(
  nextConfig: AgentConfig,
  preflight: RuntimeTransitionPreflight
): string {
  const lines = [
    'Runtime transition preflight',
    `target       provider=${nextConfig.provider}, model=${nextConfig.model || '(provider default)'}, workdir=${nextConfig.workdir}`,
    `status       ${preflight.status}`,
  ];

  if (preflight.issues.length === 0) {
    lines.push('No obvious readiness issues detected.');
    return lines.join('\n');
  }

  lines.push('checks');
  for (const issue of preflight.issues) {
    lines.push(`- ${issue.level.padEnd(5)} ${issue.label}: ${issue.detail}`);
    if (issue.hint) {
      lines.push(`  hint: ${issue.hint}`);
    }
  }

  return lines.join('\n');
}
