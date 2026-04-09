import {
  isWholeNumberText,
  normalizeReplCommandAlias,
  parseHistoryRequest,
  parsePositiveCount,
  parseResumeRequest,
  parseSessionsRequest,
  shouldLogHistoryViewCommand,
  shouldLogSessionsViewCommand,
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
    sessionsCompare.kind === 'compare' &&
      sessionsCompare.count === 6 &&
      sessionsCompare.includeIdle === false,
    'Expected /sessions compare <count> to parse as a comparison request.'
  );

  const sessionsCompareAll = parseSessionsRequest('/sessions compare all 4');
  assert(
    sessionsCompareAll.kind === 'compare' &&
      sessionsCompareAll.count === 4 &&
      sessionsCompareAll.includeIdle === true,
    'Expected /sessions compare all <count> to include idle sessions.'
  );

  const sessionsSummaryCurrent = parseSessionsRequest('/sessions summary');
  assert(
    sessionsSummaryCurrent.kind === 'summary' &&
      sessionsSummaryCurrent.sessionRef === 'current' &&
      sessionsSummaryCurrent.count === 5,
    'Expected bare /sessions summary to target the current session.'
  );

  const sessionsSummaryById = parseSessionsRequest(
    '/sessions summary 2026-04-08T08-54-23-747Z-l4o0ov 7'
  );
  assert(
    sessionsSummaryById.kind === 'summary' &&
      sessionsSummaryById.sessionRef === '2026-04-08T08-54-23-747Z-l4o0ov' &&
      sessionsSummaryById.count === 7,
    'Expected /sessions summary <session-id> <count> to parse correctly.'
  );
  assert(
    shouldLogSessionsViewCommand(sessionsSummaryCurrent) === false,
    'Expected current-session summaries not to pollute the current session log.'
  );
  assert(
    shouldLogSessionsViewCommand(sessionsSummaryById) === true,
    'Expected earlier-session summaries to stay logged.'
  );

  const sessionsSummaryCurrentExtra = parseSessionsRequest('/sessions summary current extra');
  assert(
    sessionsSummaryCurrentExtra.kind === 'invalid',
    'Expected /sessions summary current extra to be rejected.'
  );

  const sessionsSummaryLatestExtra = parseSessionsRequest('/sessions summary latest 8 extra');
  assert(
    sessionsSummaryLatestExtra.kind === 'invalid',
    'Expected /sessions summary latest 8 extra to be rejected.'
  );

  const sessionsSummaryGarbage = parseSessionsRequest('/sessions summary foo bar baz');
  assert(
    sessionsSummaryGarbage.kind === 'invalid',
    'Expected malformed /sessions summary syntax to stay invalid.'
  );

  const sessionsDelete = parseSessionsRequest('/sessions delete 2026-04-08T08-54-23-747Z-l4o0ov');
  assert(
    sessionsDelete.kind === 'delete' &&
      sessionsDelete.sessionRef === '2026-04-08T08-54-23-747Z-l4o0ov',
    'Expected /sessions delete <session-id> to parse correctly.'
  );

  const sessionsClearIdle = parseSessionsRequest('/sessions clear-idle 12');
  assert(
    sessionsClearIdle.kind === 'clear-idle' && sessionsClearIdle.count === 12,
    'Expected /sessions clear-idle <count> to parse correctly.'
  );

  const sessionsPrune = parseSessionsRequest('/sessions prune 25');
  assert(
    sessionsPrune.kind === 'prune' && sessionsPrune.keepCount === 25,
    'Expected /sessions prune <keep-count> to parse correctly.'
  );

  const sessionsPruneInvalid = parseSessionsRequest('/sessions prune latest');
  assert(
    sessionsPruneInvalid.kind === 'invalid',
    'Expected malformed /sessions prune syntax to stay invalid.'
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
  assert(
    shouldLogHistoryViewCommand(parseHistoryRequest('/history')) === false,
    'Expected current-session /history lookups not to pollute the current session log.'
  );
  assert(
    shouldLogHistoryViewCommand(parseHistoryRequest('/history latest')) === true,
    'Expected earlier-session /history lookups to stay logged.'
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
