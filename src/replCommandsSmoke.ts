import {
  isWholeNumberText,
  normalizeReplCommandAlias,
  parseHistoryRequest,
  parsePositiveCount,
  parseResumeRequest,
  parseSessionsRequest,
} from './replCommands.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  assert(normalizeReplCommandAlias('/session') === '/sessions', 'Expected /session alias to normalize.');
  assert(
    normalizeReplCommandAlias('/session 5') === '/sessions 5',
    'Expected /session count alias to normalize.'
  );

  assert(isWholeNumberText('10') === true, 'Expected plain digits to count as a whole number.');
  assert(
    isWholeNumberText('2026-04-08T08-54-23-747Z-l4o0ov') === false,
    'Expected session ids not to count as whole numbers.'
  );
  assert(
    parsePositiveCount('2026-04-08T08-54-23-747Z-l4o0ov', 8, 30) === 8,
    'Expected session id text not to be treated as a count.'
  );

  const sessionsDefault = parseSessionsRequest('/sessions');
  assert(
    sessionsDefault.kind === 'list' && sessionsDefault.count === 8,
    'Expected bare /sessions to use the default count.'
  );

  const sessionsCount = parseSessionsRequest('/sessions 12');
  assert(
    sessionsCount.kind === 'list' && sessionsCount.count === 12,
    'Expected /sessions <count> to parse as a session list request.'
  );

  const sessionsSearch = parseSessionsRequest('/sessions search codex 15');
  assert(
    sessionsSearch.kind === 'search' &&
      sessionsSearch.query === 'codex' &&
      sessionsSearch.count === 15,
    'Expected /sessions search <query> <count> to parse as a filtered session request.'
  );

  const sessionsFindAlias = parseSessionsRequest('/sessions find hello world');
  assert(
    sessionsFindAlias.kind === 'search' &&
      sessionsFindAlias.query === 'hello world' &&
      sessionsFindAlias.count === 8,
    'Expected /sessions find to work as a search alias.'
  );

  const sessionsCompare = parseSessionsRequest('/sessions compare 6');
  assert(
    sessionsCompare.kind === 'compare' && sessionsCompare.count === 6,
    'Expected /sessions compare <count> to parse as a comparison request.'
  );

  const sessionsInvalid = parseSessionsRequest('/sessions 2026-04-08T08-54-23-747Z-l4o0ov');
  assert(
    sessionsInvalid.kind === 'invalid',
    'Expected /sessions <session-id> to stay invalid instead of being treated as a count.'
  );

  const historyById = parseHistoryRequest('/history 2026-04-08T08-54-23-747Z-l4o0ov');
  assert(
    historyById.sessionRef === '2026-04-08T08-54-23-747Z-l4o0ov' && historyById.count === 12,
    'Expected /history <session-id> to resolve as a session reference.'
  );

  const resumeById = parseResumeRequest('/resume 2026-04-08T08-54-23-747Z-l4o0ov');
  assert(
    resumeById.sessionRef === '2026-04-08T08-54-23-747Z-l4o0ov' && resumeById.count === 24,
    'Expected /resume <session-id> to resolve as a session reference.'
  );

  const resumeByCount = parseResumeRequest('/resume 40');
  assert(
    resumeByCount.sessionRef === 'latest' && resumeByCount.count === 40,
    'Expected /resume <count> to keep using latest.'
  );

  console.log('[repl-smoke] All REPL command parsing checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[repl-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
