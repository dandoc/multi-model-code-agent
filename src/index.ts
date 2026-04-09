import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { AgentRunner } from './agent.js';
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createConfigFromInputs,
  providerDefaultBaseUrl,
  providerDefaultModel,
  renderConfigSummary,
  resolveValidatedWorkdir,
  updateConfig,
} from './config.js';
import { loadDotEnv, updateDotEnv } from './env.js';
import { renderLiveProviderSmokeResults, runLiveProviderSmoke } from './liveProviderMatrix.js';
import { createModelAdapter, diagnoseProviderFailure } from './modelAdapters.js';
import {
  deleteProfile,
  loadProfile,
  renameProfile,
  renderProfileDiff,
  renderProfileLoadPreview,
  renderMatchingProfilesLine,
  renderProfileList,
  saveProfile,
} from './profileStore.js';
import {
  buildRuntimeTransitionPreflight,
  isModelCompatible,
  normalizeProviderBaseUrl,
  providerBaseUrlEnvKey,
  providerModelEnvKey,
  renderModelCatalogs,
  renderModelDiagnostics,
  renderRuntimeTransitionPreflight,
  resolveStoredModelForProvider,
} from './providerModels.js';
import {
  createSessionStore,
  deleteSessionEntries,
  loadSessionConversation,
  planIdleSessionCleanup,
  planSessionDelete,
  planSessionPrune,
  renderResumeContext,
  renderRuntimeStatus,
  renderSessionComparison,
  renderSessionHistory,
  renderSessionList,
  renderSessionSummary,
  resolveSessionEntry,
} from './sessionStore.js';
import {
  normalizeReplCommandAlias,
  parseHistoryRequest,
  parseMaxTurnsRequest,
  parseModelsRequest,
  parseProfilesRequest,
  parseRequestTimeoutRequest,
  parseResumeRequest,
  parseSessionsRequest,
  parseTemperatureRequest,
  shouldLogHistoryViewCommand,
  shouldLogSessionsViewCommand,
} from './replCommands.js';
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
      '  --request-timeout-ms <number>',
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
      '  /status               Show current runtime + saved-session status',
      '  /history [count]      Show recent events from the current saved session',
        '  /history latest [count] or /history <session-id> [count]',
        '                       Show events from an earlier saved session',
        '  /resume [count]       Resume the latest earlier session into the current conversation',
        '  /resume latest [count] or /resume <session-id> [count]',
        '                       Replace the current conversation with saved user/assistant messages',
        '  /resume runtime latest [count] or /resume runtime <session-id> [count]',
        '                       Also restore provider/model/workdir/flags from the saved session',
        '  /sessions [count]     Show recent saved sessions',
        '  /sessions summary <current|latest|session-id> [count]',
        '                       Show a focused summary for one saved session',
      '  /sessions compare [count]',
      '                       Compare recent non-idle sessions by activity profile and event counts',
      '  /sessions compare all [count]',
      '                       Include idle sessions in the comparison view',
      '  /sessions search <query> [count]',
      '                       Search saved sessions by title, model, provider, workdir, or reason',
      '  /sessions delete <session-id>',
      '                       Delete one saved session by full or unique-prefix id',
        '  /sessions clear-idle [count]',
        '                       Delete idle saved sessions, oldest first',
        '  /sessions prune <keep-count>',
        '                       Keep the latest saved sessions and delete older ones',
        '  /profiles            Show saved runtime profiles',
        '  /profiles search <query>',
        '                       Filter saved profiles by name, provider, model, base URL, or workdir',
        '  /profiles diff <name>',
        '                       Show what would change if you loaded one saved profile now',
        '  /profiles save <name>',
        '                       Save the current provider/model/workdir/flags as a named profile',
        '  /profiles rename <old-name> --to <new-name>',
        '                       Rename one saved runtime profile',
        '  /profiles load <name>',
        '                       Restore a saved profile into the current runtime',
        '  /profiles delete <name>',
        '                       Delete one saved runtime profile',
        '  /session [count]      Alias for /sessions',
        '  /profile              Alias for /profiles',
        '  /title <text>         Set a custom title for the current session',
        '  /tools                Show tool catalog',
      '  /reset                Clear conversation history',
      '  /provider <name>      Switch provider (ollama, openai, codex) and save it to .env',
      '  /model <name>         Switch model and save it to .env',
      '  /model default        Reset model to the provider default',
      '  /models [scope]       Show models for current, all, or one provider',
      '  /models [scope] search <query>',
      '                       Filter available model names and show family hints',
      '  /models [scope] doctor',
      '                       Diagnose provider readiness and common failure causes',
      '  /models [scope] smoke [quick|protocol|all]',
      '                       Run live provider smoke checks for plain replies and/or structured JSON envelopes',
      '  /base-url <url>       Switch base URL and save it to .env',
      '  /api-key <value>      Set API key for this session',
      '  /workdir <path>       Change workdir',
      '  /temperature <value>  Set temperature for this session (0-1.5 or default)',
      `  /max-turns <value>    Set max turns for this session (1-100 or default=${DEFAULT_MAX_TURNS})`,
      '  /request-timeout <seconds>',
      `                       Set request timeout for this session (${Math.round(DEFAULT_REQUEST_TIMEOUT_MS / 1000)}s default)`,
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

function formatSessionEntryLabel(sessionId: string, title: string, lastActivityAt: string): string {
  return `- ${sessionId} | ${title} | last active ${lastActivityAt}`;
}

function renderProviderFailureReply(config: AgentConfig, error: unknown): string {
  const diagnosis = diagnoseProviderFailure(config, error);
  const lines = [
    '요청 처리 중 공급자 오류가 발생했습니다.',
    `Provider: ${config.provider}`,
    `Summary: ${diagnosis.summary}`,
  ];

  if (diagnosis.likelyCauses.length > 0) {
    lines.push('Likely causes:');
    for (const cause of diagnosis.likelyCauses) {
      lines.push(`- ${cause}`);
    }
  }

  if (diagnosis.nextSteps.length > 0) {
    lines.push('Next steps:');
    for (const step of diagnosis.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push(`Raw detail: ${diagnosis.detail}`);
  return lines.join('\n');
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
  let lastResumedSessionId: string | undefined;

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
      lastResumedSessionId = undefined;
    }
  };

  const runRuntimeTransitionPreflight = async (
    nextConfig: AgentConfig,
    options?: {
      requireConfirm?: boolean;
      confirmLabel?: string;
    }
  ): Promise<boolean> => {
    const preflight = await buildRuntimeTransitionPreflight(nextConfig);
    if (preflight.status === 'ready') {
      return true;
    }

    const rendered = renderRuntimeTransitionPreflight(nextConfig, preflight);
    if (!options?.requireConfirm) {
      console.log(`\n${rendered}`);
      return true;
    }

    const confirmed = await ui.confirm(
      [rendered, options.confirmLabel || 'Apply this runtime anyway?'].join('\n')
    );
    return confirmed;
  };

  const runPrompt = async (text: string): Promise<boolean> => {
    const runtimeAnswer = answerRuntimeConfigQuestion(text, config);
    console.log(`\n[user] ${text}`);
    await logSessionEvent(() => sessionStore.logMessage('user', text));
    if (runtimeAnswer) {
      console.log(`\n[assistant] ${runtimeAnswer}\n`);
      await logSessionEvent(() => sessionStore.logMessage('assistant', runtimeAnswer));
      return true;
    }

    try {
      ensureProviderReady(config);
      const reply = await agent.runTurn(text);
      console.log(`\n[assistant] ${reply}\n`);
      await logSessionEvent(() => sessionStore.logMessage('assistant', reply));
      return true;
    } catch (error) {
      const failureReply = renderProviderFailureReply(config, error);
      console.log(`\n[assistant] ${failureReply}\n`);
      await logSessionEvent(() => sessionStore.logMessage('assistant', failureReply));
      return false;
    }
  };

  try {
    if (parsed.prompt) {
      const ok = await runPrompt(parsed.prompt);
      if (!ok) {
        process.exitCode = 1;
      }
      return;
    }

    console.log('Multi Model Code Agent');
    console.log('Type /help for commands.\n');
    console.log(renderConfigSummary(config));

    while (true) {
      const entry = normalizeReplCommandAlias((await rl.question('\n> ')).trim());
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

      if (entry === '/status') {
        try {
          const currentConversation = await loadSessionConversation(sessionStore.sessionPath, 10);
          const profileLine = await renderMatchingProfilesLine(config);
          console.log(
            `\n${[
              renderRuntimeStatus(
                currentConversation,
                config,
                sessionStore.sessionPath,
                lastResumedSessionId
              ),
              profileLine,
            ].join('\n')}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`\n${message}`);
        }
        continue;
      }

      if (entry === '/history' || entry.startsWith('/history ')) {
        const request = parseHistoryRequest(entry);
        if (shouldLogHistoryViewCommand(request)) {
          await logSessionEvent(() => sessionStore.logCommand(entry));
        }

        if (!request.sessionRef || request.sessionRef === 'current') {
          console.log(`\n${await renderSessionHistory(sessionStore.sessionPath, request.count)}`);
          continue;
        }

        try {
          const resolution = await resolveSessionEntry(request.sessionRef, sessionStore.sessionId);
          if (!resolution.entry) {
            console.log(
              `\nCould not find a saved session for "${request.sessionRef}". Use /sessions to inspect recent ids.`
            );
            continue;
          }

          const history = await renderSessionHistory(resolution.entry.sessionPath, request.count);
          console.log(`\n${[resolution.warning, history].filter(Boolean).join('\n')}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`\n${message}`);
        }
        continue;
      }

      if (entry === '/resume' || entry.startsWith('/resume ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
          const request = parseResumeRequest(entry);

          try {
            const resolution = await resolveSessionEntry(request.sessionRef ?? 'latest', sessionStore.sessionId);
            if (!resolution.entry) {
            console.log(
              `\nCould not find a saved session for "${request.sessionRef ?? 'latest'}". Use /sessions to inspect recent ids.`
            );
            continue;
          }

          if (resolution.entry.sessionId === sessionStore.sessionId) {
            console.log('\nThe requested session is already the current session.');
            continue;
          }

          const loadedConversation = await loadSessionConversation(
            resolution.entry.sessionPath,
            request.count
          );

          if (loadedConversation.messages.length === 0) {
            console.log(
              `\n${[
                loadedConversation.warning,
                `Session ${loadedConversation.sessionId} has no saved user/assistant messages to resume.`,
              ]
                .filter(Boolean)
                .join('\n')}`
            );
              continue;
            }

            if (request.applyRuntime) {
              if (!loadedConversation.provider) {
                console.log('\nThis saved session is missing a readable provider, so its runtime could not be restored.');
                continue;
              }
              if (!loadedConversation.workdir) {
                console.log('\nThis saved session is missing a readable workdir, so its runtime could not be restored.');
                continue;
              }

              const restoredWorkdir = resolveValidatedWorkdir(loadedConversation.workdir);
              const restoredProvider = loadedConversation.provider;
              const restoredBaseUrl =
                restoredProvider === 'codex'
                  ? providerDefaultBaseUrl(restoredProvider)
                  : (loadedConversation.baseUrl || providerDefaultBaseUrl(restoredProvider)).replace(/\/+$/, '');
              const restoredModel =
                loadedConversation.model || providerDefaultModel(restoredProvider);
              const nextConfig = updateConfig(config, {
                provider: restoredProvider,
                model: restoredModel,
                baseUrl: restoredBaseUrl,
                workdir: restoredWorkdir,
                autoApprove: loadedConversation.autoApprove ?? config.autoApprove,
                maxTurns: loadedConversation.maxTurns ?? config.maxTurns,
                temperature: loadedConversation.temperature ?? config.temperature,
                requestTimeoutMs: loadedConversation.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
              });

              const shouldApply = await runRuntimeTransitionPreflight(nextConfig, {
                requireConfirm: true,
                confirmLabel: 'Restore this saved runtime anyway?',
              });
              if (!shouldApply) {
                console.log('\nRuntime restore cancelled.');
                continue;
              }

              rebuildRuntime(
                nextConfig,
                true
              );
              await logSessionEvent(() => sessionStore.logConfig('resume runtime sync', config));
            } else {
              agent.reset();
            }

            agent.replaceHistory(loadedConversation.messages);
            lastResumedSessionId = loadedConversation.sessionId;

            const resumeMessage = renderResumeContext(
              {
                ...loadedConversation,
              provider: loadedConversation.provider ?? resolution.entry.provider,
              model: loadedConversation.model || resolution.entry.model,
                workdir: loadedConversation.workdir ?? resolution.entry.workdir,
                title: loadedConversation.title || resolution.entry.title,
                lastActivityAt: loadedConversation.lastActivityAt ?? resolution.entry.lastActivityAt,
              },
              config,
              { runtimeApplied: request.applyRuntime }
            );

            console.log(`\n${resumeMessage}`);
            await logSessionEvent(() => sessionStore.logMessage('assistant', resumeMessage));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`\n${message}`);
        }
        continue;
      }

      if (entry === '/sessions' || entry.startsWith('/sessions ')) {
        const request = parseSessionsRequest(entry);
        if (request.kind === 'invalid') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          console.log(`\n${request.reason}`);
          continue;
        }

        if (shouldLogSessionsViewCommand(request)) {
          await logSessionEvent(() => sessionStore.logCommand(entry));
        }

        if (request.kind === 'summary') {
          if (request.sessionRef === 'current') {
            console.log(`\n${await renderSessionSummary(sessionStore.sessionPath, request.count)}`);
            continue;
          }

          try {
            const resolution = await resolveSessionEntry(request.sessionRef, sessionStore.sessionId);
            if (!resolution.entry) {
              console.log(
                `\nCould not find a saved session for "${request.sessionRef}". Use /sessions to inspect recent ids.`
              );
              continue;
            }

            const summary = await renderSessionSummary(resolution.entry.sessionPath, request.count);
            console.log(`\n${[resolution.warning, summary].filter(Boolean).join('\n')}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'search') {
          console.log(
            `\n${await renderSessionList(request.count, {
              currentSessionId: sessionStore.sessionId,
              query: request.query,
            })}`
          );
          continue;
        }

        if (request.kind === 'compare') {
          console.log(
            `\n${await renderSessionComparison(
              request.count,
              sessionStore.sessionId,
              request.includeIdle
            )}`
          );
          continue;
        }

        if (request.kind === 'delete') {
          try {
            const plan = await planSessionDelete(request.sessionRef, sessionStore.sessionId);
            if (!plan.entry) {
              console.log(
                `\nCould not find a saved session for "${request.sessionRef}". Use /sessions to inspect recent ids.`
              );
              continue;
            }

            if (plan.isCurrent) {
              console.log('\nYou cannot delete the current active session.');
              continue;
            }

            const confirmed = await ui.confirm(
              [
                plan.warning,
                'Delete this saved session?',
                formatSessionEntryLabel(
                  plan.entry.sessionId,
                  plan.entry.title,
                  plan.entry.lastActivityAt
                ),
              ]
                .filter(Boolean)
                .join('\n')
            );
            if (!confirmed) {
              console.log('\nDelete cancelled.');
              continue;
            }

            await deleteSessionEntries([plan.entry]);
            console.log(`\nDeleted saved session ${plan.entry.sessionId}.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'clear-idle') {
          try {
            const plan = await planIdleSessionCleanup(sessionStore.sessionId, request.count);
            if (plan.entries.length === 0) {
              console.log('\nNo idle saved sessions to delete.');
              continue;
            }

            const preview = plan.entries
              .slice(0, 5)
              .map((entry) =>
                formatSessionEntryLabel(entry.sessionId, entry.title, entry.lastActivityAt)
              );
            const extraCount =
              plan.entries.length > preview.length ? plan.entries.length - preview.length : 0;
            const confirmed = await ui.confirm(
              [
                plan.warning,
                `Delete ${plan.entries.length} idle saved session${
                  plan.entries.length === 1 ? '' : 's'
                }?`,
                ...preview,
                extraCount > 0 ? `...and ${extraCount} more.` : undefined,
              ]
                .filter(Boolean)
                .join('\n')
            );
            if (!confirmed) {
              console.log('\nIdle-session cleanup cancelled.');
              continue;
            }

            await deleteSessionEntries(plan.entries);
            console.log(
              `\nDeleted ${plan.entries.length} idle saved session${
                plan.entries.length === 1 ? '' : 's'
              }.`
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'prune') {
          try {
            const plan = await planSessionPrune(request.keepCount, sessionStore.sessionId);
            if (plan.entries.length === 0) {
              console.log(`\nNothing to prune. The latest ${request.keepCount} sessions are already all that remain.`);
              continue;
            }

            const preview = plan.entries
              .slice(0, 5)
              .map((entry) =>
                formatSessionEntryLabel(entry.sessionId, entry.title, entry.lastActivityAt)
              );
            const extraCount =
              plan.entries.length > preview.length ? plan.entries.length - preview.length : 0;
            const confirmed = await ui.confirm(
              [
                plan.warning,
                `Prune saved sessions to keep the latest ${request.keepCount}?`,
                plan.preservedCurrentOutsideWindow
                  ? 'The current session is outside that window and will be preserved as well.'
                  : undefined,
                `This will delete ${plan.entries.length} older session${
                  plan.entries.length === 1 ? '' : 's'
                }.`,
                ...preview,
                extraCount > 0 ? `...and ${extraCount} more.` : undefined,
              ]
                .filter(Boolean)
                .join('\n')
            );
            if (!confirmed) {
              console.log('\nPrune cancelled.');
              continue;
            }

            await deleteSessionEntries(plan.entries);
            console.log(
              `\nDeleted ${plan.entries.length} older saved session${
                plan.entries.length === 1 ? '' : 's'
              }.`
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        console.log(
          `\n${await renderSessionList(request.count, {
            currentSessionId: sessionStore.sessionId,
          })}`
        );
        continue;
      }

      if (entry === '/profiles' || entry.startsWith('/profiles ')) {
        const request = parseProfilesRequest(entry);
        if (request.kind === 'invalid') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          console.log(`\n${request.reason}`);
          continue;
        }

        if (request.kind === 'list') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          try {
            console.log(`\n${await renderProfileList(config)}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'search') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          try {
            console.log(`\n${await renderProfileList(config, { query: request.query })}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'diff') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          try {
            const profile = await loadProfile(request.name);
            if (!profile) {
              console.log(`\nCould not find a saved profile named "${request.name}". Use /profiles to inspect saved names.`);
              continue;
            }

            console.log(`\n${renderProfileDiff(config, profile)}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'save') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          try {
            const profile = await saveProfile(request.name, config);
            console.log(`\nSaved profile "${profile.name}".`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'rename') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          try {
            const renamed = await renameProfile(request.from, request.to);
            if (!renamed) {
              console.log(`\nCould not find a saved profile named "${request.from}". Use /profiles to inspect saved names.`);
              continue;
            }

            console.log(`\nRenamed profile to "${renamed.name}".`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'load') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          try {
            const profile = await loadProfile(request.name);
            if (!profile) {
              console.log(`\nCould not find a saved profile named "${request.name}". Use /profiles to inspect saved names.`);
              continue;
            }

            const nextWorkdir = resolveValidatedWorkdir(profile.workdir);
            const nextConfig = updateConfig(config, {
              provider: profile.provider,
              model: profile.model,
              baseUrl: profile.baseUrl,
              workdir: nextWorkdir,
              autoApprove: profile.autoApprove,
              maxTurns: profile.maxTurns,
              temperature: profile.temperature,
              requestTimeoutMs: profile.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            });
            const preflight = await buildRuntimeTransitionPreflight(nextConfig);
            const confirmed = await ui.confirm(
              [
                renderProfileLoadPreview(config, profile),
                preflight.status !== 'ready'
                  ? renderRuntimeTransitionPreflight(nextConfig, preflight)
                  : undefined,
              ]
                .filter(Boolean)
                .join('\n\n')
            );
            if (!confirmed) {
              console.log('\nProfile load cancelled.');
              continue;
            }
            rebuildRuntime(
              nextConfig,
              true
            );
            sessionStore = await createSessionStore(config, launchCwd, `profile load: ${profile.name}`);
            await logSessionEvent(() => sessionStore.logConfig(`profile load: ${profile.name}`, config));
            console.log(`\nLoaded profile "${profile.name}". Conversation reset.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }

        if (request.kind === 'delete') {
          await logSessionEvent(() => sessionStore.logCommand(entry));
          try {
            const profile = await loadProfile(request.name);
            if (!profile) {
              console.log(`\nCould not find a saved profile named "${request.name}".`);
              continue;
            }

            const confirmed = await ui.confirm(
              [
                `Delete saved profile "${profile.name}"?`,
                `provider=${profile.provider}, model=${profile.model || '(provider default)'}, workdir=${profile.workdir}`,
              ].join('\n')
            );
            if (!confirmed) {
              console.log('\nProfile delete cancelled.');
              continue;
            }

            await deleteProfile(profile.name);
            console.log(`\nDeleted profile "${profile.name}".`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`\n${message}`);
          }
          continue;
        }
      }

      if (entry === '/tools') {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        console.log(`\n${renderToolCatalog(tools)}`);
        continue;
      }

      if (entry === '/reset') {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        agent.reset();
        lastResumedSessionId = undefined;
        console.log('\nConversation reset.');
        continue;
      }

      if (entry === '/title') {
        console.log('\nUse /title <text>.');
        continue;
      }

      if (entry.startsWith('/title ')) {
        const nextTitle = entry.slice('/title '.length).trim();
        if (!nextTitle) {
          console.log('\nUse /title <text>.');
          continue;
        }

        await logSessionEvent(() => sessionStore.logTitle(nextTitle));
        console.log(`\nSession title updated to: ${nextTitle}`);
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
        const nextConfig = updateConfig(config, {
            provider,
            baseUrl: nextBaseUrl,
            model: nextModel,
            requestTimeoutMs: config.requestTimeoutMs,
          });

        await runRuntimeTransitionPreflight(nextConfig);

        rebuildRuntime(
          nextConfig,
          true
        );
        const updates: Record<string, string> = {
          MODEL_PROVIDER: provider,
          MODEL_NAME: '',
          [providerModelEnvKey(provider)]: nextModel,
        };
        if (nextBaseUrlKey) {
          updates[nextBaseUrlKey] = nextConfig.baseUrl;
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
        const nextConfig = updateConfig(config, {
          model: nextModel,
          requestTimeoutMs: config.requestTimeoutMs,
        });

        await runRuntimeTransitionPreflight(nextConfig);
        rebuildRuntime(
          nextConfig,
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
        const request = parseModelsRequest(entry);
        if (request.kind === 'invalid') {
          console.log(`\n${request.reason}`);
          continue;
        }

        if (request.kind === 'doctor') {
          console.log(`\n${await renderModelDiagnostics(config, request.scope)}`);
          continue;
        }

        if (request.kind === 'smoke') {
          console.log(`\n${renderLiveProviderSmokeResults(await runLiveProviderSmoke(config, request.scope, request.mode))}`);
          continue;
        }

        console.log(`\n${await renderModelCatalogs(config, request.scope, { query: request.query })}`);
        continue;
      }

      if (entry.startsWith('/base-url ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        if (config.provider === 'codex') {
          console.log('\nThe codex provider uses the local codex CLI, so base URL is not used.');
          continue;
        }

        const rawBaseUrl = entry.slice('/base-url '.length).trim();
        const nextBaseUrl = normalizeProviderBaseUrl(config.provider, rawBaseUrl);
        const nextConfig = updateConfig(config, {
          baseUrl: nextBaseUrl,
          requestTimeoutMs: config.requestTimeoutMs,
        });
        await runRuntimeTransitionPreflight(nextConfig);
        rebuildRuntime(
          nextConfig,
          true
        );
        const currentBaseUrlKey = providerBaseUrlEnvKey(config.provider);
        const saved = await persistLaunchSettings(
          currentBaseUrlKey ? { [currentBaseUrlKey]: nextBaseUrl } : {}
        );
        await logSessionEvent(() => sessionStore.logConfig('base-url update', config));
        const normalizationNote =
          rawBaseUrl.trim().replace(/\/+$/, '') !== nextBaseUrl
            ? ` Normalized endpoint URL to base URL: ${nextBaseUrl}.`
            : '';
        console.log(`\nBase URL updated.${normalizationNote} Conversation reset.${saved ? ' Saved to .env.' : ''}`);
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

      if (entry === '/temperature' || entry.startsWith('/temperature ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const request = parseTemperatureRequest(entry);
        if (request.kind === 'invalid') {
          console.log(`\n${request.reason}`);
          continue;
        }

        rebuildRuntime(
          updateConfig(config, {
            temperature: request.value,
          }),
          false
        );
        await logSessionEvent(() => sessionStore.logConfig('temperature update', config));
        console.log(
          request.usedDefault
            ? `\nTemperature reset to ${config.temperature} for this session.`
            : `\nTemperature is now ${config.temperature} for this session.`
        );
        continue;
      }

      if (entry === '/max-turns' || entry.startsWith('/max-turns ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const request = parseMaxTurnsRequest(entry);
        if (request.kind === 'invalid') {
          console.log(`\n${request.reason}`);
          continue;
        }

        rebuildRuntime(
          updateConfig(config, {
            maxTurns: request.value,
          }),
          false
        );
        await logSessionEvent(() => sessionStore.logConfig('max-turns update', config));
        console.log(
          request.usedDefault
            ? `\nMax turns reset to ${config.maxTurns} for this session.`
            : `\nMax turns is now ${config.maxTurns} for this session.`
        );
        continue;
      }

      if (entry === '/request-timeout' || entry.startsWith('/request-timeout ')) {
        await logSessionEvent(() => sessionStore.logCommand(entry));
        const request = parseRequestTimeoutRequest(entry);
        if (request.kind === 'invalid') {
          console.log(`\n${request.reason}`);
          continue;
        }

        rebuildRuntime(
          updateConfig(config, {
            requestTimeoutMs: request.value,
          }),
          false
        );
        await logSessionEvent(() => sessionStore.logConfig('request-timeout update', config));
        console.log(
          request.usedDefault
            ? `\nRequest timeout reset to ${Math.round((config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) / 1000)}s for this session.`
            : `\nRequest timeout is now ${Math.round((config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) / 1000)}s for this session.`
        );
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
