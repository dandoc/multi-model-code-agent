import { exec as execCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  isSearchableTextFile,
  relativeToRoot,
  resolvePathInsideRoot,
  shouldIgnoreDirectory,
  walkFiles,
} from './pathUtils.js';

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

function formatLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  const safeStart = Math.max(1, startLine);
  const safeEnd = Math.min(lines.length, endLine);

  return lines
    .slice(safeStart - 1, safeEnd)
    .map((line, index) => `${safeStart + index} | ${line}`)
    .join('\n');
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
  const selectedPaths = requestedPaths.slice(0, maxFiles);
  const chunks: string[] = [];
  const readPaths: string[] = [];

  for (const requestedPath of selectedPaths) {
    const absolutePath = resolvePathInsideRoot(context.config.workdir, requestedPath);
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

  return {
    ok: true,
    summary: `Read ${readPaths.length} file${readPaths.length === 1 ? '' : 's'}: ${readPaths.join(', ')}.`,
    output: chunks.join('\n\n'),
    metadata: {
      paths: readPaths,
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
  const operation = getString(args, 'operation', { required: true });
  const requestedPath = getString(args, 'path', { required: true });
  const absolutePath = resolvePathInsideRoot(context.config.workdir, requestedPath);

  if (operation === 'create') {
    const content = getString(args, 'content', { required: true });
    const overwrite = getBoolean(args, 'overwrite', false);

    if (existsSync(absolutePath) && !overwrite) {
      throw new Error(`File already exists: ${requestedPath}`);
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');

    return {
      ok: true,
      summary: `${overwrite ? 'Wrote' : 'Created'} ${relativeToRoot(context.config.workdir, absolutePath)}.`,
      output: truncate(content),
      metadata: {
        operation,
      },
    };
  }

  if (operation === 'replace') {
    const find = getString(args, 'find', { required: true });
    const replace = typeof args.replace === 'string' ? args.replace : '';
    const replaceAll = getBoolean(args, 'replaceAll', false);
    const original = await readFile(absolutePath, 'utf8');
    const matches = countOccurrences(original, find);

    if (matches === 0) {
      throw new Error(`Could not find the target string in ${requestedPath}`);
    }

    if (matches > 1 && !replaceAll) {
      throw new Error(
        `Found ${matches} matches in ${requestedPath}. Use replaceAll=true or provide a more specific find string.`
      );
    }

    const updated = replaceAll ? original.split(find).join(replace) : original.replace(find, replace);
    await writeFile(absolutePath, updated, 'utf8');

    return {
      ok: true,
      summary: `Updated ${relativeToRoot(context.config.workdir, absolutePath)} with ${matches} replacement${matches === 1 ? '' : 's'}.`,
      output: truncate(replace),
      metadata: {
        operation,
        matches,
      },
    };
  }

  throw new Error(`Unsupported write_patch operation: ${operation}`);
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
        '{ "paths": ["package.json", "README.md"], "startLine": 1, "maxLinesPerFile": 180, "maxFiles": 6 }',
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
      description: 'Create a file or replace exact text inside a file.',
      inputShape:
        '{ "operation": "replace", "path": "README.md", "find": "old", "replace": "new", "replaceAll": false } or { "operation": "create", "path": "notes.txt", "content": "hello", "overwrite": false }',
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
