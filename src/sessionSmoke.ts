import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSessionStore,
  loadSessionConversation,
  listRecentSessions,
  renderResumeContext,
  renderRuntimeStatus,
  renderSessionComparison,
  renderSessionHistory,
  renderSessionList,
  renderSessionSummary,
  resolveSessionEntry,
} from './sessionStore.js';

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

function uniquePrefixFor(target: string, other: string): string {
  let index = 0;
  while (index < target.length && target[index] === other[index]) {
    index += 1;
  }

  return target.slice(0, Math.min(target.length, index + 1));
}

async function writeSessionFixture(
  sessionsDir: string,
  sessionId: string,
  workdir: string,
  model: string,
  reason: string
): Promise<void> {
  const sessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  const startedEvent = {
    type: 'session_started',
    timestamp: '2026-04-08T00:00:00.000Z',
    sessionId,
    launchCwd: workdir,
    reason,
    config: {
      provider: 'ollama',
      model,
      baseUrl: 'http://127.0.0.1:11434',
      workdir,
      autoApprove: false,
      maxTurns: 8,
      temperature: 0.2,
      apiKeySet: false,
    },
  };

  await writeFile(sessionPath, `${JSON.stringify(startedEvent)}\n`, 'utf8');
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

    const previousWorkdir = path.join(tempRoot, 'workspace-previous');
    await mkdir(previousWorkdir, { recursive: true });

    const previousStore = await createSessionStore(
      {
        ...config,
        model: 'qwen2.5-coder:7b',
        workdir: previousWorkdir,
      },
      previousWorkdir,
      'previous session smoke'
    );
    await previousStore.logMessage('user', 'Show me the earlier session.');
    await previousStore.logMessage('assistant', 'This is the earlier session reply.');

    const store = await createSessionStore(config, workdir, 'session smoke');
    const expectedSessionsDir = path.join(tempRoot, 'sessions');
    const corruptedSessionPath = path.join(
      expectedSessionsDir,
      '2026-12-31T23-59-59-999Z-corrupted.jsonl'
    );
    const schemaInvalidSessionPath = path.join(
      expectedSessionsDir,
      '2026-12-31T23-59-59-998Z-schema-invalid.jsonl'
    );
    const idleSessionId = '2026-04-08T00-00-00-000Z-idle-fixture';
    const idleWorkdir = path.join(tempRoot, 'workspace-idle');
    await mkdir(idleWorkdir, { recursive: true });

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

    await appendFile(store.sessionPath, 'null\n', 'utf8');
    await appendFile(store.sessionPath, '{"type":"session_started","sessionId":"broken"}\n', 'utf8');

    const history = await renderSessionHistory(store.sessionPath, 10);
    console.log(`\n[session-smoke] rendered history:\n${history}\n`);

    assertIncludesAll(
      history,
      [
        'Session ',
        `Path: ${store.sessionPath}`,
        `Workdir: ${workdir}`,
        'Warning: ignored 2 malformed JSONL lines while reading this session.',
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

    const currentConversation = await loadSessionConversation(store.sessionPath, 10);
    if (currentConversation.messages.length !== 2) {
      throw new Error(
        `Expected 2 resumed messages from the current session, got ${currentConversation.messages.length}.`
      );
    }
    if (
      currentConversation.warning !==
      'Warning: ignored 2 malformed JSONL lines while resuming this session.'
    ) {
      throw new Error(
        `Unexpected current-session resume warning: ${currentConversation.warning ?? '(missing)'}`
      );
    }
    assertIncludesAll(
      renderResumeContext(currentConversation, config),
      [
        `Resumed 2 messages from session ${store.sessionId}.`,
        'Title: Summarize this project.',
        'Activity: user=1, assistant=1, repl commands=1, config=1, profile=mixed',
        'First request: Summarize this project.',
        'Last assistant reply: This is a session smoke test reply.',
      ],
      'current resume context'
    );
    assertIncludesAll(
      renderRuntimeStatus(currentConversation, config, store.sessionPath),
      [
        'Current status',
        `Session id: ${store.sessionId}`,
        `Path: ${store.sessionPath}`,
        'Title: Summarize this project.',
        `Runtime: provider=ollama, model=qwen2.5-coder:14b, baseUrl=http://127.0.0.1:11434, workdir=${workdir}`,
        'Resume source: (none)',
        'Saved activity: user=1, assistant=1, repl commands=1, config=1, profile=mixed',
        'Saved conversation messages: 2',
      ],
      'current runtime status'
    );

    await writeFile(
      corruptedSessionPath,
      '{"type":"session_started","timestamp":"2026-04-08T00:00:00.000Z"',
      'utf8'
    );
    await writeFile(
      schemaInvalidSessionPath,
      'null\n{"type":"session_started","sessionId":"broken"}\n',
      'utf8'
    );
    await writeSessionFixture(expectedSessionsDir, idleSessionId, idleWorkdir, 'qwen2.5-coder:3b', 'startup');

    const sessionList = await renderSessionList(10, { currentSessionId: store.sessionId });
    console.log(`[session-smoke] rendered session list:\n${sessionList}\n`);

    assertIncludesAll(
      sessionList,
      [
        `Saved sessions (3)`,
        `Root: ${expectedSessionsDir}`,
        'Warning: skipped 2 corrupted session logs and ignored malformed lines in 1 session log while scanning saved sessions.',
        `- id: ${store.sessionId} (current)`,
        '  title: Summarize this project.',
        '  last active: ',
        `  provider=ollama, model=qwen2.5-coder:14b, workdir=${workdir}, reason=session smoke`,
        `- id: ${previousStore.sessionId}`,
        '  title: Show me the earlier session.',
        '  last active: ',
        `  provider=ollama, model=qwen2.5-coder:7b, workdir=${previousWorkdir}, reason=previous session smoke`,
        `- id: ${idleSessionId}`,
        '  title: (no prompt yet)',
        '  last active: ',
        `  provider=ollama, model=qwen2.5-coder:3b, workdir=${idleWorkdir}, reason=startup`,
      ],
      'rendered session list'
    );

    const filteredSessionList = await renderSessionList(10, {
      currentSessionId: store.sessionId,
      query: 'earlier',
    });
    assertIncludesAll(
      filteredSessionList,
      [
        'Saved sessions (1)',
        'Filter: earlier',
        `- id: ${previousStore.sessionId}`,
        '  title: Show me the earlier session.',
      ],
      'filtered session list'
    );
    if (filteredSessionList.includes(store.sessionId)) {
      throw new Error('Filtered session list should not include non-matching sessions.');
    }

    const assistantFilteredSessionList = await renderSessionList(10, {
      currentSessionId: store.sessionId,
      query: 'session smoke test reply',
    });
    assertIncludesAll(
      assistantFilteredSessionList,
      [
        'Saved sessions (1)',
        'Filter: session smoke test reply',
        `- id: ${store.sessionId} (current)`,
        '  match: last assistant -> This is a session smoke test reply.',
      ],
      'assistant-content filtered session list'
    );
    if (assistantFilteredSessionList.includes(previousStore.sessionId)) {
      throw new Error('Assistant-content filtered session list should not include unrelated sessions.');
    }

    const sessionIdFilteredSessionList = await renderSessionList(10, {
      currentSessionId: store.sessionId,
      query: store.sessionId,
    });
    assertIncludesAll(
      sessionIdFilteredSessionList,
      [
        'Saved sessions (1)',
        `Filter: ${store.sessionId}`,
        `- id: ${store.sessionId} (current)`,
        `  match: session id -> ${store.sessionId}`,
      ],
      'session-id filtered session list'
    );

    const sessionIdPrefixFilteredSessionList = await renderSessionList(10, {
      currentSessionId: store.sessionId,
      query: store.sessionId.slice(0, 10),
    });
    assertIncludesAll(
      sessionIdPrefixFilteredSessionList,
      [
        `Filter: ${store.sessionId.slice(0, 10)}`,
        `- id: ${store.sessionId} (current)`,
        `  match: session id -> ${store.sessionId}`,
      ],
      'session-id prefix filtered session list'
    );

    const comparison = await renderSessionComparison(5, store.sessionId);
    assertIncludesAll(
      comparison,
      [
        'Recent session comparison (2)',
        'Latest first (idle hidden):',
        `- id: ${store.sessionId} (current)`,
        '  title: Summarize this project.',
        '  activity: user=1, assistant=1, repl commands=1, config=1, total=4',
        '  profile: mixed',
        `- id: ${previousStore.sessionId}`,
        '  title: Show me the earlier session.',
        '  activity: user=1, assistant=1, repl commands=0, config=0, total=2',
      ],
      'session comparison'
    );
    if (comparison.includes(idleSessionId)) {
      throw new Error('Default session comparison should hide idle sessions.');
    }

    const comparisonAll = await renderSessionComparison(5, store.sessionId, true);
    assertIncludesAll(
      comparisonAll,
      [
        'Recent session comparison (3)',
        'Latest first (including idle):',
        `- id: ${idleSessionId}`,
        '  title: (no prompt yet)',
        '  activity: user=0, assistant=0, repl commands=0, config=0, total=0',
        '  profile: idle',
      ],
      'session comparison all'
    );

    const currentSummary = await renderSessionSummary(store.sessionPath, 4);
    assertIncludesAll(
      currentSummary,
      [
        `Session summary: ${store.sessionId}`,
        'Title: Summarize this project.',
        `Provider/model: ollama / qwen2.5-coder:14b`,
        `Workdir: ${workdir}`,
        'Activity: user=1, assistant=1, repl commands=1, config=1, total=4',
        'Profile: mixed',
        'First request: Summarize this project.',
        'Last user message: Summarize this project.',
        'Last assistant reply: This is a session smoke test reply.',
        'Recent events (4):',
      ],
      'current session summary'
    );

    const previousSummary = await renderSessionSummary(previousStore.sessionPath, 3);
    assertIncludesAll(
      previousSummary,
      [
        `Session summary: ${previousStore.sessionId}`,
        'Title: Show me the earlier session.',
        `Provider/model: ollama / qwen2.5-coder:7b`,
        `Workdir: ${previousWorkdir}`,
        'Activity: user=1, assistant=1, repl commands=0, config=0, total=2',
        'Profile: light',
        'First request: Show me the earlier session.',
        'Last user message: Show me the earlier session.',
        'Last assistant reply: This is the earlier session reply.',
      ],
      'previous session summary'
    );

    const recentSessions = await listRecentSessions(10);
    if (recentSessions.length !== 3) {
      throw new Error(`Expected 3 recent sessions, got ${recentSessions.length}.`);
    }
    const currentEntry = recentSessions.find((entry) => entry.sessionId === store.sessionId);
    if (!currentEntry) {
      throw new Error('Current session was missing from recent session entries.');
    }
    if (currentEntry.title !== 'Summarize this project.') {
      throw new Error(`Unexpected current session title: ${currentEntry.title}`);
    }
    if (!currentEntry.lastActivityAt || Number.isNaN(new Date(currentEntry.lastActivityAt).getTime())) {
      throw new Error(`Current session lastActivityAt was not a valid timestamp: ${currentEntry.lastActivityAt}`);
    }

    const previousEntry = recentSessions.find((entry) => entry.sessionId === previousStore.sessionId);
    if (!previousEntry) {
      throw new Error('Previous session was missing from recent session entries.');
    }
    if (previousEntry.title !== 'Show me the earlier session.') {
      throw new Error(`Unexpected previous session title: ${previousEntry.title}`);
    }
    if (!previousEntry.lastActivityAt || Number.isNaN(new Date(previousEntry.lastActivityAt).getTime())) {
      throw new Error(
        `Previous session lastActivityAt was not a valid timestamp: ${previousEntry.lastActivityAt}`
      );
    }

    const idleEntry = recentSessions.find((entry) => entry.sessionId === idleSessionId);
    if (!idleEntry) {
      throw new Error('Idle session was missing from recent session entries.');
    }
    if (idleEntry.title !== '(no prompt yet)') {
      throw new Error(`Unexpected idle session title: ${idleEntry.title}`);
    }

    const latestPrevious = await resolveSessionEntry('latest', store.sessionId);
    if (!latestPrevious.entry || latestPrevious.entry.sessionId !== previousStore.sessionId) {
      throw new Error('The "latest" session lookup did not return the previous session.');
    }

    if (
      latestPrevious.warning !==
      'Warning: skipped 2 corrupted session logs and ignored malformed lines in 1 session log while scanning saved sessions.'
    ) {
      throw new Error(`Unexpected latest-session warning: ${latestPrevious.warning ?? '(missing)'}`);
    }

    const shortIdLookup = await resolveSessionEntry(
      uniquePrefixFor(previousStore.sessionId, store.sessionId),
      store.sessionId
    );
    if (!shortIdLookup.entry || shortIdLookup.entry.sessionId !== previousStore.sessionId) {
      throw new Error('Short session id lookup did not resolve the previous session.');
    }

    const previousHistory = await renderSessionHistory(latestPrevious.entry.sessionPath, 10);
    console.log(`[session-smoke] previous session history:\n${previousHistory}\n`);

    assertIncludesAll(
      previousHistory,
      [
        `Session ${previousStore.sessionId}`,
        `Workdir: ${previousWorkdir}`,
        'user: Show me the earlier session.',
        'assistant: This is the earlier session reply.',
      ],
      'previous session history'
    );

    const resumedConversation = await loadSessionConversation(previousStore.sessionPath, 10);
    if (resumedConversation.messages.length !== 2) {
      throw new Error(
        `Expected 2 resumed messages, got ${resumedConversation.messages.length}.`
      );
    }
    if (resumedConversation.messages[0]?.role !== 'user') {
      throw new Error('The first resumed message should be the earlier user message.');
    }
    if (!resumedConversation.messages[0]?.content.includes('Show me the earlier session.')) {
      throw new Error('The resumed conversation is missing the earlier user message.');
    }
    if (resumedConversation.messages[1]?.role !== 'assistant') {
      throw new Error('The second resumed message should be the earlier assistant reply.');
    }
    if (!resumedConversation.messages[1]?.content.includes('This is the earlier session reply.')) {
      throw new Error('The resumed conversation is missing the earlier assistant reply.');
    }
    assertIncludesAll(
      renderResumeContext(resumedConversation, config),
      [
        `Resumed 2 messages from session ${previousStore.sessionId}.`,
        'Title: Show me the earlier session.',
        `Source session: provider=ollama, model=qwen2.5-coder:7b, workdir=${previousWorkdir}`,
        `Current runtime: provider=ollama, model=qwen2.5-coder:14b, workdir=${workdir}`,
        'Note: resume restores conversation only. The current runtime above will handle the next turn.',
        'Activity: user=1, assistant=1, repl commands=0, config=0, profile=light',
        'First request: Show me the earlier session.',
        'Last assistant reply: This is the earlier session reply.',
      ],
      'previous resume context'
    );
    assertIncludesAll(
      renderRuntimeStatus(
        resumedConversation,
        config,
        previousStore.sessionPath,
        previousStore.sessionId
      ),
      [
        'Current status',
        `Session id: ${previousStore.sessionId}`,
        `Path: ${previousStore.sessionPath}`,
        'Title: Show me the earlier session.',
        `Resume source: ${previousStore.sessionId}`,
        'Saved activity: user=1, assistant=1, repl commands=0, config=0, profile=light',
      ],
      'resumed runtime status'
    );

    const bulkRoot = path.join(tempRoot, 'bulk-home');
    const bulkSessionsDir = path.join(bulkRoot, 'sessions');
    const oldestSessionId = '2026-01-01T00-00-00-000Z-bulk-000000';
    process.env.MM_AGENT_HOME = bulkRoot;
    await mkdir(bulkSessionsDir, { recursive: true });

    for (let index = 0; index < 205; index += 1) {
      const sessionId = `2026-01-01T00-00-00-000Z-bulk-${String(index).padStart(6, '0')}`;
      await writeSessionFixture(
        bulkSessionsDir,
        sessionId,
        path.join(bulkRoot, `workspace-${index}`),
        'qwen2.5-coder:7b',
        'bulk session fixture'
      );
    }

    const oldestResolution = await resolveSessionEntry(oldestSessionId);
    if (!oldestResolution.entry || oldestResolution.entry.sessionId !== oldestSessionId) {
      throw new Error('Exact full session id lookup failed beyond the recent-session scan window.');
    }

    const oldestHistory = await renderSessionHistory(oldestResolution.entry.sessionPath, 2);
    assertIncludesAll(
      oldestHistory,
      [`Session ${oldestSessionId}`, `Workdir: ${path.join(bulkRoot, 'workspace-0')}`],
      'oldest session history'
    );

    process.env.MM_AGENT_HOME = tempRoot;

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
