import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
    };

export type SessionStore = {
  sessionId: string;
  sessionPath: string;
  logMessage: (role: ChatRole, content: string) => Promise<void>;
  logCommand: (command: string) => Promise<void>;
  logConfig: (reason: string, config: AgentConfig) => Promise<void>;
};

export type SessionListEntry = {
  sessionId: string;
  sessionPath: string;
  startedAt: string;
  workdir: string;
  provider: AgentConfig['provider'];
  model: string;
  reason: string;
};

export type SessionResolution = {
  entry: SessionListEntry | null;
  warning?: string;
};

export type SessionConversationLoad = {
  sessionId: string;
  startedAt?: string;
  workdir?: string;
  provider?: AgentConfig['provider'];
  model?: string;
  reason?: string;
  messages: ChatMessage[];
  totalMessages: number;
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

  return {
    entry: {
      sessionId: startedEvent.sessionId,
      sessionPath,
      startedAt: startedEvent.timestamp,
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
  };
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toISOString().slice(11, 19);
}

export async function listRecentSessions(limit = 8): Promise<SessionListEntry[]> {
  return (await scanRecentSessions(limit)).entries;
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

export async function renderSessionList(limit = 8, currentSessionId?: string): Promise<string> {
  const sessionsDir = getSessionsDir();
  const scan = await scanRecentSessions(limit);
  const entries = scan.entries;

  if (entries.length === 0) {
    const warning = renderScanWarning(scan, 'saved sessions');
    return [warning, `No saved sessions found under ${sessionsDir}`].filter(Boolean).join('\n');
  }

  const lines = [
    `Saved sessions (${entries.length})`,
    `Root: ${sessionsDir}`,
    'Latest first:',
  ];

  const warning = renderScanWarning(scan, 'saved sessions');
  if (warning) {
    lines.push(warning);
  }

  for (const entry of entries) {
    const currentLabel = entry.sessionId === currentSessionId ? ' (current)' : '';
    lines.push(
      `- ${entry.sessionId}${currentLabel}: provider=${entry.provider}, model=${entry.model || '(provider default)'}, workdir=${entry.workdir}, reason=${entry.reason}`
    );
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
    warning:
      warningParts.length > 0
        ? `Warning: ${warningParts.join(' and ')} while resuming this session.`
        : undefined,
  };
}
