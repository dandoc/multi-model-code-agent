import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRunner } from './agent.js';
import { createTools } from './tools.js';

import type { AgentConfig, ModelAdapter, ToolDefinition } from './types.js';

function assertIncludes(text: string, snippet: string, label: string): void {
  if (!text.includes(snippet)) {
    throw new Error(`${label} is missing "${snippet}".\n\nActual output:\n${text}`);
  }
}

function assertExcludes(text: string, snippet: string, label: string): void {
  if (text.includes(snippet)) {
    throw new Error(`${label} unexpectedly includes "${snippet}".\n\nActual output:\n${text}`);
  }
}

function createConfig(workdir: string): AgentConfig {
  return {
    provider: 'ollama',
    model: 'qwen2.5-coder:14b',
    baseUrl: 'http://127.0.0.1:11434',
    workdir,
    autoApprove: false,
    maxTurns: 8,
    temperature: 0.2,
  };
}

class NoopAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;

  async complete(): Promise<string> {
    return JSON.stringify({ type: 'message', message: 'noop' });
  }
}

function getTool(toolName: 'write_patch' | 'run_shell' | 'run_files'): ToolDefinition {
  const tool = createTools().find((item) => item.name === toolName);
  if (!tool) {
    throw new Error(`Missing tool: ${toolName}`);
  }

  return tool;
}

async function buildApprovalMessage(
  workdir: string,
  toolName: 'write_patch' | 'run_shell' | 'run_files',
  args: Record<string, unknown>
): Promise<string> {
  const agent = new AgentRunner(createConfig(workdir), new NoopAdapter(), createTools(), {
    confirm: async () => false,
    log: () => {},
  });

  return (agent as any).buildApprovalMessage(getTool(toolName), args);
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mmca-approval-smoke-'));

  try {
    const writePatchApproval = await buildApprovalMessage(tempRoot, 'write_patch', {
      edits: [
        {
          operation: 'create',
          path: 'notes.txt',
          content: 'hello\n',
        },
        {
          operation: 'create',
          path: 'nested/info.txt',
          content: '',
        },
      ],
      rollbackOnFailure: true,
    });
    assertIncludes(writePatchApproval, 'write_patch approval', 'write_patch approval header');
    assertIncludes(writePatchApproval, `cwd: ${tempRoot}`, 'write_patch approval cwd');
    assertIncludes(writePatchApproval, 'mode: batch', 'write_patch approval mode');
    assertIncludes(writePatchApproval, 'edit 1:', 'write_patch approval edit section');
    assertIncludes(writePatchApproval, 'create: notes.txt', 'write_patch approval create path');
    assertIncludes(writePatchApproval, 'diff preview:', 'write_patch approval diff label');
    assertExcludes(writePatchApproval, 'Approve this edit?', 'write_patch approval legacy question');

    const runShellApproval = await buildApprovalMessage(tempRoot, 'run_shell', {
      command: 'npm test',
      timeoutMs: 12_000,
      shell: 'powershell',
    });
    assertIncludes(runShellApproval, 'run_shell approval', 'run_shell approval header');
    assertIncludes(runShellApproval, `cwd: ${tempRoot}`, 'run_shell approval cwd');
    assertIncludes(runShellApproval, 'shell: powershell', 'run_shell approval shell');
    assertIncludes(runShellApproval, 'timeout: 12000ms', 'run_shell approval timeout');
    assertIncludes(runShellApproval, 'command:\nnpm test', 'run_shell approval command');

    const runFilesApproval = await buildApprovalMessage(tempRoot, 'run_files', {
      directory: 'examples',
      nameContains: 'hello',
      extensions: ['.js', '.py'],
      recursive: true,
      timeoutMs: 45_000,
    });
    assertIncludes(runFilesApproval, 'run_files approval', 'run_files approval header');
    assertIncludes(runFilesApproval, `cwd: ${tempRoot}`, 'run_files approval cwd');
    assertIncludes(runFilesApproval, 'timeout per file: 45000ms', 'run_files approval timeout');
    assertIncludes(runFilesApproval, 'directory: examples', 'run_files approval directory');
    assertIncludes(runFilesApproval, 'name contains: hello', 'run_files approval filter');
    assertIncludes(runFilesApproval, 'extensions: .js, .py', 'run_files approval extensions');
    assertIncludes(runFilesApproval, 'recursive: true', 'run_files approval recursive');

    console.log('[approval-smoke] All approval checks passed.');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[approval-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
