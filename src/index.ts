import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { AgentRunner } from './agent.js';
import { createConfigFromInputs, providerDefaultBaseUrl, renderConfigSummary, updateConfig } from './config.js';
import { loadDotEnv } from './env.js';
import { createModelAdapter } from './modelAdapters.js';
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
      '',
      'Options:',
      '  --provider <ollama|openai>',
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
      '  /tools                Show tool catalog',
      '  /reset                Clear conversation history',
      '  /provider <name>      Switch provider: ollama or openai',
      '  /model <name>         Switch model',
      '  /base-url <url>       Switch base URL',
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
  return null;
}

function ensureProviderReady(config: AgentConfig): void {
  if (config.provider === 'openai' && !config.apiKey) {
    throw new Error(
      'The openai provider requires an API key. Set OPENAI_API_KEY in .env or use /api-key in the REPL.'
    );
  }
}

async function main(): Promise<void> {
  loadDotEnv(process.cwd());

  const parsed = createConfigFromInputs(process.argv.slice(2));
  if (parsed.showHelp) {
    printStartupHelp();
    return;
  }

  const tools = createTools();
  const rl = createInterface({ input, output });

  let config = parsed.config;
  let adapter = createModelAdapter(config);

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
    ensureProviderReady(config);
    console.log(`\n[user] ${text}`);
    const reply = await agent.runTurn(text);
    console.log(`\n[assistant] ${reply}\n`);
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
        printReplHelp();
        continue;
      }

      if (entry === '/config') {
        console.log(`\n${renderConfigSummary(config)}`);
        continue;
      }

      if (entry === '/tools') {
        console.log(`\n${renderToolCatalog(tools)}`);
        continue;
      }

      if (entry === '/reset') {
        agent.reset();
        console.log('\nConversation reset.');
        continue;
      }

      if (entry.startsWith('/provider ')) {
        const provider = normalizeProvider(entry.slice('/provider '.length));
        if (!provider) {
          console.log('\nUnknown provider. Use ollama or openai.');
          continue;
        }

        const oldProvider = config.provider;
        const oldDefault = providerDefaultBaseUrl(oldProvider);
        const nextDefault = providerDefaultBaseUrl(provider);
        const nextBaseUrl = config.baseUrl === oldDefault ? nextDefault : config.baseUrl;

        rebuildRuntime(
          updateConfig(config, {
            provider,
            baseUrl: nextBaseUrl,
          }),
          true
        );
        console.log(`\nProvider switched to ${provider}. Conversation reset.`);
        continue;
      }

      if (entry.startsWith('/model ')) {
        rebuildRuntime(
          updateConfig(config, {
            model: entry.slice('/model '.length).trim(),
          }),
          true
        );
        console.log(`\nModel switched to ${config.model}. Conversation reset.`);
        continue;
      }

      if (entry.startsWith('/base-url ')) {
        rebuildRuntime(
          updateConfig(config, {
            baseUrl: entry.slice('/base-url '.length).trim().replace(/\/+$/, ''),
          }),
          true
        );
        console.log('\nBase URL updated. Conversation reset.');
        continue;
      }

      if (entry.startsWith('/api-key ')) {
        rebuildRuntime(
          updateConfig(config, {
            apiKey: entry.slice('/api-key '.length).trim(),
          }),
          false
        );
        console.log('\nAPI key updated for this session.');
        continue;
      }

      if (entry.startsWith('/workdir ')) {
        const nextWorkdir = resolve(entry.slice('/workdir '.length).trim());
        rebuildRuntime(
          updateConfig(config, {
            workdir: nextWorkdir,
          }),
          true
        );
        console.log(`\nWorkdir switched to ${nextWorkdir}. Conversation reset.`);
        continue;
      }

      if (entry.startsWith('/approve ')) {
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
        console.log(`\nAuto approve is now ${config.autoApprove}.`);
        continue;
      }

      console.log('\nUnknown command. Type /help.');
    }
  } finally {
    rl.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFatal error: ${message}`);
  process.exitCode = 1;
});
