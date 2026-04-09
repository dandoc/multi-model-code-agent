import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function readPackageJson(): Promise<{
  bin?: Record<string, string>;
}> {
  const raw = await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(raw) as { bin?: Record<string, string> };
}

async function runBuiltHelp(distEntry: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distEntry, '--help'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const pkg = await readPackageJson();
  const binEntry = pkg.bin?.['mm-agent'];
  assert(binEntry === 'dist/index.js', `Expected bin.mm-agent to point to dist/index.js, got ${binEntry ?? '(missing)'}.`);

  const distEntry = path.resolve(process.cwd(), 'dist', 'index.js');
  assert(existsSync(distEntry), `Built CLI entrypoint is missing: ${distEntry}`);

  const builtSource = await readFile(distEntry, 'utf8');
  assert(
    builtSource.startsWith('#!/usr/bin/env node'),
    'Built dist/index.js is missing a node shebang for CLI execution.'
  );

  const result = await runBuiltHelp(distEntry);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert(result.code === 0, `Built CLI --help should exit 0.\n\nOutput:\n${combined}`);
  assert(
    combined.includes('Multi Model Code Agent'),
    `Built CLI --help did not print the expected banner.\n\nOutput:\n${combined}`
  );
  assert(
    combined.includes('--provider'),
    `Built CLI --help did not print the expected flag list.\n\nOutput:\n${combined}`
  );

  console.log('[packaging-smoke] Built CLI packaging checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[packaging-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
