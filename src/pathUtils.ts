import { existsSync, realpathSync } from 'node:fs';
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
  const normalized = path.resolve(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathInsideRoot(rootDir: string, targetPath: string): boolean {
  const normalizedRoot = normalizeForComparison(rootDir);
  const normalizedTarget = normalizeForComparison(targetPath);
  const boundary = `${normalizedRoot}${path.sep}`;

  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(boundary);
}

function getNearestExistingPath(targetPath: string): string {
  let current = path.resolve(targetPath);

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not resolve an existing ancestor for path: ${targetPath}`);
    }
    current = parent;
  }

  return current;
}

function getCanonicalTargetPath(targetPath: string): string {
  const nearestExistingPath = getNearestExistingPath(targetPath);
  const nearestExistingRealPath = realpathSync(nearestExistingPath);
  const missingSuffix = path.relative(nearestExistingPath, targetPath);

  if (!missingSuffix) {
    return nearestExistingRealPath;
  }

  return path.resolve(nearestExistingRealPath, missingSuffix);
}

export function resolvePathInsideRoot(rootDir: string, requestedPath: string): string {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, requestedPath);
  const canonicalRoot = realpathSync(root);
  const canonicalTarget = getCanonicalTargetPath(target);

  if (!isPathInsideRoot(canonicalRoot, canonicalTarget)) {
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
  const queue: string[] = [resolvePathInsideRoot(rootDir, '.')];
  const visitedDirectories = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    const canonicalCurrent = realpathSync(current);
    if (visitedDirectories.has(normalizeForComparison(canonicalCurrent))) {
      continue;
    }
    visitedDirectories.add(normalizeForComparison(canonicalCurrent));

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = path.join(current, entry.name);
      let absolutePath: string;

      try {
        absolutePath = resolvePathInsideRoot(rootDir, candidatePath);
      } catch {
        continue;
      }

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
