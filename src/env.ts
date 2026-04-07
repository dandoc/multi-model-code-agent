import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }

  return result;
}

function updateDotEnvContent(content: string, updates: Record<string, string>): string {
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return content;
  }

  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const remainingKeys = new Set(keys);

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return line;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) {
      return line;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!remainingKeys.has(key)) {
      return line;
    }

    remainingKeys.delete(key);
    return `${key}=${updates[key]}`;
  });

  for (const key of keys) {
    if (remainingKeys.has(key)) {
      updatedLines.push(`${key}=${updates[key]}`);
    }
  }

  return `${updatedLines.join('\n').replace(/\n+$/g, '')}\n`;
}

export function loadDotEnv(cwd: string): void {
  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const parsed = parseDotEnv(readFileSync(envPath, 'utf8'));

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export async function updateDotEnv(cwd: string, updates: Record<string, string>): Promise<void> {
  const envPath = join(cwd, '.env');
  const currentContent = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  const nextContent = updateDotEnvContent(currentContent, updates);
  await writeFile(envPath, nextContent, 'utf8');
}
