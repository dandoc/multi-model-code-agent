import { fileURLToPath } from 'node:url';

import { createConfigFromInputs } from './config.js';
import { loadDotEnv } from './env.js';
import { parseAgentEnvelope } from './jsonProtocol.js';
import { createModelAdapter, diagnoseProviderFailure } from './modelAdapters.js';
import {
  collectProviderDiagnostics,
  resolveProviderRuntime,
  type DiagnosticCheck,
  type ProviderDiagnostics,
} from './providerModels.js';

import type { AgentConfig, ChatMessage, ModelAdapter, ModelProvider } from './types.js';

export type LiveProviderSmokeMode = 'quick' | 'protocol' | 'all';

type LiveSmokeCheckName = 'quick' | 'protocol';

type LiveSmokeCheckResult = {
  name: LiveSmokeCheckName;
  status: 'passed' | 'failed';
  elapsedMs: number;
  summary: string;
  detailLines: string[];
  replyPreview?: string;
};

export type LiveProviderSmokeResult = {
  provider: ModelProvider;
  currentModel: string;
  baseUrl: string;
  status: 'passed' | 'blocked' | 'failed';
  summary: string;
  detailLines: string[];
  checks: LiveSmokeCheckResult[];
};

type LiveProviderSmokeDeps = {
  collectDiagnostics?: (
    config: AgentConfig,
    scope: 'current' | 'all' | ModelProvider
  ) => Promise<ProviderDiagnostics[]>;
  adapterFactory?: (config: AgentConfig) => ModelAdapter;
  targetConfigFactory?: (config: AgentConfig, provider: ModelProvider) => AgentConfig;
  now?: () => number;
};

const QUICK_SMOKE_MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Reply with exactly OK.' }];
const PROTOCOL_SMOKE_MESSAGES: ChatMessage[] = [
  {
    role: 'user',
    content:
      'Reply with exactly this JSON object and nothing else: {"type":"message","message":"OK"}',
  },
];
const BLOCKING_WARNING_LABELS = new Set([
  'base URL',
  'API key',
  'model selection',
  'installed models',
  'ChatGPT login',
  'Codex CLI',
  'local CLI',
]);

function formatElapsed(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  return `${(ms / 1_000).toFixed(1)}s`;
}

function normalizeReplyPreview(reply: string): string {
  return reply.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function buildTargetConfig(config: AgentConfig, provider: ModelProvider): AgentConfig {
  const runtime = resolveProviderRuntime(config, provider);
  return {
    ...config,
    provider,
    model: runtime.model,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
  };
}

function findBlockingChecks(diagnostics: ProviderDiagnostics): DiagnosticCheck[] {
  return diagnostics.checks.filter(
    (check) => check.level === 'error' || (check.level === 'warn' && BLOCKING_WARNING_LABELS.has(check.label))
  );
}

function resolveSmokeChecks(mode: LiveProviderSmokeMode): LiveSmokeCheckName[] {
  if (mode === 'quick') {
    return ['quick'];
  }

  if (mode === 'protocol') {
    return ['protocol'];
  }

  return ['quick', 'protocol'];
}

async function runSmokeCheck(
  adapter: ModelAdapter,
  config: AgentConfig,
  check: LiveSmokeCheckName,
  now: () => number
): Promise<LiveSmokeCheckResult> {
  const messages = check === 'quick' ? QUICK_SMOKE_MESSAGES : PROTOCOL_SMOKE_MESSAGES;
  const startedAt = now();
  const reply = await adapter.complete(messages, config);
  const elapsedMs = now() - startedAt;
  const preview = normalizeReplyPreview(reply);

  if (check === 'quick') {
    if (!preview) {
      return {
        name: check,
        status: 'failed',
        elapsedMs,
        summary: 'The provider returned an empty assistant reply.',
        detailLines: ['The smoke prompt completed but the assistant reply was empty.'],
      };
    }

    return {
      name: check,
      status: 'passed',
      elapsedMs,
      summary: 'Live completion reply succeeded.',
      detailLines: [],
      replyPreview: preview,
    };
  }

  const envelope = parseAgentEnvelope(reply);
  if (envelope.type === 'message' && envelope.message.trim() === 'OK') {
    return {
      name: check,
      status: 'passed',
      elapsedMs,
      summary: 'Structured message envelope parsed successfully.',
      detailLines: [],
      replyPreview: preview || '{"type":"message","message":"OK"}',
    };
  }

  return {
    name: check,
    status: 'failed',
    elapsedMs,
    summary: 'The provider replied, but not in the expected structured message format.',
    detailLines: [
      `Parsed envelope type: ${envelope.type}`,
      envelope.type === 'message'
        ? `Parsed message: ${envelope.message.trim() || '(empty)'}`
        : `Parsed tool call: ${envelope.tool}`,
    ],
    replyPreview: preview || undefined,
  };
}

export async function runLiveProviderSmoke(
  config: AgentConfig,
  scope: 'current' | 'all' | ModelProvider,
  mode: LiveProviderSmokeMode = 'all',
  deps: LiveProviderSmokeDeps = {}
): Promise<LiveProviderSmokeResult[]> {
  const diagnostics = await (deps.collectDiagnostics ?? collectProviderDiagnostics)(config, scope);
  const now = deps.now ?? Date.now;
  const adapterFactory = deps.adapterFactory ?? createModelAdapter;
  const results: LiveProviderSmokeResult[] = [];
  const plannedChecks = resolveSmokeChecks(mode);

  for (const entry of diagnostics) {
    const nextConfig = (deps.targetConfigFactory ?? buildTargetConfig)(config, entry.provider);
    const blockingChecks = findBlockingChecks(entry);
    if (blockingChecks.length > 0) {
      results.push({
        provider: entry.provider,
        currentModel: entry.currentModel,
        baseUrl: entry.baseUrl,
        status: 'blocked',
        summary: 'Skipped live request because readiness checks already found blocking issues.',
        detailLines: blockingChecks.map((check) =>
          `${check.level} ${check.label}: ${check.detail}${check.hint ? ` | hint: ${check.hint}` : ''}`
        ),
        checks: [],
      });
      continue;
    }

    const adapter = adapterFactory(nextConfig);
    try {
      const checks: LiveSmokeCheckResult[] = [];
      for (const check of plannedChecks) {
        checks.push(await runSmokeCheck(adapter, nextConfig, check, now));
      }

      const failedChecks = checks.filter((check) => check.status === 'failed');
      results.push({
        provider: entry.provider,
        currentModel: entry.currentModel,
        baseUrl: entry.baseUrl,
        status: failedChecks.length === 0 ? 'passed' : 'failed',
        summary:
          failedChecks.length === 0
            ? `All ${checks.length} live smoke check${checks.length === 1 ? '' : 's'} passed.`
            : `${failedChecks.length} of ${checks.length} live smoke check${
                checks.length === 1 ? '' : 's'
              } failed.`,
        detailLines: [],
        checks,
      });
    } catch (error) {
      const diagnosis = diagnoseProviderFailure(nextConfig, error);
      results.push({
        provider: entry.provider,
        currentModel: entry.currentModel,
        baseUrl: entry.baseUrl,
        status: 'failed',
        summary: diagnosis.summary,
        detailLines: [
          ...diagnosis.likelyCauses.map((item) => `cause: ${item}`),
          ...diagnosis.nextSteps.map((item) => `next: ${item}`),
          `detail: ${diagnosis.detail}`,
        ],
        checks: [],
      });
    }
  }

  return results;
}

export function renderLiveProviderSmokeResults(results: LiveProviderSmokeResult[]): string {
  if (results.length === 0) {
    return 'No providers were selected for live smoke.';
  }

  return results
    .map((result) => {
      const lines = [
        `provider     ${result.provider}`,
        'mode         smoke',
        `status       ${result.status}`,
        `current      ${result.currentModel.trim() || '(provider default)'}`,
      ];

      if (result.provider !== 'codex') {
        lines.push(`baseUrl      ${result.baseUrl || '(not set)'}`);
      }

      lines.push(`summary      ${result.summary}`);

      if (result.checks.length > 0) {
        lines.push('checks');
        for (const check of result.checks) {
          lines.push(
            `- ${check.status.padEnd(6)} ${check.name.padEnd(8)} ${formatElapsed(check.elapsedMs)}: ${check.summary}`
          );
          if (check.replyPreview) {
            lines.push(`  reply: ${check.replyPreview}`);
          }
          for (const detail of check.detailLines) {
            lines.push(`  detail: ${detail}`);
          }
        }
      }

      if (result.detailLines.length > 0) {
        lines.push('details');
        for (const line of result.detailLines) {
          lines.push(`- ${line}`);
        }
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

function parseScope(value: string | undefined): 'current' | 'all' | ModelProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'current') {
    return 'current';
  }
  if (normalized === 'all') {
    return 'all';
  }
  if (normalized === 'ollama' || normalized === 'openai' || normalized === 'codex') {
    return normalized;
  }
  throw new Error('Use smoke:live [current|all|ollama|openai|codex].');
}

function parseMode(value: string | undefined): LiveProviderSmokeMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'all') {
    return 'all';
  }
  if (normalized === 'quick' || normalized === 'protocol') {
    return normalized;
  }
  throw new Error('Use smoke:live [current|all|ollama|openai|codex] [quick|protocol|all].');
}

async function main(): Promise<void> {
  const launchCwd = process.cwd();
  loadDotEnv(launchCwd);
  const scope = parseScope(process.argv[2]);
  const mode = parseMode(process.argv[3]);
  const config = createConfigFromInputs([]).config;
  const results = await runLiveProviderSmoke(
    {
      ...config,
      workdir: launchCwd,
    },
    scope,
    mode
  );
  console.log(renderLiveProviderSmokeResults(results));
  if (results.some((result) => result.status !== 'passed')) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[live-provider-smoke] Failed: ${message}`);
    process.exitCode = 1;
  });
}
