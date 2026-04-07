import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from './tools.js';

import type { AgentConfig, ToolContext, ToolDefinition } from './types.js';

type BatchCase = {
  name: string;
  run: (tool: ToolDefinition, context: ToolContext, root: string) => Promise<void>;
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

function assertEqual(actual: string, expected: string, caseName: string, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${caseName} failed. ${label} did not match.\nExpected:\n${expected}\n\nActual:\n${actual}`
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

async function runBatchSuccessCase(
  tool: ToolDefinition,
  context: ToolContext,
  root: string
): Promise<void> {
  const caseName = 'Batch success';
  await writeFile(path.join(root, 'note.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

  const result = await tool.run(
    {
      edits: [
        {
          operation: 'replace',
          path: 'note.txt',
          find: 'beta',
          replace: 'beta updated',
        },
        {
          operation: 'create',
          path: 'examples/hello.txt',
          content: 'hello\n',
        },
        {
          operation: 'replace',
          path: 'note.txt',
          find: 'alpha',
          replace: 'ALPHA',
        },
      ],
      rollbackOnFailure: true,
    },
    context
  );

  console.log(`[batch-smoke] summary: ${result.summary}`);
  console.log(`[batch-smoke] output:\n${result.output}\n`);

  if (!result.ok) {
    throw new Error(`${caseName} was expected to succeed, but it failed.`);
  }

  assertIncludesAll(
    result.output,
    ['Applied batch write_patch: 3 edits across 2 files.', 'Changed files: note.txt, examples/hello.txt'],
    caseName
  );

  const noteContent = await readFile(path.join(root, 'note.txt'), 'utf8');
  const helloContent = await readFile(path.join(root, 'examples', 'hello.txt'), 'utf8');
  assertEqual(noteContent, 'ALPHA\nbeta updated\ngamma\n', caseName, 'note.txt');
  assertEqual(helloContent, 'hello\n', caseName, 'examples/hello.txt');
}

async function runEmptyCreateCase(
  tool: ToolDefinition,
  context: ToolContext,
  root: string
): Promise<void> {
  const caseName = 'Empty file create';

  const result = await tool.run(
    {
      operation: 'create',
      path: 'empty.txt',
      content: '',
      overwrite: false,
    },
    context
  );

  console.log(`[batch-smoke] summary: ${result.summary}`);
  console.log(`[batch-smoke] output:\n${result.output}\n`);

  if (!result.ok) {
    throw new Error(`${caseName} was expected to succeed, but it failed.`);
  }

  assertIncludesAll(
    result.output,
    ['Created: empty.txt', 'Content chars: 0'],
    caseName
  );

  const emptyContent = await readFile(path.join(root, 'empty.txt'), 'utf8');
  assertEqual(emptyContent, '', caseName, 'empty.txt');
}

async function runPreflightFailureCase(
  tool: ToolDefinition,
  context: ToolContext,
  root: string
): Promise<void> {
  const caseName = 'Batch preflight failure';
  await writeFile(path.join(root, 'draft.txt'), 'start\n', 'utf8');

  const result = await tool.run(
    {
      edits: [
        {
          operation: 'replace',
          path: 'draft.txt',
          find: 'start',
          replace: 'middle',
        },
        {
          operation: 'replace',
          path: 'draft.txt',
          find: 'missing',
          replace: 'done',
        },
      ],
      rollbackOnFailure: true,
    },
    context
  );

  console.log(`[batch-smoke] summary: ${result.summary}`);
  console.log(`[batch-smoke] output:\n${result.output}\n`);

  if (result.ok) {
    throw new Error(`${caseName} was expected to fail, but it succeeded.`);
  }

  if (result.summary !== 'write_patch batch failed at edit 2 of 2.') {
    throw new Error(`${caseName} failed. Unexpected summary: ${result.summary}`);
  }

  assertIncludesAll(
    result.output,
    ['Rollback: No files were written because the batch failed during preflight validation.'],
    caseName
  );

  const draftContent = await readFile(path.join(root, 'draft.txt'), 'utf8');
  assertEqual(draftContent, 'start\n', caseName, 'draft.txt');
}

async function runCommitRollbackCase(
  tool: ToolDefinition,
  context: ToolContext,
  root: string
): Promise<void> {
  const caseName = 'Batch commit rollback';
  await writeFile(path.join(root, 'commit.txt'), 'one\n', 'utf8');
  await writeFile(path.join(root, 'parent.txt'), 'blocker\n', 'utf8');

  const result = await tool.run(
    {
      edits: [
        {
          operation: 'replace',
          path: 'commit.txt',
          find: 'one',
          replace: 'two',
        },
        {
          operation: 'create',
          path: 'parent.txt/child.txt',
          content: 'nope\n',
        },
      ],
      rollbackOnFailure: true,
    },
    context
  );

  console.log(`[batch-smoke] summary: ${result.summary}`);
  console.log(`[batch-smoke] output:\n${result.output}\n`);

  if (result.ok) {
    throw new Error(`${caseName} was expected to fail, but it succeeded.`);
  }

  if (result.summary !== 'write_patch batch failed while writing parent.txt/child.txt.') {
    throw new Error(`${caseName} failed. Unexpected summary: ${result.summary}`);
  }

  assertIncludesAll(
    result.output,
    [
      'Failed path: parent.txt/child.txt',
      'Rollback: Restored 1 file.',
    ],
    caseName
  );

  const commitContent = await readFile(path.join(root, 'commit.txt'), 'utf8');
  assertEqual(commitContent, 'one\n', caseName, 'commit.txt');

  if (existsSync(path.join(root, 'parent.txt', 'child.txt'))) {
    throw new Error(`${caseName} failed. parent.txt/child.txt should not exist after rollback.`);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmca-batch-smoke-'));
  const tool = getWritePatchTool();
  const context = buildContext(root);

  const cases: BatchCase[] = [
    { name: 'Empty file create', run: runEmptyCreateCase },
    { name: 'Batch success', run: runBatchSuccessCase },
    { name: 'Batch preflight failure', run: runPreflightFailureCase },
    { name: 'Batch commit rollback', run: runCommitRollbackCase },
  ];

  try {
    for (const testCase of cases) {
      const caseStartedAt = Date.now();
      console.log(`\n[batch-smoke] ${testCase.name}`);
      await testCase.run(tool, context, root);
      console.log(`[batch-smoke] ${testCase.name} completed in ${formatElapsed(Date.now() - caseStartedAt)}`);
    }

    console.log(`\n[batch-smoke] All batch checks passed in ${formatElapsed(Date.now() - startedAt)}.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[batch-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
