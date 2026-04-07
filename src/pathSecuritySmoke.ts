import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveValidatedWorkdir } from './config.js';
import { resolvePathInsideRoot, walkFiles } from './pathUtils.js';
import { createTools } from './tools.js';

import type { AgentConfig, ToolContext, ToolDefinition } from './types.js';

function formatElapsed(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  return `${(ms / 1_000).toFixed(1)}s`;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function getTool(name: ToolDefinition['name']): ToolDefinition {
  const tool = createTools().find((item) => item.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
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

async function createDirectoryLink(targetDir: string, linkPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await symlink(path.resolve(targetDir), linkPath, 'junction');
    return;
  }

  await symlink(targetDir, linkPath, 'dir');
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mmca-path-smoke-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'mmca-path-smoke-outside-'));

  try {
    await writeFile(path.join(root, 'visible.txt'), 'hello visible\n', 'utf8');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'top-secret\n', 'utf8');
    await createDirectoryLink(outside, path.join(root, 'link-out'));

    const listFilesTool = getTool('list_files');
    const searchFilesTool = getTool('search_files');
    const context = buildContext(root);

    console.log('\n[path-smoke] Workdir validation');
    const validatedRoot = resolveValidatedWorkdir(root);
    assert(validatedRoot === path.resolve(root), 'Expected root workdir validation to succeed.');

    let missingWorkdirRejected = false;
    try {
      resolveValidatedWorkdir(path.join(root, 'missing-dir'));
    } catch {
      missingWorkdirRejected = true;
    }
    assert(missingWorkdirRejected, 'Expected a missing workdir to be rejected.');
    console.log('[path-smoke] Workdir validation completed.');

    console.log('\n[path-smoke] Direct path resolution');
    const safePath = resolvePathInsideRoot(root, 'visible.txt');
    assert(safePath === path.join(root, 'visible.txt'), 'Expected visible.txt to resolve inside root.');

    let existingEscapeRejected = false;
    try {
      resolvePathInsideRoot(root, 'link-out/secret.txt');
    } catch {
      existingEscapeRejected = true;
    }
    assert(existingEscapeRejected, 'Expected existing linked file to be rejected.');

    let newChildEscapeRejected = false;
    try {
      resolvePathInsideRoot(root, 'link-out/new-file.txt');
    } catch {
      newChildEscapeRejected = true;
    }
    assert(newChildEscapeRejected, 'Expected new file under linked directory to be rejected.');
    console.log('[path-smoke] Direct path resolution completed.');

    console.log('\n[path-smoke] Recursive traversal');
    const walkedFiles = await walkFiles(root);
    assert(
      walkedFiles.some((item) => item.endsWith(path.join('visible.txt'))),
      'Expected walkFiles to include visible.txt.'
    );
    assert(
      !walkedFiles.some((item) => item.endsWith(path.join('secret.txt'))),
      'walkFiles should not include files from outside-linked directories.'
    );
    console.log('[path-smoke] Recursive traversal completed.');

    console.log('\n[path-smoke] list_files tool');
    const listResult = await listFilesTool.run({}, context);
    assert(listResult.ok, 'Expected list_files to succeed.');
    assert(
      !listResult.output.includes('link-out/secret.txt') && !listResult.output.includes('secret.txt'),
      'list_files should not surface files from outside-linked directories.'
    );
    console.log('[path-smoke] list_files completed.');

    console.log('\n[path-smoke] search_files tool');
    const searchResult = await searchFilesTool.run({ pattern: 'top-secret' }, context);
    assert(searchResult.ok, 'Expected search_files to succeed.');
    assert(searchResult.output === 'No matches found.', 'search_files should not read outside-linked files.');
    console.log('[path-smoke] search_files completed.');

    console.log(`\n[path-smoke] All path security checks passed in ${formatElapsed(Date.now() - startedAt)}.`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[path-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
