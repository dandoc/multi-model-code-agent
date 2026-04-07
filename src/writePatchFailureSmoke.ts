import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createTools } from './tools.js';

import type { AgentConfig, ToolContext, ToolDefinition } from './types.js';

type FailureCase = {
  name: string;
  args: Record<string, unknown>;
  expectedSnippets: string[];
};

function formatElapsed(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  return `${(ms / 1_000).toFixed(1)}s`;
}

function assertIncludesAll(output: string, expectedSnippets: string[], caseName: string): void {
  const missing = expectedSnippets.filter((snippet) => !output.includes(snippet));
  if (missing.length > 0) {
    throw new Error(
      `${caseName} failed. Missing expected snippets: ${missing.join(', ')}\n\nActual output:\n${output}`
    );
  }
}

function getWritePatchTool(): ToolDefinition {
  const tool = createTools().find((item) => item.name === 'write_patch');
  if (!tool) {
    throw new Error('write_patch tool not found.');
  }

  return tool;
}

function buildContext(workdir: string): ToolContext {
  const config: AgentConfig = {
    provider: 'ollama',
    model: 'qwen2.5-coder:14b',
    baseUrl: 'http://127.0.0.1:11434',
    workdir,
    autoApprove: false,
    maxTurns: 8,
    temperature: 0.2,
  };

  return {
    config,
    confirm: async (): Promise<boolean> => false,
    log: (): void => {},
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmca-failure-smoke-'));
  const tool = getWritePatchTool();
  const context = buildContext(root);

  try {
    await writeFile(path.join(root, 'existing.txt'), 'alpha\nbeta\nalpha\n', 'utf8');

    const cases: FailureCase[] = [
      {
        name: 'Existing file create',
        args: {
          operation: 'create',
          path: 'existing.txt',
          content: 'hello',
          overwrite: false,
        },
        expectedSnippets: [
          'Reason: The target file already exists.',
          'Requested operation: create',
          'Requested path: existing.txt',
          'overwrite=true',
        ],
      },
      {
        name: 'Missing match replace',
        args: {
          operation: 'replace',
          path: 'existing.txt',
          find: 'delta',
          replace: 'omega',
          replaceAll: false,
        },
        expectedSnippets: [
          'Reason: The exact `find` string was not found in the target file.',
          'Requested operation: replace',
          'Requested path: existing.txt',
          'Read the file first',
        ],
      },
      {
        name: 'Multiple match replace',
        args: {
          operation: 'replace',
          path: 'existing.txt',
          find: 'alpha',
          replace: 'omega',
          replaceAll: false,
        },
        expectedSnippets: [
          'Reason: The `find` string matched 2 locations in existing.txt.',
          'Requested operation: replace',
          'Requested path: existing.txt',
          'replaceAll=true',
        ],
      },
      {
        name: 'Outside workdir path',
        args: {
          operation: 'create',
          path: '../outside.txt',
          content: 'hello',
        },
        expectedSnippets: [
          'Reason: The requested path points outside the current workdir.',
          'Requested operation: create',
          'Requested path: ../outside.txt',
          'Use a path inside',
        ],
      },
      {
        name: 'Missing path',
        args: {
          operation: 'create',
          content: 'hello',
        },
        expectedSnippets: [
          'Reason: The edit request did not include a target path.',
          'Requested operation: create',
          'Provide a `path` inside the current workdir.',
        ],
      },
    ];

    for (const testCase of cases) {
      const caseStartedAt = Date.now();
      console.log(`\n[failure-smoke] ${testCase.name}`);
      const result = await tool.run(testCase.args, context);
      console.log(`[failure-smoke] summary: ${result.summary}`);
      console.log(`[failure-smoke] output:\n${result.output}\n`);

      if (result.ok) {
        throw new Error(`${testCase.name} was expected to fail, but it succeeded.`);
      }

      assertIncludesAll(result.output, testCase.expectedSnippets, testCase.name);
      console.log(
        `[failure-smoke] ${testCase.name} completed in ${formatElapsed(Date.now() - caseStartedAt)}`
      );
    }

    console.log(
      `\n[failure-smoke] All failure checks passed in ${formatElapsed(Date.now() - startedAt)}.`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[failure-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
