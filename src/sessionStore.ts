import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentConfig, ChatRole } from './types.js';

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

export async function renderSessionHistory(sessionPath: string, limit = 12): Promise<string> {
  if (!existsSync(sessionPath)) {
    return `Session file not found: ${sessionPath}`;
  }

  const raw = await readFile(sessionPath, 'utf8');
  const events = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);

  if (events.length === 0) {
    return 'No session events were recorded.';
  }

  const startedEvent = events.find((event) => event.type === 'session_started');
  const visibleEvents = events.filter((event) => event.type !== 'session_started').slice(-limit);

  const lines = [
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
    `Recent events (${visibleEvents.length}):`,
  ].filter(Boolean);

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
