import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { relativeToRoot, resolvePathInsideRoot } from './pathUtils.js';

export type WritePatchPreview =
  | {
      operation: 'create';
      path: string;
      overwrite: boolean;
      lineCount: number;
      charCount: number;
      diffPreview: string;
    }
  | {
      operation: 'replace';
      path: string;
      replaceAll: boolean;
      matches: number;
      firstMatchLine: number | null;
      previewNote?: string;
      diffPreview: string;
    };

function optionalBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getStringFromAliases(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return '';
}

function requireStringFromAliases(args: Record<string, unknown>, keys: string[], label: string): string {
  const value = getStringFromAliases(args, keys);
  if (value.length > 0) {
    return value;
  }

  throw new Error(`Missing required string field: ${label}`);
}

function inferOperation(args: Record<string, unknown>): 'create' | 'replace' {
  const explicit = getStringFromAliases(args, ['operation']).toLowerCase();
  if (explicit === 'create' || explicit === 'replace') {
    return explicit;
  }

  const hasFind = getStringFromAliases(args, ['find', 'search', 'oldText', 'old', 'needle']).length > 0;
  const hasContent =
    getStringFromAliases(args, ['content', 'contents', 'text', 'value', 'body']).length > 0;

  if (hasFind) {
    return 'replace';
  }
  if (hasContent) {
    return 'create';
  }

  throw new Error('Missing required string field: operation');
}

export function normalizeWritePatchArgs(args: Record<string, unknown>):
  | {
      operation: 'create';
      path: string;
      content: string;
      overwrite: boolean;
    }
  | {
      operation: 'replace';
      path: string;
      find: string;
      replace: string;
      replaceAll: boolean;
    } {
  const operation = inferOperation(args);
  const path = requireStringFromAliases(args, ['path', 'filePath', 'file', 'target', 'filename'], 'path');

  if (operation === 'create') {
    return {
      operation,
      path,
      content: requireStringFromAliases(
        args,
        ['content', 'contents', 'text', 'value', 'body'],
        'content'
      ),
      overwrite:
        optionalBoolean(args, 'overwrite', false) || optionalBoolean(args, 'replaceExisting', false),
    };
  }

  return {
    operation,
    path,
    find: requireStringFromAliases(args, ['find', 'search', 'oldText', 'old', 'needle'], 'find'),
    replace: getStringFromAliases(args, ['replace', 'replacement', 'newText', 'with']),
    replaceAll: optionalBoolean(args, 'replaceAll', false) || optionalBoolean(args, 'all', false),
  };
}

function countOccurrences(source: string, target: string): number {
  if (!target) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;

  while (true) {
    const foundIndex = source.indexOf(target, startIndex);
    if (foundIndex === -1) {
      return count;
    }

    count += 1;
    startIndex = foundIndex + target.length;
  }
}

function lineNumberAtIndex(source: string, index: number): number | null {
  if (index < 0) {
    return null;
  }

  return source.slice(0, index).split(/\r?\n/).length;
}

function truncateDiffLines(lines: string[], maxLines = 14): string[] {
  if (lines.length <= maxLines) {
    return lines.length > 0 ? lines : ['  (empty)'];
  }

  const remaining = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `... [truncated ${remaining} more lines]`];
}

function renderLiteralBlock(title: string, content: string): string {
  return [title, content || '(empty)'].join('\n');
}

function buildCreateDiffPreview(content: string): string {
  const lines = content.split(/\r?\n/);
  const diffLines = ['@@ create @@', ...lines.map((line) => `+ ${line}`)];
  return truncateDiffLines(diffLines).join('\n');
}

function buildReplaceDiffPreview(
  original: string,
  updated: string,
  firstMatchLine: number | null,
  lastMatchLine: number | null
): string {
  const originalLines = original.split(/\r?\n/);
  const updatedLines = updated.split(/\r?\n/);
  const affectedStartLine = firstMatchLine ?? 1;
  const affectedEndLine = lastMatchLine ?? affectedStartLine;
  const contextStart = Math.max(1, affectedStartLine - 2);
  const contextEndOriginal = Math.min(originalLines.length, affectedEndLine + 2);
  const approxUpdatedEnd = Math.max(
    contextStart,
    Math.min(updatedLines.length, contextEndOriginal + (updatedLines.length - originalLines.length))
  );
  const beforeChunk = originalLines.slice(contextStart - 1, contextEndOriginal);
  const afterChunk = updatedLines.slice(contextStart - 1, approxUpdatedEnd);

  let prefix = 0;
  while (
    prefix < beforeChunk.length &&
    prefix < afterChunk.length &&
    beforeChunk[prefix] === afterChunk[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeChunk.length - prefix &&
    suffix < afterChunk.length - prefix &&
    beforeChunk[beforeChunk.length - 1 - suffix] === afterChunk[afterChunk.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const diffLines = [`@@ line ${contextStart} @@`];

  for (const line of beforeChunk.slice(0, prefix)) {
    diffLines.push(`  ${line}`);
  }

  for (const line of beforeChunk.slice(prefix, beforeChunk.length - suffix)) {
    diffLines.push(`- ${line}`);
  }

  for (const line of afterChunk.slice(prefix, afterChunk.length - suffix)) {
    diffLines.push(`+ ${line}`);
  }

  for (const line of beforeChunk.slice(beforeChunk.length - suffix)) {
    diffLines.push(`  ${line}`);
  }

  return truncateDiffLines(diffLines).join('\n');
}

export async function previewWritePatch(
  rootDir: string,
  args: Record<string, unknown>
): Promise<WritePatchPreview> {
  const normalized = normalizeWritePatchArgs(args);
  const operation = normalized.operation;
  const requestedPath = normalized.path;
  const absolutePath = resolvePathInsideRoot(rootDir, requestedPath);
  const relativePath = relativeToRoot(rootDir, absolutePath);

  if (operation === 'create') {
    const { content, overwrite } = normalized;

    return {
      operation: 'create',
      path: relativePath,
      overwrite,
      lineCount: content.split(/\r?\n/).length,
      charCount: content.length,
      diffPreview: buildCreateDiffPreview(content),
    };
  }

  if (operation === 'replace') {
    const { find, replace, replaceAll } = normalized;

    if (!existsSync(absolutePath)) {
      throw new Error(`File does not exist: ${requestedPath}`);
    }

    const original = await readFile(absolutePath, 'utf8');
    const matches = countOccurrences(original, find);
    const firstMatchIndex = original.indexOf(find);
    const firstMatchLine = lineNumberAtIndex(original, firstMatchIndex);
    const lastMatchLine = lineNumberAtIndex(original, firstMatchIndex + Math.max(0, find.length - 1));
    const updated = original.replace(find, replace);

    return {
      operation: 'replace',
      path: relativePath,
      replaceAll,
      matches,
      firstMatchLine,
      previewNote:
        replaceAll && matches > 1 ? `Preview shows the first of ${matches} matched locations.` : undefined,
      diffPreview: buildReplaceDiffPreview(original, updated, firstMatchLine, lastMatchLine),
    };
  }

  throw new Error(`Unsupported write_patch operation: ${operation}`);
}

export function renderWritePatchPreview(
  preview: WritePatchPreview,
  mode: 'approval' | 'result'
): string {
  if (preview.operation === 'create') {
    return [
      `${mode === 'approval' ? 'Approve create' : 'Created'}: ${preview.path}`,
      `Overwrite: ${preview.overwrite}`,
      `Content lines: ${preview.lineCount}`,
      `Content chars: ${preview.charCount}`,
      renderLiteralBlock('Diff preview:', preview.diffPreview),
    ].join('\n');
  }

  return [
    `${mode === 'approval' ? 'Approve replace' : 'Updated'}: ${preview.path}`,
    `Matches: ${preview.matches}`,
    `Replace all: ${preview.replaceAll}`,
    `First match line: ${preview.firstMatchLine ?? 'not found'}`,
    preview.previewNote ? `Preview note: ${preview.previewNote}` : '',
    renderLiteralBlock('Diff preview:', preview.diffPreview),
  ]
    .filter(Boolean)
    .join('\n');
}
