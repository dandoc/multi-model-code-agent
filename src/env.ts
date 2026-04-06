import { existsSync, readFileSync } from 'node:fs';
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
