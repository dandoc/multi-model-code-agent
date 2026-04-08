import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { AgentRunner } from './agent.js';
import {
  createConfigFromInputs,
  providerDefaultBaseUrl,
  providerDefaultModel,
  renderConfigSummary,
  resolveValidatedWorkdir,
  updateConfig,
} from './config.js';
import { loadDotEnv, updateDotEnv } from './env.js';
import { createModelAdapter } from './modelAdapters.js';
import {
  isModelCompatible,
  providerBaseUrlEnvKey,
  providerModelEnvKey,
  renderModelCatalogs,
  resolveStoredModelForProvider,
} from './providerModels.js';
import {
  createSessionStore,
  renderSessionHistory,
  renderSessionList,
  resolveSessionEntry,
} from './sessionStore.js';
import { createTools, renderToolCatalog } from './tools.js';

import type { AgentConfig, ModelProvider } from './types.js';

function printStartupHelp(): void {
  console.log(
    [
      'Multi Model Code Agent',
      '',
      'Usage:',
      '  npm run dev -- --provider ollama --model qwen2.5-coder:7b --workdir D:\\project',
      '  npm run dev -- --provider openai --model your-model --base-url https://api.example/v1',
      '  npm run dev -- --provider codex --workdir D:\\project',
      '',
      'Options:',
      '  --provider <ollama|openai|codex>',
      '  --model <name>',
      '  --base-url <url>',
      '  --api-key <value>',
      '  --workdir <path>',
      '  --auto-approve',
      '  --max-turns <number>',
      '  --temperature <number>',
      '  --prompt "one shot prompt"',
      '  --help',
    ].join('\n')
  );
}

function printReplHelp(): void {
  console.log(
    [
      '',
      'REPL commands:',
      '  /help                 Show this help',
      '  /config               Show current config',
      '  /history [count]      Show recent events from the current saved session',
      '  /history latest [count] or /history <session-id> [count]',
      '                       Show events from an earlier saved session',
      '  /sessions [count]     Show recent saved sessions',
      '  /tools                Show tool catalog',
      '  /reset                Clear conversation history',
      '  /provider <name>      Switch provider (ollama, openai, codex) and save it to .env',
      '  /model <name>         Switch model and save it to .env',
      '  /model default        Reset model to the provider default',
      '  /models [scope]       Show models for current, all, or one provider',
      '  /base-url <url>       Switch base URL and save it to .env',
      '  /api-key <value>      Set API key for this session',
      '  /workdir <path>       Change workdir',
      '  /approve on|off       Toggle auto approval',
      '  /quit                 Exit',
      '',
    ].join('\n')
  );
}

function normalizeProvider(inputValue: string): ModelProvider | null {
  const value = inputValue.trim().toLowerCase();
  if (value === 'ollama') {
    return 'ollama';
  }
  if (value === 'openai' || value === 'openai-compatible') {
    return 'openai';
  }
  if (value === 'codex') {
    return 'codex';
  }
  return null;
}

function answerRuntimeConfigQuestion(inputValue: string, config: AgentConfig): string | null {
  const normalized = inputValue.trim().toLowerCase();
  const asksAboutModel =
    normalized.includes('current model') ||
    normalized.includes('what model') ||
    normalized.includes('which model') ||
    inputValue.includes('현재') && inputValue.includes('모델') ||
    inputValue.includes('너의 모델');
  const asksAboutProvider =
    normalized.includes('current provider') ||
    normalized.includes('which provider') ||
    inputValue.includes('현재') && (inputValue.includes('provider') || inputValue.includes('프로바이더')) ||
    inputValue.includes('너의 프로바이더');
  const asksAboutConfig =
    normalized === 'config' ||
    normalized === 'current config' ||
    inputValue.includes('현재 설정');

  if (!asksAboutModel && !asksAboutProvider && !asksAboutConfig) {
    return null;
  }

  return renderConfigSummary(config);
}

function ensureProviderReady(config: AgentConfig): void {
  if (config.provider === 'openai' && !config.apiKey) {
    throw new Error(
      'The openai provider requires an API key. Set OPENAI_API_KEY in .env or use /api-key in the REPL.'
    );
  }

  if (config.provider === 'openai' && !config.model.trim()) {
    throw new Error(
      'The openai provider requires a model name. Use /model <name> or set OPENAI_MODEL_NAME in .env.'
    );
  }

  if (!isModelCompatible(config.provider, config.model)) {
    throw new Error(
      `The model \`${config.model}\` is not compatible with provider \`${config.provider}\`. Use /models to inspect choices or /model default to reset.`
    );
  }
}

function parsePositiveCount(value: string | undefined, fallback: number, max = 50): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(max, parsed));
}

function parseHistoryRequest(entry: string): { sessionRef?: string; count: number } {
  const args = entry
    .slice('/history'.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    return { count: 12 };
  }

  if (args.length === 1) {
    const maybeCount = Number.parseInt(args[0], 10);
    if (Number.isFinite(maybeCount) && maybeCount > 0) {
      return { count: parsePositiveCount(args[0], 12) };
    }

    return { sessionRef: args[0], count: 12 };
  }

  return {
    sessionRef: args[0],
    count: parsePositiveCount(args[1], 12),
  };
}

async function main(): Promise<void> {
  const launchCwd = process.cwd();
  loadDotEnv(launchCwd);

  const parsed = createConfigFromInputs(process.argv.slice(2));
  if (parsed.showHelp) {
    printStartupHelp();
    return;
  }

  const tools = createTools();
  const rl = createInterface({ input, output });

  let config = parsed.config;
  let adapter = createModelAdapter(config);
  let sessionStore = await createSessionStore(config, launchCwd, parsed.prompt ? 'one-shot' : 'startup');

  const ui = {
    confirm: async (message: string): Promise<boolean> => {
      const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
      return ['y', 'yes'].includes(answer);
    },
    log: (message: string): void => {
      console.log(`\n[agent] ${message}`);
    },
  };

  const agent = new AgentRunner(config, adapter, tools, ui);

  const logSessionEvent = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\nWarning: could not write session log: ${message}`);
    }
  };

  const persistLaunchSettings = async (updates: Record<string, string>): Promise<boolean> => {
    try {
      await updateDotEnv(launchCwd, updates);
      for (const [key, value] of Object.entries(updates)) {
        process.env[key] = value;
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\nWarning: could not save .env settings: ${message}`);
      return false;
    }
  };

  const rebuildRuntime = (nextConfig: AgentConfig, resetConversation: boolean): void => {
    config = nextConfig;
    adapter = createModelAdapter(config);
    agent.updateConfig(config);
    agent.updateAdapter(adapter);
    if (resetConversation) {
      agent.reset();
    }
  };

  const runPrompt = async (text: string): Promise<void> => {
    const runtimeAnswer = answerRuntimeConfigQuestion(text, config);
    console.log(`\n[user] ${text}`);
    await logSessionEvent(() => sessionStore.logMessage('user', text));
    if (runtimeAnswer) {
      console.log(`\n[assistant] ${runtimeAnswer}\n`);
      await logSessionEvent(() => sessionStore.logMessage('assistant', runtimeAnswer));
      return;
    }
    ensureProviderReady(config);
    const reply = await agent.runTurn(text);
    console.log(`\n[assistant] ${reply}\n`);
    await logSessionEvent(() => sessionStore.logMessage('assistant', reply));
  };

  try {
    if (parsed.prompt) {
      await runPrompt(parsed.prompt);
      return;
    }

    console.log('Multi Model Code Agent');
    console.log('Type /help for commands.\n');
    console.log(renderConfigSummary(config));

    while (true) {
      const entry = (await rl.question('\n> ')).trim();
      if (!entry) {
        continue;
      }

      if (!entry.startsWith('/')) {
        await runPrompt(entry);
        continue;
      }

      if (entry === '/quit') {
        break;
      }

      if (entry === '/help') {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        printReplHelp();
        continue;
      }

      if (entry === '/config') {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        console.log(`\n${renderConfigSummary(config)}`);
        continue;
      }

      if (entry === '/history' || entry.startsWith('/history ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const request = parseHistoryRequest(entry);

        if (!request.sessionRef || request.sessionRef === 'current') {
          console.log(`\n${await renderSessionHistory(sessionStore.sessionPath, request.count)}`);
          continue;
        }

        try {
          const sessionEntry = await resolveSessionEntry(request.sessionRef, sessionStore.sessionId);
          if (!sessionEntry) {
            console.log(
              `\nCould not find a saved session for "${request.sessionRef}". Use /sessions to inspect recent ids.`
            );
            continue;
          }

          console.log(`\n${await renderSessionHistory(sessionEntry.sessionPath, request.count)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`\n${message}`);
        }
        continue;
      }

      if (entry === '/sessions' || entry.startsWith('/sessions ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const requestedCount = entry === '/sessions' ? undefined : entry.slice('/sessions '.length).trim();
        const count = parsePositiveCount(requestedCount, 8, 30);
        console.log(`\n${await renderSessionList(count, sessionStore.sessionId)}`);
        continue;
      }

      if (entry === '/tools') {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        console.log(`\n${renderToolCatalog(tools)}`);
        continue;
      }

      if (entry === '/reset') {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        agent.reset();
        console.log('\nConversation reset.');
        continue;
      }

      if (entry.startsWith('/provider ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const provider = normalizeProvider(entry.slice('/provider '.length));
        if (!provider) {
          console.log('\nUnknown provider. Use ollama, openai, or codex.');
          continue;
        }

        const nextBaseUrlKey = providerBaseUrlEnvKey(provider);
        const nextBaseUrl =
          (nextBaseUrlKey ? process.env[nextBaseUrlKey] : undefined) ?? providerDefaultBaseUrl(provider);
        const nextModel = resolveStoredModelForProvider(provider, process.env, {
          allowLegacy: false,
        });

        rebuildRuntime(
          updateConfig(config, {
            provider,
            baseUrl: nextBaseUrl,
            model: nextModel,
          }),
          true
        );
        const updates: Record<string, string> = {
          MODEL_PROVIDER: provider,
          MODEL_NAME: '',
          [providerModelEnvKey(provider)]: nextModel,
        };
        if (nextBaseUrlKey) {
          updates[nextBaseUrlKey] = nextBaseUrl;
        }
        const saved = await persistLaunchSettings(updates);
        await logSessionEvent(() => sessionStore.logConfig('provider switch', config));
        console.log(
          `\nProvider switched to ${provider}. Conversation reset.${saved ? ' Saved to .env.' : ''}`
        );
        continue;
      }

      if (entry.startsWith('/model ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const requestedModel = entry.slice('/model '.length).trim();
        const nextModel =
          requestedModel.toLowerCase() === 'default' ? providerDefaultModel(config.provider) : requestedModel;
        if (requestedModel && requestedModel.toLowerCase() !== 'default' && !isModelCompatible(config.provider, nextModel)) {
          console.log(
            `\nThe model "${nextModel}" does not look compatible with provider ${config.provider}. Use /models to inspect choices or /model default to reset.`
          );
          continue;
        }
        rebuildRuntime(
          updateConfig(config, {
            model: nextModel,
          }),
          true
        );
        const saved = await persistLaunchSettings({
          MODEL_NAME: '',
          [providerModelEnvKey(config.provider)]: nextModel,
        });
        await logSessionEvent(() => sessionStore.logConfig('model switch', config));
        console.log(
          `\nModel switched to ${config.model || '(provider default)'}. Conversation reset.${saved ? ' Saved to .env.' : ''}`
        );
        continue;
      }

      if (entry.startsWith('/models')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const requestedScope = entry.slice('/models'.length).trim().toLowerCase();
        const scope =
          !requestedScope || requestedScope === 'current'
            ? 'current'
            : requestedScope === 'all'
              ? 'all'
              : normalizeProvider(requestedScope);

        if (!scope) {
          console.log('\nUse /models, /models all, or /models <ollama|openai|codex>.');
          continue;
        }

        console.log(`\n${await renderModelCatalogs(config, scope)}`);
        continue;
      }

      if (entry.startsWith('/base-url ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        if (config.provider === 'codex') {
          console.log('\nThe codex provider uses the local codex CLI, so base URL is not used.');
          continue;
        }

        const nextBaseUrl = entry.slice('/base-url '.length).trim().replace(/\/+$/, '');
        rebuildRuntime(
          updateConfig(config, {
            baseUrl: nextBaseUrl,
          }),
          true
        );
        const currentBaseUrlKey = providerBaseUrlEnvKey(config.provider);
        const saved = await persistLaunchSettings(
          currentBaseUrlKey ? { [currentBaseUrlKey]: nextBaseUrl } : {}
        );
        await logSessionEvent(() => sessionStore.logConfig('base-url update', config));
        console.log(`\nBase URL updated. Conversation reset.${saved ? ' Saved to .env.' : ''}`);
        continue;
      }

      if (entry.startsWith('/api-key ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        if (config.provider === 'codex') {
          console.log(
            '\nThe codex provider uses ChatGPT login through codex CLI, so API keys are not used.'
          );
          continue;
        }

        rebuildRuntime(
          updateConfig(config, {
            apiKey: entry.slice('/api-key '.length).trim(),
          }),
          false
        );
        await logSessionEvent(() => sessionStore.logConfig('api-key update', config));
        console.log('\nAPI key updated for this session.');
        continue;
      }

      if (entry.startsWith('/workdir ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        try {
          const nextWorkdir = resolveValidatedWorkdir(entry.slice('/workdir '.length).trim());
          rebuildRuntime(
            updateConfig(config, {
              workdir: nextWorkdir,
            }),
            true
          );
          sessionStore = await createSessionStore(config, launchCwd, 'workdir switch');
          console.log(`\nWorkdir switched to ${nextWorkdir}. Conversation reset.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`\n${message}`);
        }
        continue;
      }

      if (entry.startsWith('/approve ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const mode = entry.slice('/approve '.length).trim().toLowerCase();
        if (mode !== 'on' && mode !== 'off') {
          console.log('\nUse /approve on or /approve off.');
          continue;
        }

        rebuildRuntime(
          updateConfig(config, {
            autoApprove: mode === 'on',
          }),
          false
        );
        await logSessionEvent(() => sessionStore.logConfig('approval mode update', config));
        console.log(`\nAuto approve is now ${config.autoApprove}.`);
        continue;
      }

      await logSessionEvent(() => sessionStore.logCommand(entry));

      console.log('\nUnknown command. Type /help.');
    }
  } finally {
    await logSessionEvent(() => sessionStore.logCommand('/quit'));
    rl.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFatal error: ${message}`);
  process.exitCode = 1;
});
