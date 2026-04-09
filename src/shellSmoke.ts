import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTools } from './tools.js';

import type { AgentConfig, ToolContext, ToolDefinition } from './types.js';

function assertIncludes(text: string, snippet: string, label: string): void {
  if (!text.includes(snippet)) {
    throw new Error(`${label} is missing "${snippet}".\n\nActual output:\n${text}`);
  }
}

function getRunShellTool(): ToolDefinition {
  const tool = createTools().find((candidate) => candidate.name === 'run_shell');
  if (!tool) {
    throw new Error('run_shell tool is not available.');
  }

  return tool;
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mmca-shell-smoke-'));
  const config: AgentConfig = {
    provider: 'ollama',
    model: 'qwen2.5-coder:14b',
    baseUrl: 'http://127.0.0.1:11434',
    workdir: tempRoot,
    autoApprove: false,
    maxTurns: 8,
    temperature: 0.2,
  };
  const context: ToolContext = {
    config,
    confirm: async () => false,
    log: (message: string) => {
      console.log(`[shell-smoke] ${message}`);
    },
  };
  const runShell = getRunShellTool();

  try {
    const defaultResult = await runShell.run(
      {
        command: process.platform === 'win32' ? 'echo default-shell-ok' : 'printf default-shell-ok',
        timeoutMs: 10_000,
      },
      context
    );
    if (!defaultResult.ok) {
      throw new Error(`Default shell smoke failed:\n${defaultResult.output}`);
    }
    assertIncludes(defaultResult.summary, 'run_shell SUCCESS:', 'default shell summary');
    assertIncludes(defaultResult.output, 'SHELL: default', 'default shell output');
    assertIncludes(defaultResult.output, 'default-shell-ok', 'default shell stdout');

    if (process.platform === 'win32') {
      const cmdResult = await runShell.run(
        {
          command: 'echo cmd-shell-ok',
          timeoutMs: 10_000,
          shell: 'cmd',
        },
        context
      );
      if (!cmdResult.ok) {
        throw new Error(`cmd shell smoke failed:\n${cmdResult.output}`);
      }
      assertIncludes(cmdResult.summary, 'run_shell SUCCESS:', 'cmd shell summary');
      assertIncludes(cmdResult.output, 'SHELL: cmd', 'cmd shell output');
      assertIncludes(cmdResult.output, 'cmd-shell-ok', 'cmd shell stdout');

      const fallbackResult = await runShell.run(
        {
          command: "Write-Output 'powershell-fallback-ok'",
          timeoutMs: 10_000,
        },
        context
      );
      if (!fallbackResult.ok) {
        throw new Error(`powershell fallback smoke failed:\n${fallbackResult.output}`);
      }
      assertIncludes(
        fallbackResult.summary,
        'run_shell SUCCESS:',
        'powershell fallback summary'
      );
      assertIncludes(
        fallbackResult.output,
        'AUTO RETRY: default -> powershell',
        'powershell fallback retry note'
      );
      assertIncludes(
        fallbackResult.output,
        'powershell-fallback-ok',
        'powershell fallback stdout'
      );
    }

    const powerShellResult = await runShell.run(
      {
        command: "Write-Output 'powershell-shell-ok'",
        timeoutMs: 10_000,
        shell: 'powershell',
      },
      context
    );
    if (!powerShellResult.ok) {
      throw new Error(`powershell shell smoke failed:\n${powerShellResult.output}`);
    }
    assertIncludes(powerShellResult.summary, 'run_shell SUCCESS:', 'powershell summary');
    assertIncludes(powerShellResult.output, 'SHELL: powershell', 'powershell output');
    assertIncludes(powerShellResult.output, 'powershell-shell-ok', 'powershell stdout');

    console.log('[shell-smoke] All shell checks passed.');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[shell-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
