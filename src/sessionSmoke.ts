import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSessionStore, renderSessionHistory } from './sessionStore.js';

import type { AgentConfig } from './types.js';

function formatElapsed(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1_000;
  return `${seconds.toFixed(1)}s`;
}

function assertIncludesAll(output: string, expectedSnippets: string[], label: string): void {
  const missing = expectedSnippets.filter((snippet) => !output.includes(snippet));
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing expected snippets: ${missing.join(', ')}\n\nActual output:\n${output}`
    );
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mmca-session-smoke-'));
  const workdir = path.join(tempRoot, 'workspace');
  const previousAgentHome = process.env.MM_AGENT_HOME;
  const secret = 'super-secret-session-key';

  const config: AgentConfig = {
    provider: 'ollama',
    model: 'qwen2.5-coder:14b',
    baseUrl: 'http://127.0.0.1:11434',
    apiKey: secret,
    workdir,
    autoApprove: false,
    maxTurns: 8,
    temperature: 0.2,
  };

  try {
    process.env.MM_AGENT_HOME = tempRoot;
    await mkdir(workdir, { recursive: true });

    const store = await createSessionStore(config, workdir, 'session smoke');
    const expectedSessionsDir = path.join(tempRoot, 'sessions');

    console.log('[session-smoke] Created session store');
    console.log(`[session-smoke] sessionId: ${store.sessionId}`);
    console.log(`[session-smoke] sessionPath: ${store.sessionPath}`);

    if (!existsSync(store.sessionPath)) {
      throw new Error(`Session file was not created: ${store.sessionPath}`);
    }

    if (!path.resolve(store.sessionPath).startsWith(path.resolve(expectedSessionsDir))) {
      throw new Error(`Session file was written outside MM_AGENT_HOME: ${store.sessionPath}`);
    }

    await store.logMessage('user', 'Summarize this project.');
    await store.logMessage('assistant', 'This is a session smoke test reply.');
    await store.logCommand(`/api-key ${secret}`);
    await store.logConfig('api-key update', config);

    const raw = await readFile(store.sessionPath, 'utf8');
    console.log(`\n[session-smoke] raw session log:\n${raw}`);

    assertIncludesAll(
      raw,
      ['"type":"session_started"', '"type":"message"', '"type":"command"', '"type":"config"', '"apiKeySet":true'],
      'raw session log'
    );

    if (raw.includes(secret)) {
      throw new Error('Raw session log leaked the API key.');
    }

    const history = await renderSessionHistory(store.sessionPath, 10);
    console.log(`\n[session-smoke] rendered history:\n${history}\n`);

    assertIncludesAll(
      history,
      [
        'Session ',
        `Path: ${store.sessionPath}`,
        `Workdir: ${workdir}`,
        'Recent events (4):',
        'user: Summarize this project.',
        'assistant: This is a session smoke test reply.',
        'command: /api-key [redacted]',
        `config (api-key update): provider=ollama, model=qwen2.5-coder:14b, workdir=${workdir}`,
      ],
      'rendered history'
    );

    if (history.includes(secret)) {
      throw new Error('Rendered history leaked the API key.');
    }

    console.log(
      `[session-smoke] All session checks passed in ${formatElapsed(Date.now() - startedAt)}.`
    );
  } finally {
    if (previousAgentHome === undefined) {
      delete process.env.MM_AGENT_HOME;
    } else {
      process.env.MM_AGENT_HOME = previousAgentHome;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[session-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
