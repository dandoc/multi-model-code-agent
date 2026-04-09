import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRunner } from './agent.js';
import { terminateChildProcessTree } from './modelAdapters.js';
import { analyzeEntrypoint } from './repoAnalysis.js';
import { createTools } from './tools.js';

import type { AgentConfig, ModelAdapter, ToolDefinition } from './types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createConfig(workdir: string): AgentConfig {
  return {
    provider: 'ollama',
    model: 'qwen3-coder:30b',
    baseUrl: 'http://127.0.0.1:11434',
    workdir,
    autoApprove: true,
    maxTurns: 6,
    temperature: 0.2,
  };
}

function createSilentUi() {
  return {
    confirm: async (): Promise<boolean> => true,
    log: (message: string): void => {
      console.log(`[regression-smoke] ${message}`);
    },
  };
}

class SequenceAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;
  private index = 0;

  constructor(private readonly responses: string[]) {}

  async complete(): Promise<string> {
    const response =
      this.responses[Math.min(this.index, this.responses.length - 1)] ??
      JSON.stringify({ type: 'message', message: 'No response returned.' });
    this.index += 1;
    return response;
  }
}

async function withTempDir(prefix: string, fn: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runWritePatchFailureGuardSmoke(): Promise<void> {
  await withTempDir('mmca-write-guard-', async (tempRoot) => {
    const failingWritePatchTool: ToolDefinition = {
      name: 'write_patch',
      description: 'Simulated failing write patch.',
      inputShape: '{"operation":"create","path":"foo.txt","content":"hello"}',
      requiresApproval: false,
      run: async () => ({
        ok: false,
        summary: 'write_patch failed.',
        output: 'simulated failure',
      }),
    };

    const agent = new AgentRunner(
      createConfig(tempRoot),
      new SequenceAdapter([
        JSON.stringify({
          type: 'tool_call',
          tool: 'write_patch',
          arguments: {
            operation: 'create',
            path: 'foo.txt',
            content: 'hello',
          },
        }),
        JSON.stringify({
          type: 'message',
          message: 'Created foo.txt successfully.',
        }),
        JSON.stringify({
          type: 'message',
          message: 'Created foo.txt successfully.',
        }),
      ]),
      [failingWritePatchTool],
      createSilentUi()
    );

    const reply = await agent.runTurn(
      'Inside the current workspace, create the file foo.txt with the exact content hello'
    );

    assert(
      !reply.includes('Created foo.txt successfully.'),
      `A failed write_patch should not allow a fake completion claim.\n\nReply:\n${reply}`
    );
    assert(
      reply.includes('no successful write_patch call actually happened'),
      `Expected the corrective fallback after failed write_patch.\n\nReply:\n${reply}`
    );

    console.log('[regression-smoke] Failed write_patch completion guard passed.');
  });
}

async function runUnusableFinalResponseRecoverySmoke(): Promise<void> {
  await withTempDir('mmca-empty-response-', async (tempRoot) => {
    const emptyResponseAgent = new AgentRunner(
      createConfig(tempRoot),
      new SequenceAdapter([
        JSON.stringify({
          type: 'message',
          message: '   ',
        }),
        JSON.stringify({
          type: 'message',
          message: 'Recovered answer.',
        }),
      ]),
      [],
      createSilentUi()
    );

    const emptyReply = await emptyResponseAgent.runTurn('Say hello briefly.');
    assert(
      emptyReply === 'Recovered answer.',
      `Expected the agent to retry after an empty final answer.\n\nReply:\n${emptyReply}`
    );

    const placeholderResponseAgent = new AgentRunner(
      createConfig(tempRoot),
      new SequenceAdapter([
        JSON.stringify({
          type: 'message',
          message: '...',
        }),
        JSON.stringify({
          type: 'message',
          message: 'Recovered after placeholder.',
        }),
      ]),
      [],
      createSilentUi()
    );

    const placeholderReply = await placeholderResponseAgent.runTurn('Say hello briefly.');
    assert(
      placeholderReply === 'Recovered after placeholder.',
      `Expected the agent to retry after a placeholder final answer.\n\nReply:\n${placeholderReply}`
    );

    console.log('[regression-smoke] Empty/ellipsis final response recovery passed.');
  });
}

async function runNonJsGroundingSmoke(): Promise<void> {
  await withTempDir('mmca-go-grounding-', async (tempRoot) => {
    await writeFile(path.join(tempRoot, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
    await writeFile(path.join(tempRoot, 'main.go'), 'package main\n\nfunc main() {}\n');

    const report = await analyzeEntrypoint(tempRoot);
    assert(
      report.primaryEntrypoint === 'main.go',
      `Expected main.go to be detected as the primary entrypoint.\n\nReport: ${JSON.stringify(report, null, 2)}`
    );
    assert(
      report.candidatePaths.some((candidate) => candidate.path === 'main.go'),
      `Expected main.go to appear in entrypoint candidates.\n\nReport: ${JSON.stringify(report, null, 2)}`
    );

    const agent = new AgentRunner(
      createConfig(tempRoot),
      new SequenceAdapter([
        JSON.stringify({
          type: 'message',
          message: 'The main entrypoint is main.go and the module is defined in go.mod.',
        }),
      ]),
      createTools(),
      createSilentUi()
    );

    const reply = await agent.runTurn(
      'Find the main entrypoint of this project and explain it briefly.'
    );

    assert(reply.includes('main.go'), `Expected grounded reply to mention main.go.\n\nReply:\n${reply}`);
    assert(reply.includes('go.mod'), `Expected grounded reply to mention go.mod.\n\nReply:\n${reply}`);
    assert(
      !reply.includes('No obvious entrypoint candidate'),
      `Correct Go grounding should not be replaced by a deterministic fallback.\n\nReply:\n${reply}`
    );

    console.log('[regression-smoke] Non-JS grounding and entrypoint detection passed.');
  });
}

async function runOneShotExitCodeSmoke(): Promise<void> {
  const distIndex = path.resolve(process.cwd(), 'dist/index.js');
  if (!existsSync(distIndex)) {
    throw new Error('dist/index.js is missing. Run npm run build before smoke:regressions.');
  }

  await withTempDir('mmca-cli-failure-', async (tempRoot) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    delete env.OPENAI_ORG_ID;
    delete env.OPENAI_PROJECT;

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            distIndex,
            '--provider',
            'openai',
            '--model',
            'gpt-4o-mini',
            '--prompt',
            'hello',
            '--workdir',
            tempRoot,
          ],
          {
            cwd: tempRoot,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          }
        );

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          void terminateChildProcessTree(child);
          reject(new Error('One-shot CLI smoke timed out.'));
        }, 30_000);

        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      }
    );

    const combined = `${result.stdout}\n${result.stderr}`;
    assert(
      result.code !== 0,
      `One-shot CLI failures should exit non-zero.\n\nOutput:\n${combined}`
    );
    assert(
      combined.includes('requires an API key'),
      `Expected the missing API key failure to be surfaced.\n\nOutput:\n${combined}`
    );

    console.log('[regression-smoke] One-shot CLI exit code guard passed.');
  });
}

async function countMarkerProcesses(marker: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const command = [
      '$marker = ',
      `'${marker}'; `,
      "(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $marker + '*') } | Measure-Object).Count",
    ].join('');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Process query failed (${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }

      resolve(Number.parseInt(stdout.trim(), 10) || 0);
    });
  });
}

async function runWindowsTimeoutCleanupSmoke(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('[regression-smoke] Skipping Windows-only Codex timeout cleanup check.');
    return;
  }

  const marker = `mmca-codex-timeout-${Date.now()}`;
  const child = spawn(
    process.env.ComSpec || 'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      'powershell',
      '-NoProfile',
      '-Command',
      `$marker='${marker}'; Start-Sleep -Seconds 20`,
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
    }
  );

  await sleep(750);
  const before = await countMarkerProcesses(marker);
  assert(before >= 1, 'Expected the wrapped child process to be running before cleanup.');

  await terminateChildProcessTree(child);
  await sleep(750);

  const after = await countMarkerProcesses(marker);
  assert(after === 0, `Expected taskkill tree cleanup to remove child processes. Remaining: ${after}`);

  console.log('[regression-smoke] Windows timeout cleanup passed.');
}

async function main(): Promise<void> {
  await runWritePatchFailureGuardSmoke();
  await runUnusableFinalResponseRecoverySmoke();
  await runNonJsGroundingSmoke();
  await runOneShotExitCodeSmoke();
  await runWindowsTimeoutCleanupSmoke();
  console.log('[regression-smoke] All regression checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[regression-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
