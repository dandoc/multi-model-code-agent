import type { ModelProvider } from './types.js';
import { DEFAULT_MAX_TURNS, DEFAULT_TEMPERATURE, MAX_TEMPERATURE } from './config.js';

export function isWholeNumberText(value: string | undefined): boolean {
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}

export function parsePositiveCount(value: string | undefined, fallback: number, max = 50): number {
  if (!isWholeNumberText(value)) {
    return fallback;
  }

  const parsed = Number.parseInt(value!.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(max, parsed));
}

export function parseHistoryRequest(entry: string): { sessionRef?: string; count: number } {
  const args = entry
    .slice('/history'.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    return { count: 12 };
  }

  if (args.length === 1) {
    if (isWholeNumberText(args[0])) {
      return { count: parsePositiveCount(args[0], 12) };
    }

    return { sessionRef: args[0], count: 12 };
  }

  return {
    sessionRef: args[0],
    count: parsePositiveCount(args[1], 12),
  };
}

export function parseResumeRequest(entry: string): {
  sessionRef?: string;
  count: number;
  applyRuntime: boolean;
} {
  const rawArgs = entry
    .slice('/resume'.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const applyRuntime = rawArgs[0]?.toLowerCase() === 'runtime';
  const args = applyRuntime ? rawArgs.slice(1) : rawArgs;

  if (args.length === 0) {
    return { sessionRef: 'latest', count: 24, applyRuntime };
  }

  if (args.length === 1) {
    if (isWholeNumberText(args[0])) {
      return {
        sessionRef: 'latest',
        count: parsePositiveCount(args[0], 24, 100),
        applyRuntime,
      };
    }

    return { sessionRef: args[0], count: 24, applyRuntime };
  }

  return {
    sessionRef: args[0],
    count: parsePositiveCount(args[1], 24, 100),
    applyRuntime,
  };
}

export function shouldLogHistoryViewCommand(request: { sessionRef?: string }): boolean {
  return Boolean(request.sessionRef && request.sessionRef !== 'current');
}

export type SessionsRequest =
  | {
      kind: 'list';
      count: number;
    }
  | {
      kind: 'summary';
      sessionRef: string;
      count: number;
    }
  | {
      kind: 'compare';
      count: number;
      includeIdle: boolean;
    }
  | {
      kind: 'search';
      count: number;
      query: string;
    }
  | {
      kind: 'delete';
      sessionRef: string;
    }
  | {
      kind: 'clear-idle';
      count?: number;
    }
  | {
      kind: 'prune';
      keepCount: number;
    }
  | {
      kind: 'invalid';
      reason: string;
    };

export type ProfilesRequest =
  | {
      kind: 'list';
    }
  | {
      kind: 'search';
      query: string;
    }
  | {
      kind: 'diff';
      name: string;
    }
  | {
      kind: 'save';
      name: string;
    }
  | {
      kind: 'rename';
      from: string;
      to: string;
    }
  | {
      kind: 'load';
      name: string;
    }
  | {
      kind: 'delete';
      name: string;
    }
  | {
      kind: 'invalid';
      reason: string;
    };

export type ModelsRequest =
  | {
      kind: 'show';
      scope: 'current' | 'all' | ModelProvider;
      query?: string;
    }
  | {
      kind: 'doctor';
      scope: 'current' | 'all' | ModelProvider;
    }
  | {
      kind: 'invalid';
    reason: string;
  };

export type RuntimeSettingRequest =
  | {
      kind: 'update';
      value: number;
      usedDefault: boolean;
    }
  | {
      kind: 'invalid';
      reason: string;
    };

export function parseSessionsRequest(entry: string): SessionsRequest {
  const args = entry
    .slice('/sessions'.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    return { kind: 'list', count: 8 };
  }

  const mode = args[0]?.toLowerCase();
  if (mode === 'summary' || mode === 'show') {
    if (args.length === 1) {
      return {
        kind: 'summary',
        sessionRef: 'current',
        count: 5,
      };
    }

    if (args.length === 2) {
      if (isWholeNumberText(args[1])) {
        return {
          kind: 'summary',
          sessionRef: 'current',
          count: parsePositiveCount(args[1], 5, 20),
        };
      }

      return {
        kind: 'summary',
        sessionRef: args[1],
        count: 5,
      };
    }

    if (args.length === 3 && isWholeNumberText(args[2])) {
      return {
        kind: 'summary',
        sessionRef: args[1],
        count: parsePositiveCount(args[2], 5, 20),
      };
    }

    return {
      kind: 'invalid',
      reason: 'Use /sessions summary [current|latest|session-id] [count].',
    };
  }

  if (mode === 'compare') {
    if (args.length === 1) {
      return {
        kind: 'compare',
        count: 5,
        includeIdle: false,
      };
    }

    if (args.length === 2 && isWholeNumberText(args[1])) {
      return {
        kind: 'compare',
        count: parsePositiveCount(args[1], 5, 20),
        includeIdle: false,
      };
    }

    if (args.length === 2 && args[1]?.toLowerCase() === 'all') {
      return {
        kind: 'compare',
        count: 5,
        includeIdle: true,
      };
    }

    if (args.length === 3 && args[1]?.toLowerCase() === 'all' && isWholeNumberText(args[2])) {
      return {
        kind: 'compare',
        count: parsePositiveCount(args[2], 5, 20),
        includeIdle: true,
      };
    }

    return {
      kind: 'invalid',
      reason: 'Use /sessions compare [count] or /sessions compare all [count].',
    };
  }

  if (mode === 'search' || mode === 'find') {
    if (args.length === 1) {
      return {
        kind: 'invalid',
        reason: 'Use /sessions search <query> [count].',
      };
    }

    let count = 8;
    let queryParts = args.slice(1);
    const last = queryParts.at(-1);
    if (queryParts.length > 1 && isWholeNumberText(last)) {
      count = parsePositiveCount(last, 8, 50);
      queryParts = queryParts.slice(0, -1);
    }

    const query = queryParts.join(' ').trim();
    if (!query) {
      return {
        kind: 'invalid',
        reason: 'Use /sessions search <query> [count].',
      };
    }

    return {
      kind: 'search',
      count,
      query,
    };
  }

  if (mode === 'delete' || mode === 'remove') {
    if (args.length === 2) {
      return {
        kind: 'delete',
        sessionRef: args[1],
      };
    }

    return {
      kind: 'invalid',
      reason: 'Use /sessions delete <session-id>.',
    };
  }

  if (mode === 'clear-idle') {
    if (args.length === 1) {
      return {
        kind: 'clear-idle',
      };
    }

    if (args.length === 2 && isWholeNumberText(args[1])) {
      if (Number.parseInt(args[1], 10) <= 0) {
        return {
          kind: 'invalid',
          reason: 'Use /sessions clear-idle [count] with a positive count.',
        };
      }

      return {
        kind: 'clear-idle',
        count: parsePositiveCount(args[1], 1, 200),
      };
    }

    return {
      kind: 'invalid',
      reason: 'Use /sessions clear-idle [count].',
    };
  }

  if (mode === 'prune') {
    if (args.length === 2 && isWholeNumberText(args[1])) {
      return {
        kind: 'prune',
        keepCount: parsePositiveCount(args[1], 20, 500),
      };
    }

    return {
      kind: 'invalid',
      reason: 'Use /sessions prune <keep-count>.',
    };
  }

  if (args.length === 1 && isWholeNumberText(args[0])) {
    return {
      kind: 'list',
      count: parsePositiveCount(args[0], 8, 30),
    };
  }

  return {
    kind: 'invalid',
    reason:
      'Use /sessions [count], /sessions summary <current|latest|session-id> [count], /sessions compare [count], /sessions compare all [count], /sessions search <query> [count], /sessions delete <session-id>, /sessions clear-idle [count], or /sessions prune <keep-count>. For a specific session use /history <session-id> or /resume <session-id>.',
  };
}

export function parseProfilesRequest(entry: string): ProfilesRequest {
  const args = entry
    .slice('/profiles'.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    return { kind: 'list' };
  }

  const mode = args[0]?.toLowerCase();
  if (mode === 'search' || mode === 'find') {
    const query = args.slice(1).join(' ').trim();
    if (!query) {
      return { kind: 'invalid', reason: 'Use /profiles search <query>.' };
    }

    return { kind: 'search', query };
  }

  const name = args.slice(1).join(' ').trim();

  if (mode === 'diff' || mode === 'show') {
    if (!name) {
      return { kind: 'invalid', reason: 'Use /profiles diff <name>.' };
    }

    return { kind: 'diff', name };
  }

  if (mode === 'save') {
    if (!name) {
      return { kind: 'invalid', reason: 'Use /profiles save <name>.' };
    }
    return { kind: 'save', name };
  }

  if (mode === 'rename') {
    const separatorIndex = args.findIndex((part, index) => index > 0 && part.toLowerCase() === '--to');
    if (separatorIndex >= 0) {
      const from = args.slice(1, separatorIndex).join(' ').trim();
      const to = args.slice(separatorIndex + 1).join(' ').trim();
      if (!from || !to) {
        return { kind: 'invalid', reason: 'Use /profiles rename <old-name> --to <new-name>.' };
      }

      return {
        kind: 'rename',
        from,
        to,
      };
    }

    if (args.length !== 3) {
      return { kind: 'invalid', reason: 'Use /profiles rename <old-name> --to <new-name>.' };
    }

    return {
      kind: 'rename',
      from: args[1]!,
      to: args.slice(2).join(' ').trim(),
    };
  }

  if (mode === 'load') {
    if (!name) {
      return { kind: 'invalid', reason: 'Use /profiles load <name>.' };
    }
    return { kind: 'load', name };
  }

  if (mode === 'delete' || mode === 'remove') {
    if (!name) {
      return { kind: 'invalid', reason: 'Use /profiles delete <name>.' };
    }
    return { kind: 'delete', name };
  }

  return {
    kind: 'invalid',
    reason:
      'Use /profiles, /profiles search <query>, /profiles diff <name>, /profiles save <name>, /profiles rename <old-name> --to <new-name>, /profiles load <name>, or /profiles delete <name>.',
  };
}

export function parseModelsRequest(entry: string): ModelsRequest {
  const args = entry
    .slice('/models'.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    return { kind: 'show', scope: 'current' };
  }

  const normalizeScope = (value: string): 'current' | 'all' | ModelProvider | null => {
    const normalized = value.toLowerCase();
    if (normalized === 'current' || normalized === 'all') {
      return normalized;
    }
    if (normalized === 'ollama' || normalized === 'openai' || normalized === 'codex') {
      return normalized;
    }
    return null;
  };

  let scope: 'current' | 'all' | ModelProvider = 'current';
  let remaining = args;
  const maybeScope = normalizeScope(args[0]!);
  if (maybeScope) {
    scope = maybeScope;
    remaining = args.slice(1);
  }

  if (remaining.length === 0) {
    return { kind: 'show', scope };
  }

  const mode = remaining[0]?.toLowerCase();
  if (mode === 'doctor' || mode === 'check') {
    if (remaining.length !== 1) {
      return { kind: 'invalid', reason: 'Use /models [current|all|provider] doctor.' };
    }

    return {
      kind: 'doctor',
      scope,
    };
  }

  if (mode === 'search' || mode === 'find') {
    const query = remaining.slice(1).join(' ').trim();
    if (!query) {
      return { kind: 'invalid', reason: 'Use /models [current|all|provider] search <query>.' };
    }

    return {
      kind: 'show',
      scope,
      query,
    };
  }

  return {
    kind: 'invalid',
    reason: 'Use /models, /models all, /models <ollama|openai|codex>, /models [current|all|provider] search <query>, or /models [current|all|provider] doctor.',
  };
}

export function shouldLogSessionsViewCommand(request: SessionsRequest): boolean {
  return request.kind !== 'summary' || request.sessionRef !== 'current';
}

export function normalizeReplCommandAlias(entry: string): string {
  if (entry === '/session') {
    return '/sessions';
  }

  if (entry.startsWith('/session ')) {
    return `/sessions ${entry.slice('/session '.length)}`;
  }

  if (entry === '/profile') {
    return '/profiles';
  }

  if (entry.startsWith('/profile ')) {
    return `/profiles ${entry.slice('/profile '.length)}`;
  }

  return entry;
}

export function parseTemperatureRequest(entry: string): RuntimeSettingRequest {
  const rawValue = entry.slice('/temperature'.length).trim();
  if (!rawValue) {
    return {
      kind: 'invalid',
      reason: `Use /temperature <0-${MAX_TEMPERATURE}|default>.`,
    };
  }

  if (rawValue.toLowerCase() === 'default') {
    return {
      kind: 'update',
      value: DEFAULT_TEMPERATURE,
      usedDefault: true,
    };
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_TEMPERATURE) {
    return {
      kind: 'invalid',
      reason: `Use /temperature <0-${MAX_TEMPERATURE}|default>.`,
    };
  }

  return {
    kind: 'update',
    value: parsed,
    usedDefault: false,
  };
}

export function parseMaxTurnsRequest(entry: string): RuntimeSettingRequest {
  const rawValue = entry.slice('/max-turns'.length).trim();
  if (!rawValue) {
    return {
      kind: 'invalid',
      reason: 'Use /max-turns <1-100|default>.',
    };
  }

  if (rawValue.toLowerCase() === 'default') {
    return {
      kind: 'update',
      value: DEFAULT_MAX_TURNS,
      usedDefault: true,
    };
  }

  if (!isWholeNumberText(rawValue)) {
    return {
      kind: 'invalid',
      reason: 'Use /max-turns <1-100|default>.',
    };
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    return {
      kind: 'invalid',
      reason: 'Use /max-turns <1-100|default>.',
    };
  }

  return {
    kind: 'update',
    value: parsed,
    usedDefault: false,
  };
}
