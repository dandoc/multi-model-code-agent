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
  name?: string;
  version?: string;
  bin?: Record<string, string>;
}> {
  const raw = await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(raw) as {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
  };
}

async function runBuiltCli(
  distEntry: string,
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distEntry, ...args], {
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
  assert(typeof pkg.name === 'string' && pkg.name.length > 0, 'Expected package.json to define a package name.');
  assert(typeof pkg.version === 'string' && pkg.version.length > 0, 'Expected package.json to define a package version.');
  assert(binEntry === 'dist/index.js', `Expected bin.mm-agent to point to dist/index.js, got ${binEntry ?? '(missing)'}.`);

  const distEntry = path.resolve(process.cwd(), 'dist', 'index.js');
  assert(existsSync(distEntry), `Built CLI entrypoint is missing: ${distEntry}`);

  const builtSource = await readFile(distEntry, 'utf8');
  assert(
    builtSource.startsWith('#!/usr/bin/env node'),
    'Built dist/index.js is missing a node shebang for CLI execution.'
  );

  const result = await runBuiltCli(distEntry, ['--help']);
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

  const versionResult = await runBuiltCli(distEntry, ['--version']);
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  assert(versionResult.code === 0, `Built CLI --version should exit 0.\n\nOutput:\n${versionOutput}`);
  assert(
    versionOutput === `${pkg.name} ${pkg.version}`,
    `Built CLI --version did not print the expected package version.\n\nOutput:\n${versionOutput}`
  );

  const invalidWorkdir = path.resolve(process.cwd(), '.mm-agent-version-smoke-missing-workdir');
  assert(
    !existsSync(invalidWorkdir),
    `Version smoke expects a missing workdir path, but it already exists: ${invalidWorkdir}`
  );
  const versionWithInvalidWorkdir = await runBuiltCli(distEntry, ['--version', '--workdir', invalidWorkdir]);
  const versionWithInvalidWorkdirOutput =
    `${versionWithInvalidWorkdir.stdout}\n${versionWithInvalidWorkdir.stderr}`.trim();
  assert(
    versionWithInvalidWorkdir.code === 0,
    `Built CLI --version should ignore unrelated invalid runtime flags.\n\nOutput:\n${versionWithInvalidWorkdirOutput}`
  );
  assert(
    versionWithInvalidWorkdirOutput === `${pkg.name} ${pkg.version}`,
    `Built CLI --version should stay stable even with invalid runtime flags.\n\nOutput:\n${versionWithInvalidWorkdirOutput}`
  );

  console.log('[packaging-smoke] Built CLI packaging checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[packaging-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
