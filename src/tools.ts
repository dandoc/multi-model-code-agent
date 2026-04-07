import { exec as execCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  isSearchableTextFile,
  relativeToRoot,
  resolvePathInsideRoot,
  shouldIgnoreDirectory,
  walkFiles,
} from './pathUtils.js';
import { analyzeConfig, analyzeEntrypoint, analyzeProject } from './repoAnalysis.js';
import {
  planWritePatch,
  renderWritePatchPreview,
} from './writePatchPreview.js';

import type { ToolContext, ToolDefinition, ToolExecutionResult } from './types.js';

const exec = promisify(execCallback);

function getString(
  args: Record<string, unknown>,
  key: string,
  options?: { required?: boolean }
): string {
  const value = args[key];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (options?.required) {
    throw new Error(`Missing required string field: ${key}`);
  }

  return '';
}

function getBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
}

function getStringArray(
  args: Record<string, unknown>,
  key: string,
  options?: { required?: boolean }
): string[] {
  const value = args[key];
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  if (items.length > 0) {
    return items;
  }

  if (options?.required) {
    throw new Error(`Missing required string array field: ${key}`);
  }

  return [];
}

function getNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function truncate(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function formatSection(title: string, items: string[], emptyMessage: string): string {
  return [title, ...(items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${emptyMessage}`])].join(
    '\n'
  );
}

function formatLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.min(lines.length, endLine);

  return lines
    .slice(safeStart - 1, safeEnd)
    .map((line, index) => `${safeStart + index} | ${line}`)
    .join('\n');
}

function getWritePatchPathHint(args: Record<string, unknown>): string | null {
  const candidates = ['path', 'filePath', 'file', 'target', 'filename'];

  for (const key of candidates) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function getWritePatchOperationHint(args: Record<string, unknown>): string | null {
  const value = args.operation;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeDisplayPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/');
}

function getWritePatchBatchItems(args: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ['edits', 'changes', 'operations']) {
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

function isBatchWritePatchRequest(args: Record<string, unknown>): boolean {
  return getWritePatchBatchItems(args).length > 0;
}

function buildWritePatchFailureResult(
  args: Record<string, unknown>,
  context: ToolContext,
  error: unknown
): ToolExecutionResult {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const requestedPath = getWritePatchPathHint(args);
  const requestedOperation = getWritePatchOperationHint(args);
  const summaryTarget = requestedPath ? ` for ${requestedPath}` : '';
  const suggestions: string[] = [];
  let reason = rawMessage;

  if (/Missing required string field: path/i.test(rawMessage)) {
    reason = 'The edit request did not include a target path.';
    suggestions.push('Provide a `path` inside the current workdir.');
  } else if (/Missing required string field: operation/i.test(rawMessage)) {
    reason = 'The edit request did not clearly specify whether it should create or replace text.';
    suggestions.push('Set `operation` to `create` or `replace`, or include the required create/replace fields.');
  } else if (/Missing required string field: content/i.test(rawMessage)) {
    reason = 'A create edit needs file content.';
    suggestions.push('Include a non-empty `content` field for create operations.');
  } else if (/Missing required string field: find/i.test(rawMessage)) {
    reason = 'A replace edit needs the exact text to find.';
    suggestions.push('Include the exact `find` string you want to replace.');
  } else if (/Path escapes the configured workdir:/i.test(rawMessage)) {
    reason = 'The requested path points outside the current workdir.';
    suggestions.push(`Use a path inside \`${context.config.workdir}\`.`);
  } else if (/File already exists:/i.test(rawMessage)) {
    reason = 'The target file already exists.';
    suggestions.push('Use `overwrite=true` if replacing the whole file is intentional.');
    suggestions.push('Otherwise choose a different path.');
  } else if (/File does not exist:/i.test(rawMessage)) {
    reason = 'The target file does not exist.';
    suggestions.push('Check the path for typos, or use a create edit first.');
  } else if (/Could not find the target string in /i.test(rawMessage)) {
    reason = 'The exact `find` string was not found in the target file.';
    suggestions.push('Read the file first and copy the exact text you want to replace.');
    suggestions.push('If whitespace or punctuation changed, make the `find` string more precise.');
  } else {
    const multiMatch = rawMessage.match(/Found (\d+) matches in (.+?)\. Use replaceAll=true/i);
    if (multiMatch) {
      reason = `The \`find\` string matched ${multiMatch[1]} locations in ${multiMatch[2]}.`;
      suggestions.push('Use `replaceAll=true` if you want to update every match.');
      suggestions.push('Otherwise narrow the `find` string so it matches only one location.');
    }
  }

  if (suggestions.length === 0) {
    suggestions.push('Review the requested path and edit arguments, then try again.');
  }

  return {
    ok: false,
    summary: `write_patch failed${summaryTarget}.`,
    output: [
      `Reason: ${reason}`,
      requestedOperation ? `Requested operation: ${requestedOperation}` : '',
      requestedPath ? `Requested path: ${requestedPath}` : '',
      `Workdir: ${context.config.workdir}`,
      'Suggested next steps:',
      ...suggestions.map((item) => `- ${item}`),
      rawMessage !== reason ? `Raw error: ${rawMessage}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    metadata: {
      requestedOperation,
      requestedPath,
      rawError: rawMessage,
    },
  };
}

function buildBatchWritePatchFailureResult(
  args: Record<string, unknown>,
  context: ToolContext,
  error: unknown,
  details: {
    totalEdits: number;
    failedEditIndex?: number;
    failedEdit?: Record<string, unknown>;
    validationFailedBeforeWrite?: boolean;
    failedPath?: string;
    rollbackRestoredCount?: number;
    rollbackFailedPaths?: string[];
  }
): ToolExecutionResult {
  const base = buildWritePatchFailureResult(details.failedEdit ?? {}, context, error);
  const rollbackFailedPaths = details.rollbackFailedPaths ?? [];
  const rollbackLine = details.validationFailedBeforeWrite
    ? 'Rollback: No files were written because the batch failed during preflight validation.'
    : [
        `Rollback: Restored ${details.rollbackRestoredCount ?? 0} file${
          details.rollbackRestoredCount === 1 ? '' : 's'
        }.`,
        rollbackFailedPaths.length > 0
          ? `Rollback still failed for ${rollbackFailedPaths.join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join(' ');

  return {
    ok: false,
    summary:
      details.failedEditIndex !== undefined
        ? `write_patch batch failed at edit ${details.failedEditIndex + 1} of ${details.totalEdits}.`
        : details.failedPath
          ? `write_patch batch failed while writing ${normalizeDisplayPath(details.failedPath)}.`
          : 'write_patch batch failed.',
    output: [
      `Batch edits: ${details.totalEdits}`,
      details.failedEditIndex !== undefined ? `Failed edit: ${details.failedEditIndex + 1}` : '',
      details.failedPath ? `Failed path: ${normalizeDisplayPath(details.failedPath)}` : '',
      rollbackLine,
      '',
      base.output,
    ]
      .filter(Boolean)
      .join('\n'),
    metadata: {
      ...(base.metadata ?? {}),
      batch: true,
      totalEdits: details.totalEdits,
      failedEditIndex: details.failedEditIndex,
      failedPath: details.failedPath ? normalizeDisplayPath(details.failedPath) : null,
      validationFailedBeforeWrite: details.validationFailedBeforeWrite ?? false,
      rollbackRestoredCount: details.rollbackRestoredCount ?? 0,
      rollbackFailedPaths,
    },
  };
}

async function buildTreeLines(
  rootDir: string,
  currentPath: string,
  depth: number,
  maxDepth: number,
  includeFiles: boolean,
  includeDirectories: boolean,
  maxEntries: number,
  lines: string[]
): Promise<void> {
  if (lines.length >= maxEntries) {
    return;
  }

  const entries = await readdir(currentPath, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() && !right.isDirectory()) {
      return -1;
    }
    if (!left.isDirectory() && right.isDirectory()) {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const entry of entries) {
    if (lines.length >= maxEntries) {
      return;
    }

    if (entry.isDirectory() && shouldIgnoreDirectory(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = relativeToRoot(rootDir, absolutePath);
    const indent = '  '.repeat(depth);

    if (entry.isDirectory()) {
      if (includeDirectories) {
        lines.push(`${indent}${entry.name}/`);
      }

      if (depth < maxDepth) {
        await buildTreeLines(
          rootDir,
          absolutePath,
          depth + 1,
          maxDepth,
          includeFiles,
          includeDirectories,
          maxEntries,
          lines
        );
      }

      continue;
    }

    if (includeFiles) {
      lines.push(`${indent}${entry.name}`);
    }

    if (relativePath === '.') {
      return;
    }
  }
}

async function runListFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const basePathInput = getString(args, 'path') || '.';
  const basePath = resolvePathInsideRoot(context.config.workdir, basePathInput);
  const maxDepth = Math.max(0, Math.min(6, Math.floor(getNumber(args, 'maxDepth', 2))));
  const maxEntries = Math.max(1, Math.min(400, Math.floor(getNumber(args, 'maxEntries', 120))));
  const includeFiles = getBoolean(args, 'includeFiles', true);
  const includeDirectories = getBoolean(args, 'includeDirectories', true);
  const lines: string[] = [`${relativeToRoot(context.config.workdir, basePath)}/`];

  await buildTreeLines(
    context.config.workdir,
    basePath,
    1,
    maxDepth,
    includeFiles,
    includeDirectories,
    maxEntries,
    lines
  );

  const capped = lines.length >= maxEntries;

  return {
    ok: true,
    summary: `Listed ${Math.max(0, lines.length - 1)} entries under ${relativeToRoot(context.config.workdir, basePath)} up to depth ${maxDepth}${capped ? ' (capped)' : ''}.`,
    output: lines.join('\n'),
    metadata: {
      path: relativeToRoot(context.config.workdir, basePath),
      maxDepth,
      maxEntries,
      capped,
    },
  };
}

async function runSummarizeProject(
  _args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const report = await analyzeProject(context.config.workdir);

  return {
    ok: true,
    summary: `Summarized the project structure for ${report.packageName ?? relativeToRoot(context.config.workdir, context.config.workdir)} using real workspace files.`,
    output: [
      report.packageName ? `PACKAGE NAME:\n- ${report.packageName}` : '',
      formatSection('TOP-LEVEL DIRECTORIES:', report.topLevelDirectories, 'No top-level directories found.'),
      formatSection('TOP-LEVEL FILES:', report.topLevelFiles, 'No top-level files found.'),
      formatSection('DETECTED STACK:', report.detectedStack, 'No obvious stack markers found.'),
      formatSection('KEY FILES:', report.keyFiles, 'No common key files were detected.'),
      formatSection(
        'ENTRYPOINT CANDIDATES:',
        report.entrypointCandidates.map((candidate) => `${candidate.path} (${candidate.reason})`),
        'No entrypoint candidates were detected.'
      ),
      formatSection(
        'RECOMMENDED NEXT FILES:',
        report.recommendedNextFiles,
        'No recommended next files were detected.'
      ),
    ]
      .filter(Boolean)
      .join('\n\n'),
    metadata: {
      packageName: report.packageName ?? null,
      topLevelDirectories: report.topLevelDirectories,
      topLevelFiles: report.topLevelFiles,
      detectedStack: report.detectedStack,
      keyFiles: report.keyFiles,
      entrypointCandidates: report.entrypointCandidates,
      recommendedNextFiles: report.recommendedNextFiles,
    },
  };
}

async function runFindEntrypoint(
  _args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const report = await analyzeEntrypoint(context.config.workdir);

  return {
    ok: true,
    summary: report.primaryEntrypoint
      ? `Identified ${report.primaryEntrypoint} as the most likely entrypoint.`
      : 'Did not find a clear entrypoint candidate.',
    output: [
      formatSection(
        'PRIMARY ENTRYPOINT:',
        report.primaryEntrypoint ? [report.primaryEntrypoint] : [],
        'No primary entrypoint was identified.'
      ),
      formatSection(
        'EVIDENCE:',
        report.evidence,
        'No package.json or common-path evidence was found.'
      ),
      formatSection(
        'SUPPORTING FILES:',
        report.supportingFiles,
        'No local supporting files were resolved from the entrypoint imports.'
      ),
      formatSection(
        'STARTUP FLOW:',
        report.startupFlow,
        'No startup flow could be derived.'
      ),
    ].join('\n\n'),
    metadata: {
      packageName: report.packageName ?? null,
      primaryEntrypoint: report.primaryEntrypoint,
      candidatePaths: report.candidatePaths,
      supportingFiles: report.supportingFiles,
      startupFlow: report.startupFlow,
      flowSignals: report.flowSignals,
      evidence: report.evidence,
    },
  };
}

async function runSummarizeConfig(
  _args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const report = await analyzeConfig(context.config.workdir);

  return {
    ok: true,
    summary: `Summarized configuration sources from ${report.configFiles.length} file${report.configFiles.length === 1 ? '' : 's'}.`,
    output: [
      formatSection('CONFIG FILES:', report.configFiles, 'No configuration-related files were detected.'),
      formatSection('ENV VARIABLES:', report.envVariables, 'No environment variables were detected.'),
      formatSection('CLI FLAGS:', report.cliFlags, 'No CLI flags were detected.'),
      formatSection('CONFIG FLOW:', report.configFlow, 'No config flow could be derived.'),
    ].join('\n\n'),
    metadata: {
      configFiles: report.configFiles,
      envVariables: report.envVariables,
      cliFlags: report.cliFlags,
      configFlow: report.configFlow,
    },
  };
}

async function runReadFile(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const requestedPath = getString(args, 'path', { required: true });
  const absolutePath = resolvePathInsideRoot(context.config.workdir, requestedPath);
  const raw = await readFile(absolutePath, 'utf8');
  const totalLines = raw.split(/\r?\n/).length;
  const startLine = Math.max(1, Math.floor(getNumber(args, 'startLine', 1)));
  const endLine = Math.max(
    startLine,
    Math.floor(getNumber(args, 'endLine', Math.min(totalLines, startLine + 199)))
  );

  return {
    ok: true,
    summary: `Read ${relativeToRoot(context.config.workdir, absolutePath)} lines ${startLine}-${Math.min(endLine, totalLines)}.`,
    output: formatLines(raw, startLine, Math.min(endLine, totalLines)),
    metadata: {
      path: relativeToRoot(context.config.workdir, absolutePath),
      totalLines,
    },
  };
}

async function runReadMultipleFiles(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const requestedPaths = getStringArray(args, 'paths', { required: true });
  const maxFiles = Math.max(1, Math.min(12, Math.floor(getNumber(args, 'maxFiles', 6))));
  const startLine = Math.max(1, Math.floor(getNumber(args, 'startLine', 1)));
  const maxLinesPerFile = Math.max(
    20,
    Math.min(400, Math.floor(getNumber(args, 'maxLinesPerFile', 180)))
  );
  const skipMissing = getBoolean(args, 'skipMissing', false);
  const selectedPaths = requestedPaths.slice(0, maxFiles);
  const chunks: string[] = [];
  const readPaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const requestedPath of selectedPaths) {
    const absolutePath = resolvePathInsideRoot(context.config.workdir, requestedPath);
    if (!existsSync(absolutePath)) {
      if (skipMissing) {
        skippedPaths.push(requestedPath);
        continue;
      }
      throw new Error(`File does not exist: ${requestedPath}`);
    }

    const raw = await readFile(absolutePath, 'utf8');
    const totalLines = raw.split(/\r?\n/).length;
    const endLine = Math.min(totalLines, startLine + maxLinesPerFile - 1);

    readPaths.push(relativeToRoot(context.config.workdir, absolutePath));
    chunks.push(
      [
        `=== FILE: ${relativeToRoot(context.config.workdir, absolutePath)} ===`,
        formatLines(raw, startLine, endLine),
      ].join('\n')
    );
  }

  if (readPaths.length === 0) {
    throw new Error(
      skipMissing
        ? `None of the requested files exist in the workdir: ${requestedPaths.join(', ')}`
        : 'No readable files were selected.'
    );
  }

  return {
    ok: true,
    summary: `Read ${readPaths.length} file${readPaths.length === 1 ? '' : 's'}: ${readPaths.join(', ')}.`,
    output: chunks.join('\n\n'),
    metadata: {
      paths: readPaths,
      skippedPaths,
      startLine,
      maxLinesPerFile,
      truncatedFileCount:
        requestedPaths.length > selectedPaths.length ? requestedPaths.length - selectedPaths.length : 0,
    },
  };
}

async function runSearchFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const pattern = getString(args, 'pattern', { required: true });
  const basePathInput = getString(args, 'path') || '.';
  const basePath = resolvePathInsideRoot(context.config.workdir, basePathInput);
  const caseSensitive = getBoolean(args, 'caseSensitive', false);
  const useRegex = getBoolean(args, 'regex', false);
  const maxResults = Math.max(1, Math.min(100, Math.floor(getNumber(args, 'maxResults', 30))));
  const fileExtensions = Array.isArray(args.fileExtensions)
    ? args.fileExtensions.filter((value): value is string => typeof value === 'string')
    : [];

  const files = await walkFiles(basePath);
  const results: string[] = [];
  const flags = caseSensitive ? 'g' : 'gi';
  const matcher = useRegex ? new RegExp(pattern, flags) : null;
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const alternates =
    !useRegex && pattern.includes('|')
      ? pattern
          .split('|')
          .map((part) => (caseSensitive ? part.trim() : part.trim().toLowerCase()))
          .filter((part) => part.length > 0)
      : [];

  for (const filePath of files) {
    if (fileExtensions.length > 0 && !fileExtensions.includes(path.extname(filePath))) {
      continue;
    }

    if (!(await isSearchableTextFile(filePath))) {
      continue;
    }

    const content = await readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const haystack = caseSensitive ? line : line.toLowerCase();
      const matched = matcher
        ? matcher.test(line)
        : alternates.length > 0
          ? alternates.some((alternate) => haystack.includes(alternate))
          : haystack.includes(needle);

      if (!matched) {
        if (matcher) {
          matcher.lastIndex = 0;
        }
        continue;
      }

      results.push(`${relativeToRoot(context.config.workdir, filePath)}:${lineIndex + 1} | ${line}`);
      if (matcher) {
        matcher.lastIndex = 0;
      }

      if (results.length >= maxResults) {
        return {
          ok: true,
          summary: `Found ${results.length} matches for "${pattern}" (capped at ${maxResults}).`,
          output: results.join('\n'),
          metadata: {
            basePath: relativeToRoot(context.config.workdir, basePath),
            capped: true,
          },
        };
      }
    }
  }

  return {
    ok: true,
    summary: `Found ${results.length} matches for "${pattern}".`,
    output: results.length > 0 ? results.join('\n') : 'No matches found.',
    metadata: {
      basePath: relativeToRoot(context.config.workdir, basePath),
      capped: false,
    },
  };
}

async function runWritePatch(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  try {
    const plan = await planWritePatch(context.config.workdir, args);
    const writtenPaths: typeof plan.writes = [];

    try {
      for (const write of plan.writes) {
        try {
          await mkdir(path.dirname(write.absolutePath), { recursive: true });
          await writeFile(write.absolutePath, write.finalContent, 'utf8');
          writtenPaths.push(write);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${write.path}: ${message}`);
        }
      }

      if (plan.edits.length === 1) {
        const normalized = plan.edits[0];
        const preview = plan.previews[0];
        const resultPath = plan.writes[0]?.path ?? normalized.path;

        if (normalized.operation === 'create') {
          return {
            ok: true,
            summary: `${normalized.overwrite ? 'Wrote' : 'Created'} ${resultPath}.`,
            output: renderWritePatchPreview(preview, 'result'),
            metadata: {
              operation: normalized.operation,
              path: resultPath,
              overwrite: normalized.overwrite,
              lineCount: preview.operation === 'create' ? preview.lineCount : undefined,
            },
          };
        }

        return {
          ok: true,
          summary: `Updated ${resultPath} with ${preview.operation === 'replace' ? preview.matches : 0} replacement${
            preview.operation === 'replace' && preview.matches === 1 ? '' : 's'
          }.`,
          output: renderWritePatchPreview(preview, 'result'),
          metadata: {
            operation: normalized.operation,
            path: resultPath,
            matches: preview.operation === 'replace' ? preview.matches : undefined,
            replaceAll: normalized.replaceAll,
            firstMatchLine: preview.operation === 'replace' ? preview.firstMatchLine : undefined,
          },
        };
      }

      return {
        ok: true,
        summary: `Applied batch write_patch with ${plan.edits.length} edits across ${plan.writes.length} file${
          plan.writes.length === 1 ? '' : 's'
        }.`,
        output: renderWritePatchPreview(
          {
            operation: 'batch',
            editCount: plan.edits.length,
            fileCount: plan.writes.length,
            rollbackOnFailure: plan.rollbackOnFailure,
            changedPaths: plan.writes.map((write) => write.path),
            previews: plan.previews,
          },
          'result'
        ),
        metadata: {
          operation: 'batch',
          editCount: plan.edits.length,
          fileCount: plan.writes.length,
          paths: plan.writes.map((write) => write.path),
          rollbackOnFailure: plan.rollbackOnFailure,
        },
      };
    } catch (commitError) {
      const message = commitError instanceof Error ? commitError.message : String(commitError);
      const failedPathMatch = message.match(/^(.*?): /);
      const failedPath = failedPathMatch?.[1] ?? null;
      const rollbackRestoredPaths: string[] = [];
      const rollbackFailedPaths: string[] = [];

      if (plan.rollbackOnFailure) {
        for (const write of [...writtenPaths].reverse()) {
          if (!existsSync(write.absolutePath) && !write.originalExists) {
            continue;
          }

          try {
            if (write.originalExists) {
              await writeFile(write.absolutePath, write.originalContent ?? '', 'utf8');
            } else {
              await rm(write.absolutePath, { force: true });
            }
            rollbackRestoredPaths.push(write.path);
          } catch {
            rollbackFailedPaths.push(write.path);
          }
        }
      }

      return buildBatchWritePatchFailureResult(args, context, commitError, {
        totalEdits: plan.edits.length,
        failedPath: failedPath ?? undefined,
        rollbackRestoredCount: rollbackRestoredPaths.length,
        rollbackFailedPaths,
      });
    }
  } catch (error) {
    if (isBatchWritePatchRequest(args)) {
      const batchItems = getWritePatchBatchItems(args);
      const batchError = error as Error & {
        writePatchBatchEditIndex?: number;
        writePatchBatchEdit?: Record<string, unknown>;
        writePatchBatchTotalEdits?: number;
      };

      return buildBatchWritePatchFailureResult(args, context, error, {
        totalEdits: batchError.writePatchBatchTotalEdits ?? batchItems.length,
        failedEditIndex: batchError.writePatchBatchEditIndex,
        failedEdit: batchError.writePatchBatchEdit,
        validationFailedBeforeWrite: true,
      });
    }

    return buildWritePatchFailureResult(args, context, error);
  }
}

async function runShell(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const command = getString(args, 'command', { required: true });
  const timeoutMs = Math.max(1_000, Math.min(120_000, Math.floor(getNumber(args, 'timeoutMs', 30_000))));

  try {
    const { stdout, stderr } = await exec(command, {
      cwd: context.config.workdir,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });

    const output = [`STDOUT:\n${stdout || '(empty)'}`, `STDERR:\n${stderr || '(empty)'}`].join('\n\n');

    return {
      ok: true,
      summary: `Command completed successfully: ${command}`,
      output: truncate(output),
      metadata: {
        command,
        timeoutMs,
      },
    };
  } catch (error) {
    const shellError = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message: string;
    };

    const output = [
      `ERROR: ${shellError.message}`,
      `EXIT CODE: ${String(shellError.code ?? 'unknown')}`,
      `STDOUT:\n${shellError.stdout || '(empty)'}`,
      `STDERR:\n${shellError.stderr || '(empty)'}`,
    ].join('\n\n');

    return {
      ok: false,
      summary: `Command failed: ${command}`,
      output: truncate(output),
      metadata: {
        command,
        timeoutMs,
      },
    };
  }
}

export function createTools(): ToolDefinition[] {
  return [
    {
      name: 'summarize_project',
      description:
        'Generate a deterministic project summary from the real workspace structure and common key files.',
      inputShape: '{}',
      requiresApproval: false,
      run: runSummarizeProject,
    },
    {
      name: 'find_entrypoint',
      description:
        'Find the most likely project entrypoint using package.json, common entry files, and local imports.',
      inputShape: '{}',
      requiresApproval: false,
      run: runFindEntrypoint,
    },
    {
      name: 'summarize_config',
      description:
        'Summarize configuration files, environment variables, CLI flags, and config flow from the workspace.',
      inputShape: '{}',
      requiresApproval: false,
      run: runSummarizeConfig,
    },
    {
      name: 'list_files',
      description:
        'List directories and files as a small tree. Use this first when the user asks about project structure.',
      inputShape:
        '{ "path": ".", "maxDepth": 2, "maxEntries": 120, "includeFiles": true, "includeDirectories": true }',
      requiresApproval: false,
      run: runListFiles,
    },
    {
      name: 'read_file',
      description: 'Read a text file from the current workdir. Supports line ranges.',
      inputShape: '{ "path": "src/index.ts", "startLine": 1, "endLine": 200 }',
      requiresApproval: false,
      run: runReadFile,
    },
    {
      name: 'read_multiple_files',
      description:
        'Read several text files in one tool call. Use this after list_files or search_files when you need evidence from multiple files.',
      inputShape:
        '{ "paths": ["package.json", "README.md"], "startLine": 1, "maxLinesPerFile": 180, "maxFiles": 6, "skipMissing": false }',
      requiresApproval: false,
      run: runReadMultipleFiles,
    },
    {
      name: 'search_files',
      description: 'Recursively search text files for a plain string or regex pattern.',
      inputShape:
        '{ "pattern": "createServer", "path": ".", "regex": false, "caseSensitive": false, "maxResults": 30 }',
      requiresApproval: false,
      run: runSearchFiles,
    },
    {
      name: 'write_patch',
      description:
        'Create files or replace exact text inside files. Supports batched edits with rollback on failure.',
      inputShape:
        '{ "operation": "replace", "path": "README.md", "find": "old", "replace": "new", "replaceAll": false } or { "operation": "create", "path": "notes.txt", "content": "hello", "overwrite": false } or { "edits": [{ "operation": "replace", "path": "README.md", "find": "old", "replace": "new" }, { "operation": "create", "path": "notes.txt", "content": "hello" }], "rollbackOnFailure": true }',
      requiresApproval: true,
      run: runWritePatch,
    },
    {
      name: 'run_shell',
      description: 'Run a shell command in the configured workdir.',
      inputShape: '{ "command": "npm test", "timeoutMs": 30000 }',
      requiresApproval: true,
      run: runShell,
    },
  ];
}

export function renderToolCatalog(tools: ToolDefinition[]): string {
  return tools
    .map(
      (tool) =>
        `- ${tool.name}\n  description: ${tool.description}\n  input: ${tool.inputShape}\n  approvalRequired: ${tool.requiresApproval}`
    )
    .join('\n');
}
