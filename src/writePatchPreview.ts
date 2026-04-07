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
      contentPreview: string;
    }
  | {
      operation: 'replace';
      path: string;
      replaceAll: boolean;
      matches: number;
      firstMatchLine: number | null;
      beforePreview: string;
      afterPreview: string;
    };

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  throw new Error(`Missing required string field: ${key}`);
}

function optionalBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
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

function truncateLiteral(text: string, maxChars = 280): string {
  if (text.length <= maxChars) {
    return text || '(empty)';
  }

  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function renderLiteralBlock(title: string, content: string): string {
  return [title, content || '(empty)'].join('\n');
}

export async function previewWritePatch(
  rootDir: string,
  args: Record<string, unknown>
): Promise<WritePatchPreview> {
  const operation = requireString(args, 'operation');
  const requestedPath = requireString(args, 'path');
  const absolutePath = resolvePathInsideRoot(rootDir, requestedPath);
  const relativePath = relativeToRoot(rootDir, absolutePath);

  if (operation === 'create') {
    const content = requireString(args, 'content');
    const overwrite = optionalBoolean(args, 'overwrite', false);

    return {
      operation: 'create',
      path: relativePath,
      overwrite,
      lineCount: content.split(/\r?\n/).length,
      charCount: content.length,
      contentPreview: truncateLiteral(content),
    };
  }

  if (operation === 'replace') {
    const find = requireString(args, 'find');
    const replace = typeof args.replace === 'string' ? args.replace : '';
    const replaceAll = optionalBoolean(args, 'replaceAll', false);

    if (!existsSync(absolutePath)) {
      throw new Error(`File does not exist: ${requestedPath}`);
    }

    const original = await readFile(absolutePath, 'utf8');
    const matches = countOccurrences(original, find);
    const firstMatchLine = lineNumberAtIndex(original, original.indexOf(find));

    return {
      operation: 'replace',
      path: relativePath,
      replaceAll,
      matches,
      firstMatchLine,
      beforePreview: truncateLiteral(find),
      afterPreview: truncateLiteral(replace),
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
      renderLiteralBlock('Content preview:', preview.contentPreview),
    ].join('\n');
  }

  return [
    `${mode === 'approval' ? 'Approve replace' : 'Updated'}: ${preview.path}`,
    `Matches: ${preview.matches}`,
    `Replace all: ${preview.replaceAll}`,
    `First match line: ${preview.firstMatchLine ?? 'not found'}`,
    renderLiteralBlock('Before:', preview.beforePreview),
    renderLiteralBlock('After:', preview.afterPreview),
  ].join('\n');
}
