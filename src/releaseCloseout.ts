import { exec as execCallback } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execCallback);

export type ReleaseCloseoutScope = 'current' | 'all' | 'ollama' | 'openai' | 'codex';
export type ReleaseCloseoutMode = 'quick' | 'protocol' | 'all';

export type ReleaseCloseoutOptions = {
  includeLive: boolean;
  liveScope: ReleaseCloseoutScope;
  liveMode: ReleaseCloseoutMode;
};

export type ReleaseCloseoutStep = {
  label: string;
  command: string;
  args: string[];
};

export type ReleaseCloseoutDeps = {
  runCommand?: (command: string, args: string[]) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
};

function getNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}m ${remainingSeconds.toFixed(1)}s`;
}

function isScope(value: string): value is ReleaseCloseoutScope {
  return value === 'current' || value === 'all' || value === 'ollama' || value === 'openai' || value === 'codex';
}

function isMode(value: string): value is ReleaseCloseoutMode {
  return value === 'quick' || value === 'protocol' || value === 'all';
}

export function parseReleaseCloseoutArgs(argv: string[]): ReleaseCloseoutOptions {
  let includeLive = true;
  let liveScope: ReleaseCloseoutScope = 'current';
  let liveMode: ReleaseCloseoutMode = 'all';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (token === '--skip-live') {
      includeLive = false;
      continue;
    }

    if (token === '--scope') {
      const next = argv[index + 1];
      if (!next || !isScope(next)) {
        throw new Error('Use --scope <current|all|ollama|openai|codex>.');
      }
      liveScope = next;
      index += 1;
      continue;
    }

    if (token === '--mode') {
      const next = argv[index + 1];
      if (!next || !isMode(next)) {
        throw new Error('Use --mode <quick|protocol|all>.');
      }
      liveMode = next;
      index += 1;
      continue;
    }

    throw new Error('Use --skip-live, --scope <current|all|ollama|openai|codex>, or --mode <quick|protocol|all>.');
  }

  return {
    includeLive,
    liveScope,
    liveMode,
  };
}

export function buildReleaseCloseoutSteps(options: ReleaseCloseoutOptions): ReleaseCloseoutStep[] {
  const npm = getNpmCommand();
  const steps: ReleaseCloseoutStep[] = [
    {
      label: 'release smoke gate',
      command: npm,
      args: ['run', 'smoke:release'],
    },
  ];

  if (options.includeLive) {
    steps.push({
      label: `live provider gate (${options.liveScope} ${options.liveMode})`,
      command: npm,
      args: ['run', 'smoke:live', '--', options.liveScope, options.liveMode],
    });
  }

  return steps;
}

async function defaultRunCommand(command: string, args: string[]): Promise<void> {
  const renderedCommand = [command, ...args].join(' ');
  const { stdout, stderr } = await exec(renderedCommand, {
    cwd: process.cwd(),
    timeout: 240_000,
    maxBuffer: 1024 * 1024 * 8,
  });

  if (stdout.trim()) {
    console.log(stdout.trim());
  }
  if (stderr.trim()) {
    console.log(stderr.trim());
  }
}

export async function runReleaseCloseout(
  options: ReleaseCloseoutOptions,
  deps: ReleaseCloseoutDeps = {}
): Promise<void> {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const steps = buildReleaseCloseoutSteps(options);
  const startedAt = now();

  log('[release-closeout] Starting release closeout gate...');
  for (const step of steps) {
    const stepStartedAt = now();
    log(`[release-closeout] Running ${step.label}: ${[step.command, ...step.args].join(' ')}`);
    await runCommand(step.command, step.args);
    log(`[release-closeout] Completed ${step.label} in ${formatElapsed(now() - stepStartedAt)}`);
  }

  log(`[release-closeout] All scripted release gates passed in ${formatElapsed(now() - startedAt)}.`);
  log('[release-closeout] Manual checks remain: npm link, mm-agent --version, mm-agent --help, and one REPL sanity pass.');
}

async function main(): Promise<void> {
  const options = parseReleaseCloseoutArgs(process.argv.slice(2));
  await runReleaseCloseout(options);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n[release-closeout] Failed: ${message}`);
    process.exitCode = 1;
  });
}
