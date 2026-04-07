import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isModelCompatible,
  providerDefaultBaseUrl as getProviderDefaultBaseUrl,
  providerDefaultModel as getProviderDefaultModel,
  resolveStoredModelForProvider,
} from './providerModels.js';
import type { AgentConfig, ModelProvider, ParsedCliInput } from './types.js';

type ArgValue = string | boolean;

function normalizeProvider(input: string | undefined): ModelProvider {
  const value = (input ?? 'ollama').trim().toLowerCase();
  if (value === 'openai' || value === 'openai-compatible') {
    return 'openai';
  }
  if (value === 'codex') {
    return 'codex';
  }
  return 'ollama';
}

function parseBoolean(input: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof input === 'boolean') {
    return input;
  }
  if (input === undefined) {
    return fallback;
  }

  const normalized = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseNumber(input: string | boolean | undefined, fallback: number): number {
  if (typeof input !== 'string') {
    return fallback;
  }
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv: string[]): { flags: Record<string, ArgValue>; prompt?: string; showHelp: boolean } {
  const flags: Record<string, ArgValue> = {};
  const positional: string[] = [];
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--help' || token === '-h') {
      showHelp = true;
      continue;
    }

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex !== -1) {
      flags[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
      continue;
    }

    const nextToken = argv[index + 1];
    if (!nextToken || nextToken.startsWith('--')) {
      flags[trimmed] = true;
      continue;
    }

    flags[trimmed] = nextToken;
    index += 1;
  }

  const prompt =
    typeof flags.prompt === 'string' ? flags.prompt : positional.join(' ').trim() || undefined;

  return { flags, prompt, showHelp };
}

export function createConfigFromInputs(argv: string[]): ParsedCliInput {
  const parsed = parseArgs(argv);
  const providerFlag =
    typeof parsed.flags.provider === 'string' ? parsed.flags.provider : undefined;
  const provider = normalizeProvider(
    providerFlag ?? process.env.MODEL_PROVIDER
  );

  const workdir = resolve(
    typeof parsed.flags.workdir === 'string'
      ? parsed.flags.workdir
      : process.env.AGENT_WORKDIR || process.cwd()
  );

  if (!existsSync(workdir)) {
    throw new Error(`Workdir does not exist: ${workdir}`);
  }

  const modelInput =
    typeof parsed.flags.model === 'string'
      ? parsed.flags.model
      : providerFlag
        ? resolveStoredModelForProvider(provider, process.env, { allowLegacy: false })
        : resolveStoredModelForProvider(provider);
  const model = isModelCompatible(provider, modelInput) ? modelInput : getProviderDefaultModel(provider);

  const baseUrlInput =
    typeof parsed.flags['base-url'] === 'string'
      ? parsed.flags['base-url']
      : provider === 'openai'
        ? process.env.OPENAI_BASE_URL
        : provider === 'ollama'
          ? process.env.OLLAMA_BASE_URL
          : undefined;

  const config: AgentConfig = {
    provider,
    model,
    baseUrl: (baseUrlInput || getProviderDefaultBaseUrl(provider)).replace(/\/+$/, ''),
    apiKey:
      typeof parsed.flags['api-key'] === 'string'
        ? parsed.flags['api-key']
        : process.env.OPENAI_API_KEY || undefined,
    workdir,
    autoApprove: parseBoolean(
      parsed.flags['auto-approve'] ?? process.env.AGENT_AUTO_APPROVE,
      false
    ),
    maxTurns: Math.max(
      1,
      Math.floor(parseNumber(parsed.flags['max-turns'] ?? process.env.AGENT_MAX_TURNS, 8))
    ),
    temperature: Math.max(
      0,
      Math.min(
        1.5,
        parseNumber(parsed.flags.temperature ?? process.env.AGENT_TEMPERATURE, 0.2)
      )
    ),
  };

  return {
    config,
    prompt: parsed.prompt,
    showHelp: parsed.showHelp,
  };
}

export function renderConfigSummary(config: AgentConfig): string {
  const lines = [
    `provider     ${config.provider}`,
    `model        ${config.model || '(provider default)'}`,
    `baseUrl      ${config.provider === 'codex' ? '(managed by codex CLI)' : config.baseUrl}`,
    `workdir      ${config.workdir}`,
    `autoApprove  ${config.autoApprove}`,
    `maxTurns     ${config.maxTurns}`,
    `temperature  ${config.temperature}`,
  ];

  if (config.provider === 'openai') {
    lines.push(`apiKey       ${config.apiKey ? 'set' : 'missing'}`);
  }

  if (config.provider === 'codex') {
    lines.push('auth         ChatGPT login via codex CLI');
  }

  return lines.join('\n');
}

export function updateConfig(current: AgentConfig, patch: Partial<AgentConfig>): AgentConfig {
  return {
    ...current,
    ...patch,
  };
}

export function providerDefaultBaseUrl(provider: ModelProvider): string {
  return getProviderDefaultBaseUrl(provider);
}

export function providerDefaultModel(provider: ModelProvider): string {
  return getProviderDefaultModel(provider);
}
