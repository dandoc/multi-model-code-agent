import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { relativeToRoot, resolvePathInsideRoot } from './pathUtils.js';

export type NormalizedWritePatchEdit =
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
    };

type SingleWritePatchPreview =
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

export type WritePatchPreview =
  | SingleWritePatchPreview
  | {
      operation: 'batch';
      editCount: number;
      fileCount: number;
      rollbackOnFailure: boolean;
      changedPaths: string[];
      previews: SingleWritePatchPreview[];
    };

export type WritePatchPlan = {
  edits: NormalizedWritePatchEdit[];
  previews: SingleWritePatchPreview[];
  writes: Array<{
    path: string;
    absolutePath: string;
    finalContent: string;
    originalExists: boolean;
    originalContent: string | null;
  }>;
  rollbackOnFailure: boolean;
};

function optionalBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
}

function findStringAlias(
  args: Record<string, unknown>,
  keys: string[]
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string') {
      return { key, value };
    }
  }

  return null;
}

function getStringFromAliases(args: Record<string, unknown>, keys: string[]): string {
  const match = findStringAlias(args, keys);
  return match && match.value.length > 0 ? match.value : '';
}

function requireStringFromAliases(
  args: Record<string, unknown>,
  keys: string[],
  label: string,
  options?: { allowEmpty?: boolean }
): string {
  const match = findStringAlias(args, keys);
  if (match && (options?.allowEmpty || match.value.length > 0)) {
    return match.value;
  }

  throw new Error(`Missing required string field: ${label}`);
}

function getObjectArrayFromAliases(args: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = args[key];
    if (!Array.isArray(value)) {
      continue;
    }

    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
    );
  }

  return [];
}

function hasArrayAlias(args: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Array.isArray(args[key]));
}

function inferOperation(args: Record<string, unknown>): 'create' | 'replace' {
  const explicit = getStringFromAliases(args, ['operation']).toLowerCase();
  if (explicit === 'create' || explicit === 'replace') {
    return explicit;
  }

  const hasFind = getStringFromAliases(args, ['find', 'search', 'oldText', 'old', 'needle']).length > 0;
  const hasContent = findStringAlias(args, ['content', 'contents', 'text', 'value', 'body']) !== null;

  if (hasFind) {
    return 'replace';
  }
  if (hasContent) {
    return 'create';
  }

  throw new Error('Missing required string field: operation');
}

export function normalizeWritePatchArgs(args: Record<string, unknown>): NormalizedWritePatchEdit {
  const operation = inferOperation(args);
  const path = requireStringFromAliases(args, ['path', 'filePath', 'file', 'target', 'filename'], 'path');

  if (operation === 'create') {
    return {
      operation,
      path,
      content: requireStringFromAliases(
        args,
        ['content', 'contents', 'text', 'value', 'body'],
        'content',
        { allowEmpty: true }
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

export function normalizeWritePatchBatchArgs(args: Record<string, unknown>): {
  edits: NormalizedWritePatchEdit[];
  rollbackOnFailure: boolean;
} {
  const editAliases = ['edits', 'changes', 'operations'];
  const rawEdits = getObjectArrayFromAliases(args, editAliases);

  if (rawEdits.length > 0) {
    return {
      edits: rawEdits.map((edit) => normalizeWritePatchArgs(edit)),
      rollbackOnFailure: optionalBoolean(args, 'rollbackOnFailure', true),
    };
  }

  if (hasArrayAlias(args, editAliases)) {
    throw new Error('Missing required object array field: edits');
  }

  return {
    edits: [normalizeWritePatchArgs(args)],
    rollbackOnFailure: true,
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

function displayPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/');
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function buildCreateDiffPreview(content: string): string {
  if (content.length === 0) {
    return ['@@ create @@', '+ (empty file)'].join('\n');
  }

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

function buildCreatePreview(path: string, content: string, overwrite: boolean): SingleWritePatchPreview {
  return {
    operation: 'create',
    path,
    overwrite,
    lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    charCount: content.length,
    diffPreview: buildCreateDiffPreview(content),
  };
}

function buildReplacePreview(
  path: string,
  original: string,
  find: string,
  replace: string,
  replaceAll: boolean
): { preview: SingleWritePatchPreview; updated: string } {
  const matches = countOccurrences(original, find);
  const firstMatchIndex = original.indexOf(find);
  const firstMatchLine = lineNumberAtIndex(original, firstMatchIndex);
  const lastPreviewIndex = firstMatchIndex + Math.max(0, find.length - 1);
  const lastMatchLine = lineNumberAtIndex(original, lastPreviewIndex);
  const updated = replaceAll ? original.split(find).join(replace) : original.replace(find, replace);

  return {
    updated,
    preview: {
      operation: 'replace',
      path,
      replaceAll,
      matches,
      firstMatchLine,
      previewNote:
        replaceAll && matches > 1 ? `Preview shows the first of ${matches} matched locations.` : undefined,
      diffPreview: buildReplaceDiffPreview(original, updated, firstMatchLine, lastMatchLine),
    },
  };
}

function createBatchPlanningError(
  message: string,
  editIndex: number,
  edit: NormalizedWritePatchEdit,
  totalEdits: number
): Error {
  const error = new Error(message) as Error & {
    writePatchBatchEditIndex?: number;
    writePatchBatchEdit?: NormalizedWritePatchEdit;
    writePatchBatchTotalEdits?: number;
  };
  error.writePatchBatchEditIndex = editIndex;
  error.writePatchBatchEdit = edit;
  error.writePatchBatchTotalEdits = totalEdits;
  return error;
}

export async function planWritePatch(rootDir: string, args: Record<string, unknown>): Promise<WritePatchPlan> {
  const { edits, rollbackOnFailure } = normalizeWritePatchBatchArgs(args);
  const state = new Map<string, { exists: boolean; content: string; path: string }>();
  const touchedPaths: string[] = [];
  const touchedSet = new Set<string>();
  const previews: SingleWritePatchPreview[] = [];

  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];

    try {
      const absolutePath = resolvePathInsideRoot(rootDir, edit.path);
      const relativePath = relativeToRoot(rootDir, absolutePath);

      if (!state.has(absolutePath)) {
        if (existsSync(absolutePath)) {
          state.set(absolutePath, {
            exists: true,
            content: await readFile(absolutePath, 'utf8'),
            path: relativePath,
          });
        } else {
          state.set(absolutePath, {
            exists: false,
            content: '',
            path: relativePath,
          });
        }
      }

      const current = state.get(absolutePath);
      if (!current) {
        throw new Error(`Could not resolve state for ${edit.path}`);
      }

      if (!touchedSet.has(absolutePath)) {
        touchedSet.add(absolutePath);
        touchedPaths.push(absolutePath);
      }

      if (edit.operation === 'create') {
        if (current.exists && !edit.overwrite) {
          throw new Error(`File already exists: ${edit.path}`);
        }

        previews.push(buildCreatePreview(relativePath, edit.content, edit.overwrite));
        state.set(absolutePath, {
          exists: true,
          content: edit.content,
          path: relativePath,
        });
        continue;
      }

      if (!current.exists) {
        throw new Error(`File does not exist: ${edit.path}`);
      }

      const matches = countOccurrences(current.content, edit.find);
      if (matches === 0) {
        throw new Error(`Could not find the target string in ${edit.path}`);
      }

      if (matches > 1 && !edit.replaceAll) {
        throw new Error(
          `Found ${matches} matches in ${edit.path}. Use replaceAll=true or provide a more specific find string.`
        );
      }

      const { preview, updated } = buildReplacePreview(
        relativePath,
        current.content,
        edit.find,
        edit.replace,
        edit.replaceAll
      );
      previews.push(preview);
      state.set(absolutePath, {
        exists: true,
        content: updated,
        path: relativePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw createBatchPlanningError(message, index, edit, edits.length);
    }
  }

  const writes: WritePatchPlan['writes'] = touchedPaths.map((absolutePath) => {
    const current = state.get(absolutePath);
    if (!current) {
      throw new Error(`Missing planned state for ${absolutePath}`);
    }

    const originalExists = existsSync(absolutePath);

    return {
      path: current.path,
      absolutePath,
      finalContent: current.content,
      originalExists,
      originalContent: null,
    };
  });

  for (const write of writes) {
    if (write.originalExists) {
      write.originalContent = await readFile(write.absolutePath, 'utf8');
    }
  }

  return {
    edits,
    previews,
    writes,
    rollbackOnFailure,
  };
}

export async function previewWritePatch(
  rootDir: string,
  args: Record<string, unknown>
): Promise<WritePatchPreview> {
  const plan = await planWritePatch(rootDir, args);

  if (plan.previews.length === 1) {
    return plan.previews[0];
  }

  return {
    operation: 'batch',
    editCount: plan.edits.length,
    fileCount: plan.writes.length,
    rollbackOnFailure: plan.rollbackOnFailure,
    changedPaths: plan.writes.map((write) => write.path),
    previews: plan.previews,
  };
}

export function renderWritePatchPreview(
  preview: WritePatchPreview,
  mode: 'approval' | 'result'
): string {
  if (preview.operation === 'batch') {
    return [
      `${mode === 'approval' ? 'Approve batch write_patch' : 'Applied batch write_patch'}: ${preview.editCount} edit${preview.editCount === 1 ? '' : 's'} across ${preview.fileCount} file${preview.fileCount === 1 ? '' : 's'}.`,
      `Rollback on failure: ${preview.rollbackOnFailure}`,
      `Changed files: ${preview.changedPaths.map((item) => displayPath(item)).join(', ')}`,
      ...preview.previews.flatMap((item, index) => [
        '',
        `Edit ${index + 1}:`,
        indentBlock(renderWritePatchPreview(item, mode)),
      ]),
    ].join('\n');
  }

  if (preview.operation === 'create') {
    return [
      `${mode === 'approval' ? 'Approve create' : 'Created'}: ${displayPath(preview.path)}`,
      `Overwrite: ${preview.overwrite}`,
      `Content lines: ${preview.lineCount}`,
      `Content chars: ${preview.charCount}`,
      renderLiteralBlock('Diff preview:', preview.diffPreview),
    ].join('\n');
  }

  return [
    `${mode === 'approval' ? 'Approve replace' : 'Updated'}: ${displayPath(preview.path)}`,
    `Matches: ${preview.matches}`,
    `Replace all: ${preview.replaceAll}`,
    `First match line: ${preview.firstMatchLine ?? 'not found'}`,
    preview.previewNote ? `Preview note: ${preview.previewNote}` : '',
    renderLiteralBlock('Diff preview:', preview.diffPreview),
  ]
    .filter(Boolean)
    .join('\n');
}
