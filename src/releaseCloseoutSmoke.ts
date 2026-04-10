import {
  buildReleaseCloseoutSteps,
  parseReleaseCloseoutArgs,
  runReleaseCloseout,
} from './releaseCloseout.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const defaults = parseReleaseCloseoutArgs([]);
  assert(defaults.includeLive === true, 'Expected release closeout to include live checks by default.');
  assert(defaults.liveScope === 'current', 'Expected release closeout to default to the current provider.');
  assert(defaults.liveMode === 'all', 'Expected release closeout to default to all live checks.');

  const skipLive = parseReleaseCloseoutArgs(['--skip-live']);
  assert(skipLive.includeLive === false, 'Expected --skip-live to disable the live provider gate.');

  const customArgs = parseReleaseCloseoutArgs(['--scope', 'codex', '--mode', 'protocol']);
  assert(
    customArgs.includeLive === true && customArgs.liveScope === 'codex' && customArgs.liveMode === 'protocol',
    'Expected custom release closeout args to parse correctly.'
  );

  const steps = buildReleaseCloseoutSteps(customArgs);
  assert(
    steps.length === 2 &&
      steps[0]?.args.join(' ') === 'run smoke:release' &&
      steps[1]?.args.join(' ') === 'run smoke:live -- codex protocol',
    'Expected release closeout steps to include both the scripted release gate and the requested live gate.'
  );

  const skipLiveSteps = buildReleaseCloseoutSteps(skipLive);
  assert(
    skipLiveSteps.length === 1 && skipLiveSteps[0]?.args.join(' ') === 'run smoke:release',
    'Expected --skip-live to keep only the scripted release gate.'
  );

  let runCount = 0;
  const logs: string[] = [];
  await runReleaseCloseout(customArgs, {
    runCommand: async () => {
      runCount += 1;
    },
    now: (() => {
      let current = 0;
      return () => {
        current += 25;
        return current;
      };
    })(),
    log: (message) => {
      logs.push(message);
    },
  });

  assert(runCount === 2, 'Expected the release closeout runner to execute both steps.');
  assert(
    logs.some((message) => message.includes('Starting release closeout gate')),
    'Expected release closeout logs to include a start banner.'
  );
  assert(
    logs.some((message) => message.includes('All scripted release gates passed')),
    'Expected release closeout logs to include a success summary.'
  );
  assert(
    logs.some((message) => message.includes('Manual checks remain')),
    'Expected release closeout logs to include a manual follow-up reminder.'
  );

  console.log('[release-closeout-smoke] Release closeout checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[release-closeout-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
