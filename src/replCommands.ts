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

export function parseResumeRequest(entry: string): { sessionRef?: string; count: number } {
  const args = entry
    .slice('/resume'.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    return { sessionRef: 'latest', count: 24 };
  }

  if (args.length === 1) {
    if (isWholeNumberText(args[0])) {
      return { sessionRef: 'latest', count: parsePositiveCount(args[0], 24, 100) };
    }

    return { sessionRef: args[0], count: 24 };
  }

  return {
    sessionRef: args[0],
    count: parsePositiveCount(args[1], 24, 100),
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

  if (args.length === 1 && isWholeNumberText(args[0])) {
    return {
      kind: 'list',
      count: parsePositiveCount(args[0], 8, 30),
    };
  }

  return {
    kind: 'invalid',
    reason:
      'Use /sessions [count], /sessions summary <current|latest|session-id> [count], /sessions compare [count], /sessions compare all [count], or /sessions search <query> [count]. For a specific session use /history <session-id> or /resume <session-id>.',
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

  return entry;
}
