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

export function normalizeReplCommandAlias(entry: string): string {
  if (entry === '/session') {
    return '/sessions';
  }

  if (entry.startsWith('/session ')) {
    return `/sessions ${entry.slice('/session '.length)}`;
  }

  return entry;
}
