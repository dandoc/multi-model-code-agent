import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentConfig, ChatMessage, ChatRole } from './types.js';

type SessionConfigSnapshot = {
  provider: AgentConfig['provider'];
  model: string;
  baseUrl: string;
  workdir: string;
  autoApprove: boolean;
  maxTurns: number;
  temperature: number;
  apiKeySet: boolean;
};

type SessionEvent =
  | {
      type: 'session_started';
      timestamp: string;
      sessionId: string;
      launchCwd: string;
      reason: string;
      config: SessionConfigSnapshot;
    }
  | {
      type: 'message';
      timestamp: string;
      role: ChatRole;
      content: string;
    }
  | {
      type: 'command';
      timestamp: string;
      command: string;
    }
  | {
      type: 'config';
      timestamp: string;
      reason: string;
      config: SessionConfigSnapshot;
    }
  | {
      type: 'title';
      timestamp: string;
      title: string;
    };

export type SessionStore = {
  sessionId: string;
  sessionPath: string;
  logMessage: (role: ChatRole, content: string) => Promise<void>;
  logCommand: (command: string) => Promise<void>;
  logConfig: (reason: string, config: AgentConfig) => Promise<void>;
  logTitle: (title: string) => Promise<void>;
};

export type SessionListEntry = {
  sessionId: string;
  sessionPath: string;
  startedAt: string;
  lastActivityAt: string;
  title: string;
  firstRequest?: string;
  lastUserMessage?: string;
  lastAssistantReply?: string;
  lastMeaningfulCommand?: string;
  workdir: string;
  provider: AgentConfig['provider'];
  model: string;
  reason: string;
};

export type SessionResolution = {
  entry: SessionListEntry | null;
  warning?: string;
};

export type SessionDeletePlan = {
  entry: SessionListEntry | null;
  warning?: string;
  isCurrent: boolean;
};

export type SessionCleanupPlan = {
  entries: SessionListEntry[];
  warning?: string;
  preservedCurrentOutsideWindow?: boolean;
};

export type SessionConversationLoad = {
  sessionId: string;
  startedAt?: string;
  lastActivityAt?: string;
  title?: string;
  workdir?: string;
  provider?: AgentConfig['provider'];
  model?: string;
  reason?: string;
  messages: ChatMessage[];
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  replCommands: number;
  configChanges: number;
  profile: string;
  firstRequest?: string;
  lastUserMessage?: string;
  lastAssistantReply?: string;
  lastMeaningfulCommand?: string;
  warning?: string;
};

type SessionEventsLoad = {
  events: SessionEvent[];
  malformedLineCount: number;
  readError?: string;
};

type SessionEntryLoad = {
  entry: SessionListEntry | null;
  malformedLineCount: number;
  corruptionReason?: string;
};

type SessionScanResult = {
  entries: SessionListEntry[];
  skippedCorruptedCount: number;
  partiallyRecoveredCount: number;
};

type SessionListOptions = {
  currentSessionId?: string;
  query?: string;
};

type SessionSearchMatch = {
  label: string;
  snippet: string;
};

type SessionActivitySummary = {
  userMessages: number;
  assistantMessages: number;
  replCommands: number;
  configChanges: number;
  totalEvents: number;
  profile: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isChatRole(value: unknown): value is ChatRole {
  return value === 'system' || value === 'user' || value === 'assistant';
}

function isSessionConfigSnapshot(value: unknown): value is SessionConfigSnapshot {
  return (
    isRecord(value) &&
    (value.provider === 'ollama' || value.provider === 'openai' || value.provider === 'codex') &&
    isString(value.model) &&
    isString(value.baseUrl) &&
    isString(value.workdir) &&
    isBoolean(value.autoApprove) &&
    typeof value.maxTurns === 'number' &&
    typeof value.temperature === 'number' &&
    isBoolean(value.apiKeySet)
  );
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value) || !isString(value.type) || !isString(value.timestamp)) {
    return false;
  }

  if (value.type === 'session_started') {
    return (
      isString(value.sessionId) &&
      isString(value.launchCwd) &&
      isString(value.reason) &&
      isSessionConfigSnapshot(value.config)
    );
  }

  if (value.type === 'message') {
    return isChatRole(value.role) && isString(value.content);
  }

  if (value.type === 'command') {
    return isString(value.command);
  }

  if (value.type === 'config') {
    return isString(value.reason) && isSessionConfigSnapshot(value.config);
  }

  if (value.type === 'title') {
    return isString(value.title);
  }

  return false;
}

function sanitizeConfig(config: AgentConfig): SessionConfigSnapshot {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    workdir: config.workdir,
    autoApprove: config.autoApprove,
    maxTurns: config.maxTurns,
    temperature: config.temperature,
    apiKeySet: Boolean(config.apiKey),
  };
}

function buildSessionId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

function getSessionRootDir(): string {
  const override = process.env.MM_AGENT_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), '.multi-model-code-agent');
}

function getSessionsDir(): string {
  return path.join(getSessionRootDir(), 'sessions');
}

function sanitizeCommand(command: string): string {
  if (command.startsWith('/api-key ')) {
    return '/api-key [redacted]';
  }

  return command;
}

function truncateInline(text: string, maxLength = 160): string {
  const normalized = text.replace(/\r?\n+/g, ' / ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeSessionTitle(title: string): string {
  return truncateInline(title.trim(), 96);
}

function isLowSignalSessionCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  const lowSignalPrefixes = [
    '/help',
    '/history',
    '/sessions',
    '/session',
    '/resume',
    '/config',
    '/models',
    '/tools',
    '/reset',
    '/quit',
  ];

  return lowSignalPrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `)
  );
}

function isLowSignalSessionMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  const lowSignalMessages = new Set([
    'config',
    'current config',
    'current model',
    'what model',
    'which model',
    'current provider',
    'which provider',
  ]);

  return lowSignalMessages.has(normalized);
}

function deriveSessionTitle(events: SessionEvent[], reason: string): string {
  const latestTitleOverride = [...events]
    .reverse()
    .find(
      (event): event is Extract<SessionEvent, { type: 'title' }> =>
        event.type === 'title' && event.title.trim().length > 0
    );
  if (latestTitleOverride) {
    return normalizeSessionTitle(latestTitleOverride.title);
  }

  const firstUserMessage = events.find(
    (event): event is Extract<SessionEvent, { type: 'message' }> =>
      event.type === 'message' &&
      event.role === 'user' &&
      event.content.trim().length > 0 &&
      !isLowSignalSessionMessage(event.content)
  );
  if (firstUserMessage) {
    return truncateInline(firstUserMessage.content, 96);
  }

  const firstMeaningfulCommand = events.find(
    (event): event is Extract<SessionEvent, { type: 'command' }> =>
      event.type === 'command' && !isLowSignalSessionCommand(event.command)
  );
  if (firstMeaningfulCommand) {
    return truncateInline(firstMeaningfulCommand.command, 96);
  }

  if (reason !== 'startup') {
    return `Reason: ${truncateInline(reason, 96)}`;
  }

  return '(no prompt yet)';
}

async function appendEvent(sessionPath: string, event: SessionEvent): Promise<void> {
  await appendFile(sessionPath, `${JSON.stringify(event)}\n`, 'utf8');
}

async function loadSessionEvents(sessionPath: string): Promise<SessionEventsLoad> {
  if (!existsSync(sessionPath)) {
    return {
      events: [],
      malformedLineCount: 0,
    };
  }

  let raw = '';
  try {
    raw = await readFile(sessionPath, 'utf8');
  } catch (error) {
    return {
      events: [],
      malformedLineCount: 0,
      readError: error instanceof Error ? error.message : String(error),
    };
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events: SessionEvent[] = [];
  let malformedLineCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isSessionEvent(parsed)) {
        malformedLineCount += 1;
        continue;
      }

      events.push(parsed);
    } catch {
      malformedLineCount += 1;
    }
  }

  return {
    events,
    malformedLineCount,
  };
}

function formatMalformedLineWarning(count: number): string {
  return `ignored ${count} malformed JSONL line${count === 1 ? '' : 's'}`;
}

function buildSessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.jsonl`);
}

function isSafeSessionSpecifier(specifier: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(specifier) && path.basename(specifier) === specifier;
}

function renderScanWarning(result: SessionScanResult, context = 'saved sessions'): string | undefined {
  const parts: string[] = [];
  if (result.skippedCorruptedCount > 0) {
    parts.push(
      `skipped ${result.skippedCorruptedCount} corrupted session log${result.skippedCorruptedCount === 1 ? '' : 's'}`
    );
  }
  if (result.partiallyRecoveredCount > 0) {
    parts.push(
      `ignored malformed lines in ${result.partiallyRecoveredCount} session log${result.partiallyRecoveredCount === 1 ? '' : 's'}`
    );
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `Warning: ${parts.join(' and ')} while scanning ${context}.`;
}

async function loadSessionEntry(sessionPath: string): Promise<SessionEntryLoad> {
  const loaded = await loadSessionEvents(sessionPath);
  if (loaded.readError) {
    return {
      entry: null,
      malformedLineCount: loaded.malformedLineCount,
      corruptionReason: `could not read ${path.basename(sessionPath)}: ${loaded.readError}`,
    };
  }

  const startedEvent = loaded.events.find((event) => event.type === 'session_started');
  if (!startedEvent || startedEvent.type !== 'session_started') {
    return {
      entry: null,
      malformedLineCount: loaded.malformedLineCount,
      corruptionReason:
        loaded.malformedLineCount > 0
          ? `${path.basename(sessionPath)} is missing a readable session start record and ${formatMalformedLineWarning(loaded.malformedLineCount)}`
          : `${path.basename(sessionPath)} is missing a readable session start record`,
    };
  }

  const firstUserMessage = findFirstMeaningfulUserMessage(loaded.events);
  const lastUserMessage = findLastUserMessage(loaded.events);
  const lastAssistantMessage = findLastAssistantMessage(loaded.events);
  const lastMeaningfulCommand = findLastMeaningfulCommand(loaded.events);

  return {
    entry: {
      sessionId: startedEvent.sessionId,
      sessionPath,
      startedAt: startedEvent.timestamp,
      lastActivityAt: loaded.events.at(-1)?.timestamp ?? startedEvent.timestamp,
      title: deriveSessionTitle(loaded.events, startedEvent.reason),
      firstRequest: firstUserMessage?.content,
      lastUserMessage: lastUserMessage?.content,
      lastAssistantReply: lastAssistantMessage?.content,
      lastMeaningfulCommand: lastMeaningfulCommand?.command,
      workdir: startedEvent.config.workdir,
      provider: startedEvent.config.provider,
      model: startedEvent.config.model,
      reason: startedEvent.reason,
    },
    malformedLineCount: loaded.malformedLineCount,
  };
}

async function scanRecentSessions(limit?: number): Promise<SessionScanResult> {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) {
    return {
      entries: [],
      skippedCorruptedCount: 0,
      partiallyRecoveredCount: 0,
    };
  }

  const fileNames = (await readdir(sessionsDir))
    .filter((name) => name.endsWith('.jsonl'))
    .sort((left, right) => right.localeCompare(left));

  const result: SessionScanResult = {
    entries: [],
    skippedCorruptedCount: 0,
    partiallyRecoveredCount: 0,
  };

  for (const fileName of fileNames) {
    const sessionPath = path.join(sessionsDir, fileName);
    const loaded = await loadSessionEntry(sessionPath);
    if (!loaded.entry) {
      result.skippedCorruptedCount += 1;
      continue;
    }

    if (loaded.malformedLineCount > 0) {
      result.partiallyRecoveredCount += 1;
    }

    result.entries.push(loaded.entry);
    if (limit && result.entries.length >= limit) {
      break;
    }
  }

  return result;
}

export async function createSessionStore(
  config: AgentConfig,
  launchCwd: string,
  reason = 'startup'
): Promise<SessionStore> {
  const sessionsDir = getSessionsDir();
  await mkdir(sessionsDir, { recursive: true });

  const sessionId = buildSessionId();
  const sessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);
  const startedEvent: SessionEvent = {
    type: 'session_started',
    timestamp: new Date().toISOString(),
    sessionId,
    launchCwd,
    reason,
    config: sanitizeConfig(config),
  };

  await writeFile(sessionPath, `${JSON.stringify(startedEvent)}\n`, 'utf8');

  return {
    sessionId,
    sessionPath,
    logMessage: async (role, content) => {
      await appendEvent(sessionPath, {
        type: 'message',
        timestamp: new Date().toISOString(),
        role,
        content,
      });
    },
    logCommand: async (command) => {
      await appendEvent(sessionPath, {
        type: 'command',
        timestamp: new Date().toISOString(),
        command: sanitizeCommand(command),
      });
    },
    logConfig: async (configReason, nextConfig) => {
      await appendEvent(sessionPath, {
        type: 'config',
        timestamp: new Date().toISOString(),
        reason: configReason,
        config: sanitizeConfig(nextConfig),
      });
    },
    logTitle: async (title) => {
      await appendEvent(sessionPath, {
        type: 'title',
        timestamp: new Date().toISOString(),
        title: normalizeSessionTitle(title),
      });
    },
  };
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toISOString().slice(11, 19);
}

function formatSessionTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function matchesSessionSearch(entry: SessionListEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    entry.sessionId,
    entry.title,
    entry.firstRequest ?? '',
    entry.lastUserMessage ?? '',
    entry.lastAssistantReply ?? '',
    entry.lastMeaningfulCommand ?? '',
    entry.provider,
    entry.model,
    entry.workdir,
    entry.reason,
  ]
    .join('\n')
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

function findSessionSearchMatch(entry: SessionListEntry, query: string): SessionSearchMatch | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  const candidates: Array<{ label: string; value?: string }> = [
    { label: 'session id', value: entry.sessionId },
    { label: 'title', value: entry.title },
    { label: 'first request', value: entry.firstRequest },
    { label: 'last user', value: entry.lastUserMessage },
    { label: 'last assistant', value: entry.lastAssistantReply },
    { label: 'last command', value: entry.lastMeaningfulCommand },
    { label: 'provider', value: entry.provider },
    { label: 'model', value: entry.model },
    { label: 'workdir', value: entry.workdir },
    { label: 'reason', value: entry.reason },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }

    if (candidate.value.toLowerCase().includes(normalizedQuery)) {
      return {
        label: candidate.label,
        snippet: truncateInline(candidate.value, 120),
      };
    }
  }

  return null;
}

function summarizeSessionActivity(events: SessionEvent[]): SessionActivitySummary {
  let userMessages = 0;
  let assistantMessages = 0;
  let replCommands = 0;
  let configChanges = 0;

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user' && !isLowSignalSessionMessage(event.content)) {
        userMessages += 1;
      } else if (event.role === 'assistant') {
        assistantMessages += 1;
      }
      continue;
    }

    if (event.type === 'command') {
      if (!isLowSignalSessionCommand(event.command)) {
        replCommands += 1;
      }
      continue;
    }

    if (event.type === 'config') {
      configChanges += 1;
    }
  }

  const totalEvents = userMessages + assistantMessages + replCommands + configChanges;
  let profile = totalEvents === 0 ? 'idle' : 'light';
  if (replCommands >= Math.max(2, userMessages + assistantMessages) && replCommands > 0) {
    profile = 'command-heavy';
  } else if (configChanges >= 2 && userMessages + assistantMessages <= 4) {
    profile = 'setup-heavy';
  } else if (userMessages + assistantMessages >= 6 && replCommands <= 2) {
    profile = 'chat-heavy';
  } else if (userMessages + assistantMessages >= 2 && replCommands >= 1) {
    profile = 'mixed';
  }

  return {
    userMessages,
    assistantMessages,
    replCommands,
    configChanges,
    totalEvents,
    profile,
  };
}

function findFirstMeaningfulUserMessage(
  events: SessionEvent[]
): Extract<SessionEvent, { type: 'message' }> | undefined {
  return events.find(
    (event): event is Extract<SessionEvent, { type: 'message' }> =>
      event.type === 'message' &&
      event.role === 'user' &&
      event.content.trim().length > 0 &&
      !isLowSignalSessionMessage(event.content)
  );
}

function findLastUserMessage(
  events: SessionEvent[]
): Extract<SessionEvent, { type: 'message' }> | undefined {
  const userMessages = events.filter(
    (event): event is Extract<SessionEvent, { type: 'message' }> =>
      event.type === 'message' && event.role === 'user' && event.content.trim().length > 0
  );
  return userMessages.at(-1);
}

function findLastAssistantMessage(
  events: SessionEvent[]
): Extract<SessionEvent, { type: 'message' }> | undefined {
  const assistantMessages = events.filter(
    (event): event is Extract<SessionEvent, { type: 'message' }> =>
      event.type === 'message' && event.role === 'assistant' && event.content.trim().length > 0
  );
  return assistantMessages.at(-1);
}

function findLastMeaningfulCommand(
  events: SessionEvent[]
): Extract<SessionEvent, { type: 'command' }> | undefined {
  const commands = events.filter(
    (event): event is Extract<SessionEvent, { type: 'command' }> =>
      event.type === 'command' && !isLowSignalSessionCommand(event.command)
  );
  return commands.at(-1);
}

export async function listRecentSessions(limit = 8): Promise<SessionListEntry[]> {
  return (await scanRecentSessions(limit)).entries;
}

export async function planSessionDelete(
  specifier: string,
  currentSessionId?: string
): Promise<SessionDeletePlan> {
  const resolution = await resolveSessionEntry(specifier, currentSessionId);
  return {
    entry: resolution.entry,
    warning: resolution.warning,
    isCurrent: resolution.entry?.sessionId === currentSessionId,
  };
}

export async function planIdleSessionCleanup(
  currentSessionId?: string,
  count?: number
): Promise<SessionCleanupPlan> {
  const scan = await scanRecentSessions();
  const idleEntries: SessionListEntry[] = [];

  for (const entry of scan.entries) {
    if (entry.sessionId === currentSessionId) {
      continue;
    }

    const loaded = await loadSessionEvents(entry.sessionPath);
    const summary = summarizeSessionActivity(loaded.events);
    if (summary.profile === 'idle') {
      idleEntries.push(entry);
    }
  }

  const selected =
    typeof count === 'number' && count > 0 ? idleEntries.slice(-count) : idleEntries;

  return {
    entries: [...selected].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    warning: renderScanWarning(scan, 'saved sessions'),
  };
}

export async function planSessionPrune(
  keepCount: number,
  currentSessionId?: string
): Promise<SessionCleanupPlan> {
  const scan = await scanRecentSessions();
  const keep = new Set<string>();

  for (const entry of scan.entries.slice(0, Math.max(1, keepCount))) {
    keep.add(entry.sessionId);
  }

  let preservedCurrentOutsideWindow = false;
  if (currentSessionId && !keep.has(currentSessionId)) {
    const hasCurrent = scan.entries.some((entry) => entry.sessionId === currentSessionId);
    if (hasCurrent) {
      keep.add(currentSessionId);
      preservedCurrentOutsideWindow = true;
    }
  }

  return {
    entries: scan.entries.filter((entry) => !keep.has(entry.sessionId)),
    warning: renderScanWarning(scan, 'saved sessions'),
    preservedCurrentOutsideWindow,
  };
}

export async function deleteSessionEntries(entries: SessionListEntry[]): Promise<void> {
  for (const entry of entries) {
    await rm(entry.sessionPath, { force: true });
  }
}

export async function resolveSessionEntry(
  specifier: string,
  currentSessionId?: string
): Promise<SessionResolution> {
  const normalized = specifier.trim();
  if (isSafeSessionSpecifier(normalized)) {
    const directSessionPath = buildSessionPath(normalized);
    if (existsSync(directSessionPath)) {
      const directEntry = await loadSessionEntry(directSessionPath);
      if (!directEntry.entry) {
        throw new Error(
          `Session log is corrupted: ${directEntry.corruptionReason ?? normalized}`
        );
      }

      return {
        entry: directEntry.entry,
      };
    }
  }

  const scan = await scanRecentSessions(200);
  const warning = renderScanWarning(scan, 'saved sessions');

  if (normalized === 'latest' || normalized === 'previous') {
    return {
      entry: scan.entries.find((entry) => entry.sessionId !== currentSessionId) ?? null,
      warning,
    };
  }

  const exactMatch = scan.entries.find((entry) => entry.sessionId === normalized);
  if (exactMatch) {
    return {
      entry: exactMatch,
      warning,
    };
  }

  const prefixMatches = scan.entries.filter((entry) => entry.sessionId.startsWith(normalized));
  if (prefixMatches.length === 1) {
    return {
      entry: prefixMatches[0],
      warning,
    };
  }

  if (prefixMatches.length > 1) {
    throw new Error(
      `Session reference "${normalized}" is ambiguous. Use more of the session id from /sessions.`
    );
  }

  return {
    entry: null,
    warning,
  };
}

export async function renderSessionList(limit = 8, options: SessionListOptions = {}): Promise<string> {
  const sessionsDir = getSessionsDir();
  const query = options.query?.trim();
  const scan = await scanRecentSessions(query ? 200 : limit);
  const entries = query
    ? scan.entries.filter((entry) => matchesSessionSearch(entry, query)).slice(0, limit)
    : scan.entries;

  if (entries.length === 0) {
    const warning = renderScanWarning(scan, 'saved sessions');
    return [
      warning,
      query
        ? `No saved sessions matched "${query}" under ${sessionsDir}`
        : `No saved sessions found under ${sessionsDir}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const lines = [`Saved sessions (${entries.length})`, `Root: ${sessionsDir}`];
  if (query) {
    lines.push(`Filter: ${query}`);
  }
  lines.push('Latest first:');

  const warning = renderScanWarning(scan, 'saved sessions');
  if (warning) {
    lines.push(warning);
  }

  for (const entry of entries) {
    const currentLabel = entry.sessionId === options.currentSessionId ? ' (current)' : '';
    lines.push(`- id: ${entry.sessionId}${currentLabel}`);
    lines.push(`  title: ${entry.title}`);
    lines.push(`  last active: ${formatSessionTimestamp(entry.lastActivityAt)}`);
    lines.push(
      `  provider=${entry.provider}, model=${entry.model || '(provider default)'}, workdir=${entry.workdir}, reason=${entry.reason}`
    );
    if (query) {
      const match = findSessionSearchMatch(entry, query);
      if (match) {
        lines.push(`  match: ${match.label} -> ${match.snippet}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export async function renderSessionComparison(
  limit = 5,
  currentSessionId?: string,
  includeIdle = false
): Promise<string> {
  const sessionsDir = getSessionsDir();
  const scan = await scanRecentSessions(200);
  const compared: Array<{ entry: SessionListEntry; summary: SessionActivitySummary }> = [];

  for (const entry of scan.entries) {
    const loaded = await loadSessionEvents(entry.sessionPath);
    const summary = summarizeSessionActivity(loaded.events);
    if (!includeIdle && summary.profile === 'idle') {
      continue;
    }
    compared.push({ entry, summary });
    if (compared.length >= limit) {
      break;
    }
  }

  if (compared.length === 0) {
    const warning = renderScanWarning(scan, 'saved sessions');
    return [
      warning,
      includeIdle
        ? `No saved sessions found under ${sessionsDir}`
        : `No non-idle saved sessions found under ${sessionsDir}. Use /sessions compare all to include idle sessions.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const lines = [
    `Recent session comparison (${compared.length})`,
    `Root: ${sessionsDir}`,
    includeIdle ? 'Latest first (including idle):' : 'Latest first (idle hidden):',
  ];
  const warning = renderScanWarning(scan, 'saved sessions');
  if (warning) {
    lines.push(warning);
  }

  for (const { entry, summary } of compared) {
    const currentLabel = entry.sessionId === currentSessionId ? ' (current)' : '';

    lines.push(`- id: ${entry.sessionId}${currentLabel}`);
    lines.push(`  title: ${entry.title}`);
    lines.push(`  last active: ${formatSessionTimestamp(entry.lastActivityAt)}`);
    lines.push(
      `  provider=${entry.provider}, model=${entry.model || '(provider default)'}, reason=${entry.reason}`
    );
    lines.push(
      `  activity: user=${summary.userMessages}, assistant=${summary.assistantMessages}, repl commands=${summary.replCommands}, config=${summary.configChanges}, total=${summary.totalEvents}`
    );
    lines.push(`  profile: ${summary.profile}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export async function renderSessionSummary(sessionPath: string, limit = 5): Promise<string> {
  if (!existsSync(sessionPath)) {
    return `Session file not found: ${sessionPath}`;
  }

  const loaded = await loadSessionEvents(sessionPath);
  if (loaded.readError) {
    return `Session log could not be read: ${loaded.readError}`;
  }

  const events = loaded.events;
  if (events.length === 0) {
    if (loaded.malformedLineCount > 0) {
      return `Session log is corrupted: no readable events found in ${sessionPath} (${formatMalformedLineWarning(loaded.malformedLineCount)}).`;
    }

    return 'No session events were recorded.';
  }

  const startedEvent = events.find((event) => event.type === 'session_started');
  if (!startedEvent || startedEvent.type !== 'session_started') {
    return `Session log is corrupted: missing a readable session_started event in ${sessionPath}.`;
  }

  const summary = summarizeSessionActivity(events);
  const title = deriveSessionTitle(events, startedEvent.reason);
  const firstUserMessage = findFirstMeaningfulUserMessage(events);
  const lastUserMessage = findLastUserMessage(events);
  const lastAssistantMessage = findLastAssistantMessage(events);
  const lastMeaningfulCommand = findLastMeaningfulCommand(events);
  const visibleEvents = events.filter((event) => event.type !== 'session_started').slice(-limit);

  const lines = [
    `Session summary: ${startedEvent.sessionId}`,
    `Path: ${sessionPath}`,
    `Title: ${title}`,
    `Started: ${formatSessionTimestamp(startedEvent.timestamp)}`,
    `Last active: ${formatSessionTimestamp(events.at(-1)?.timestamp ?? startedEvent.timestamp)}`,
    `Provider/model: ${startedEvent.config.provider} / ${startedEvent.config.model || '(provider default)'}`,
    `Workdir: ${startedEvent.config.workdir}`,
    `Reason: ${startedEvent.reason}`,
    `Activity: user=${summary.userMessages}, assistant=${summary.assistantMessages}, repl commands=${summary.replCommands}, config=${summary.configChanges}, total=${summary.totalEvents}`,
    `Profile: ${summary.profile}`,
  ];

  if (loaded.malformedLineCount > 0) {
    lines.push(`Warning: ${formatMalformedLineWarning(loaded.malformedLineCount)} while reading this session.`);
  }

  if (firstUserMessage) {
    lines.push(`First request: ${truncateInline(firstUserMessage.content)}`);
  }

  if (lastUserMessage) {
    lines.push(`Last user message: ${truncateInline(lastUserMessage.content)}`);
  }

  if (lastAssistantMessage) {
    lines.push(`Last assistant reply: ${truncateInline(lastAssistantMessage.content)}`);
  }

  if (lastMeaningfulCommand) {
    lines.push(`Last meaningful command: ${lastMeaningfulCommand.command}`);
  }

  lines.push(`Recent events (${visibleEvents.length}):`);

  if (visibleEvents.length === 0) {
    lines.push('- No user-facing events yet.');
    return lines.join('\n');
  }

  for (const event of visibleEvents) {
    const time = formatTime(event.timestamp);

    if (event.type === 'message') {
      lines.push(`- [${time}] ${event.role}: ${truncateInline(event.content)}`);
      continue;
    }

    if (event.type === 'command') {
      lines.push(`- [${time}] command: ${event.command}`);
      continue;
    }

    if (event.type === 'config') {
      lines.push(
        `- [${time}] config (${event.reason}): provider=${event.config.provider}, model=${event.config.model || '(provider default)'}, workdir=${event.config.workdir}`
      );
      continue;
    }

    if (event.type === 'title') {
      lines.push(`- [${time}] title: ${event.title}`);
    }
  }

  return lines.join('\n');
}

export async function renderSessionHistory(sessionPath: string, limit = 12): Promise<string> {
  if (!existsSync(sessionPath)) {
    return `Session file not found: ${sessionPath}`;
  }

  const loaded = await loadSessionEvents(sessionPath);
  if (loaded.readError) {
    return `Session log could not be read: ${loaded.readError}`;
  }

  const events = loaded.events;
  if (events.length === 0) {
    if (loaded.malformedLineCount > 0) {
      return `Session log is corrupted: no readable events found in ${sessionPath} (${formatMalformedLineWarning(loaded.malformedLineCount)}).`;
    }

    return 'No session events were recorded.';
  }

  const startedEvent = events.find((event) => event.type === 'session_started');
  const visibleEvents = events.filter((event) => event.type !== 'session_started').slice(-limit);

  const headerLines = [
    startedEvent && startedEvent.type === 'session_started'
      ? `Session ${startedEvent.sessionId}`
      : `Session ${path.basename(sessionPath, '.jsonl')}`,
    `Path: ${sessionPath}`,
    startedEvent && startedEvent.type === 'session_started'
      ? `Started: ${startedEvent.timestamp}`
      : '',
    startedEvent && startedEvent.type === 'session_started'
      ? `Workdir: ${startedEvent.config.workdir}`
      : '',
  ].filter(Boolean);

  const warningLines: string[] = [];
  if (loaded.malformedLineCount > 0) {
    warningLines.push(
      `Warning: ${formatMalformedLineWarning(loaded.malformedLineCount)} while reading this session.`
    );
  }

  if (!startedEvent) {
    warningLines.push('Warning: session start metadata is missing or unreadable.');
  }

  const lines = [...headerLines, ...warningLines, `Recent events (${visibleEvents.length}):`];

  if (visibleEvents.length === 0) {
    lines.push('- No user-facing events yet.');
    return lines.join('\n');
  }

  for (const event of visibleEvents) {
    const time = formatTime(event.timestamp);

    if (event.type === 'message') {
      lines.push(`- [${time}] ${event.role}: ${truncateInline(event.content)}`);
      continue;
    }

    if (event.type === 'command') {
      lines.push(`- [${time}] command: ${event.command}`);
      continue;
    }

    if (event.type === 'config') {
      lines.push(
        `- [${time}] config (${event.reason}): provider=${event.config.provider}, model=${event.config.model || '(provider default)'}, workdir=${event.config.workdir}`
      );
      continue;
    }

    if (event.type === 'title') {
      lines.push(`- [${time}] title: ${event.title}`);
    }
  }

  return lines.join('\n');
}

export async function loadSessionConversation(
  sessionPath: string,
  limit = 24
): Promise<SessionConversationLoad> {
  if (!existsSync(sessionPath)) {
    throw new Error(`Session file not found: ${sessionPath}`);
  }

  const loaded = await loadSessionEvents(sessionPath);
  if (loaded.readError) {
    throw new Error(`Session log could not be read: ${loaded.readError}`);
  }

  const startedEvent = loaded.events.find((event) => event.type === 'session_started');
  const messageEvents = loaded.events.filter(
    (event): event is Extract<SessionEvent, { type: 'message' }> => event.type === 'message'
  );
  const summary = summarizeSessionActivity(loaded.events);
  const firstUserMessage = findFirstMeaningfulUserMessage(loaded.events);
  const lastUserMessage = findLastUserMessage(loaded.events);
  const lastAssistantMessage = findLastAssistantMessage(loaded.events);
  const lastMeaningfulCommand = findLastMeaningfulCommand(loaded.events);
  const messages = messageEvents
    .slice(-Math.max(1, limit))
    .map((event) => ({
      role: event.role,
      content: event.content,
    }));

  const warningParts: string[] = [];
  if (loaded.malformedLineCount > 0) {
    warningParts.push(formatMalformedLineWarning(loaded.malformedLineCount));
  }
  if (!startedEvent) {
    warningParts.push('session start metadata is missing or unreadable');
  }

  return {
    sessionId:
      startedEvent && startedEvent.type === 'session_started'
        ? startedEvent.sessionId
        : path.basename(sessionPath, '.jsonl'),
    startedAt:
      startedEvent && startedEvent.type === 'session_started'
        ? startedEvent.timestamp
        : undefined,
    lastActivityAt: loaded.events.at(-1)?.timestamp,
    title:
      startedEvent && startedEvent.type === 'session_started'
        ? deriveSessionTitle(loaded.events, startedEvent.reason)
        : '(unknown session)',
    workdir:
      startedEvent && startedEvent.type === 'session_started'
        ? startedEvent.config.workdir
        : undefined,
    provider:
      startedEvent && startedEvent.type === 'session_started'
        ? startedEvent.config.provider
        : undefined,
    model:
      startedEvent && startedEvent.type === 'session_started'
        ? startedEvent.config.model
        : undefined,
    reason:
      startedEvent && startedEvent.type === 'session_started'
        ? startedEvent.reason
        : undefined,
    messages,
    totalMessages: messageEvents.length,
    userMessages: summary.userMessages,
    assistantMessages: summary.assistantMessages,
    replCommands: summary.replCommands,
    configChanges: summary.configChanges,
    profile: summary.profile,
    firstRequest: firstUserMessage?.content,
    lastUserMessage: lastUserMessage?.content,
    lastAssistantReply: lastAssistantMessage?.content,
    lastMeaningfulCommand: lastMeaningfulCommand?.command,
    warning:
      warningParts.length > 0
        ? `Warning: ${warningParts.join(' and ')} while resuming this session.`
        : undefined,
  };
}

export function renderResumeContext(
  loadedConversation: SessionConversationLoad,
  currentConfig: AgentConfig
): string {
  const sourceSummary = `Source session: provider=${
    loadedConversation.provider ?? '(unknown)'
  }, model=${
    loadedConversation.model || '(provider default)'
  }, workdir=${loadedConversation.workdir ?? '(unknown)'}`;
  const currentSummary = `Current runtime: provider=${currentConfig.provider}, model=${
    currentConfig.model || '(provider default)'
  }, workdir=${currentConfig.workdir}`;

  const lines = [
    loadedConversation.warning,
    `Resumed ${loadedConversation.messages.length} message${
      loadedConversation.messages.length === 1 ? '' : 's'
    } from session ${loadedConversation.sessionId}.`,
    `Total saved messages in that session: ${loadedConversation.totalMessages}.`,
    loadedConversation.title ? `Title: ${loadedConversation.title}` : undefined,
    loadedConversation.startedAt
      ? `Started: ${formatSessionTimestamp(loadedConversation.startedAt)}`
      : undefined,
    loadedConversation.lastActivityAt
      ? `Last active: ${formatSessionTimestamp(loadedConversation.lastActivityAt)}`
      : undefined,
    sourceSummary,
    currentSummary,
    'Note: resume restores conversation only. The current runtime above will handle the next turn.',
    `Activity: user=${loadedConversation.userMessages}, assistant=${loadedConversation.assistantMessages}, repl commands=${loadedConversation.replCommands}, config=${loadedConversation.configChanges}, profile=${loadedConversation.profile}`,
    loadedConversation.firstRequest
      ? `First request: ${truncateInline(loadedConversation.firstRequest)}`
      : undefined,
    loadedConversation.lastUserMessage
      ? `Last user message: ${truncateInline(loadedConversation.lastUserMessage)}`
      : undefined,
    loadedConversation.lastAssistantReply
      ? `Last assistant reply: ${truncateInline(loadedConversation.lastAssistantReply)}`
      : undefined,
    loadedConversation.lastMeaningfulCommand
      ? `Last meaningful command: ${loadedConversation.lastMeaningfulCommand}`
      : undefined,
  ].filter(Boolean);

  return lines.join('\n');
}

export function renderRuntimeStatus(
  loadedConversation: SessionConversationLoad,
  currentConfig: AgentConfig,
  sessionPath: string,
  resumeSourceSessionId?: string
): string {
  const baseUrl =
    currentConfig.provider === 'codex' ? '(managed by codex CLI)' : currentConfig.baseUrl;

  const lines = [
    'Current status',
    `Session id: ${loadedConversation.sessionId}`,
    `Path: ${sessionPath}`,
    loadedConversation.title ? `Title: ${loadedConversation.title}` : undefined,
    loadedConversation.startedAt
      ? `Started: ${formatSessionTimestamp(loadedConversation.startedAt)}`
      : undefined,
    loadedConversation.lastActivityAt
      ? `Last active: ${formatSessionTimestamp(loadedConversation.lastActivityAt)}`
      : undefined,
    `Runtime: provider=${currentConfig.provider}, model=${
      currentConfig.model || '(provider default)'
    }, baseUrl=${baseUrl}, workdir=${currentConfig.workdir}`,
    `Flags: autoApprove=${currentConfig.autoApprove}, maxTurns=${currentConfig.maxTurns}, temperature=${currentConfig.temperature}`,
    `Resume source: ${resumeSourceSessionId ?? '(none)'}`,
    `Saved activity: user=${loadedConversation.userMessages}, assistant=${loadedConversation.assistantMessages}, repl commands=${loadedConversation.replCommands}, config=${loadedConversation.configChanges}, profile=${loadedConversation.profile}`,
    `Saved conversation messages: ${loadedConversation.totalMessages}`,
    loadedConversation.firstRequest
      ? `First request: ${truncateInline(loadedConversation.firstRequest)}`
      : undefined,
    loadedConversation.lastUserMessage
      ? `Last user message: ${truncateInline(loadedConversation.lastUserMessage)}`
      : undefined,
    loadedConversation.lastAssistantReply
      ? `Last assistant reply: ${truncateInline(loadedConversation.lastAssistantReply)}`
      : undefined,
    loadedConversation.lastMeaningfulCommand
      ? `Last meaningful command: ${loadedConversation.lastMeaningfulCommand}`
      : undefined,
    loadedConversation.warning,
  ].filter(Boolean);

  return lines.join('\n');
}
