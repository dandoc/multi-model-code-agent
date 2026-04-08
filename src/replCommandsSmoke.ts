import {
  isWholeNumberText,
  normalizeReplCommandAlias,
  parseHistoryRequest,
  parsePositiveCount,
  parseResumeRequest,
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
