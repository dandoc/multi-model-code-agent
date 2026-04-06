import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'build',
  'node_modules',
  '.idea',
  '.vscode',
]);

export function shouldIgnoreDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

function normalizeForComparison(input: string): string {
  return path.resolve(input).toLowerCase();
}

export function resolvePathInsideRoot(rootDir: string, requestedPath: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, requestedPath);
  const normalizedRoot = normalizeForComparison(root);
  const normalizedTarget = normalizeForComparison(target);
  const boundary = `${normalizedRoot}${path.sep}`;

  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(boundary)) {
    throw new Error(`Path escapes the configured workdir: ${requestedPath}`);
  }

  return target;
}

export function relativeToRoot(rootDir: string, absolutePath: string): string {
  const relativePath = path.relative(rootDir, absolutePath);
  return relativePath || '.';
}

export function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

export async function walkFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!shouldIgnoreDirectory(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

export async function isSearchableTextFile(filePath: string): Promise<boolean> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > 512_000) {
    return false;
  }

  const buffer = await readFile(filePath);
  return !isLikelyBinary(buffer);
}
