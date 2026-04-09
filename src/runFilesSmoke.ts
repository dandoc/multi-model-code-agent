import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTools } from './tools.js';

import type { AgentConfig, ToolContext, ToolDefinition } from './types.js';

function assertIncludes(text: string, snippet: string, label: string): void {
  if (!text.includes(snippet)) {
    throw new Error(`${label} is missing "${snippet}".\n\nActual output:\n${text}`);
  }
}

function getRunFilesTool(): ToolDefinition {
  const tool = createTools().find((candidate) => candidate.name === 'run_files');
  if (!tool) {
    throw new Error('run_files tool is not available.');
  }

  return tool;
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mmca-run-files-smoke-'));
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
      console.log(`[run-files-smoke] ${message}`);
    },
  };
  const runFiles = getRunFilesTool();

  try {
    const testDir = path.join(tempRoot, 'test');
    await mkdir(testDir, { recursive: true });
    await writeFile(path.join(testDir, 'hello.js'), "console.log('Hello Run Files!');\n", 'utf8');
    await writeFile(path.join(testDir, 'hello.txt'), 'Hello text\n', 'utf8');

    const matched = await runFiles.run(
      {
        directory: 'test',
        nameContains: 'hello',
        extensions: ['.js'],
        recursive: true,
        timeoutMs: 10_000,
      },
      context
    );

    if (!matched.ok) {
      throw new Error(`run_files directory smoke failed:\n${matched.output}`);
    }
    assertIncludes(matched.summary, 'run_files SUCCESS:', 'directory smoke summary');
    assertIncludes(matched.output, 'PATH: test/hello.js', 'directory smoke path');
    assertIncludes(matched.output, 'Hello Run Files!', 'directory smoke stdout');

    const unsupported = await runFiles.run(
      {
        paths: ['test/hello.txt'],
        timeoutMs: 10_000,
      },
      context
    );

    if (unsupported.ok) {
      throw new Error(`run_files unsupported-file smoke unexpectedly succeeded:\n${unsupported.output}`);
    }
    assertIncludes(unsupported.summary, 'run_files FAILED:', 'unsupported summary');
    assertIncludes(unsupported.output, 'Unsupported file type', 'unsupported reason');

    console.log('[run-files-smoke] All run_files checks passed.');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[run-files-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
