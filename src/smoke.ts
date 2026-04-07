import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { AgentRunner } from './agent.js';
import { createConfigFromInputs } from './config.js';
import { loadDotEnv } from './env.js';
import { createModelAdapter } from './modelAdapters.js';
import { createTools } from './tools.js';

import type { AgentConfig } from './types.js';

const exec = promisify(execCallback);

type SmokeCase = {
  name: string;
  prompt: string;
  expectedSnippets: string[];
};

function getNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const renderedCommand = [command, ...args].join(' ');
  const { stdout, stderr } = await exec(renderedCommand, {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 4,
    timeout: 240_000,
  });

  if (stdout.trim()) {
    console.log(stdout.trim());
  }
  if (stderr.trim()) {
    console.log(stderr.trim());
  }
}

function buildSmokeConfig(): AgentConfig {
  loadDotEnv(process.cwd());
  const parsed = createConfigFromInputs([]);

  return {
    ...parsed.config,
    workdir: process.cwd(),
    autoApprove: false,
  };
}

function createSilentUi() {
  return {
    confirm: async (): Promise<boolean> => false,
    log: (message: string): void => {
      console.log(`[smoke-agent] ${message}`);
    },
  };
}

function assertIncludesAll(output: string, expectedSnippets: string[], caseName: string): void {
  const missing = expectedSnippets.filter((snippet) => !output.includes(snippet));
  if (missing.length > 0) {
    throw new Error(
      `${caseName} failed. Missing expected snippets: ${missing.join(', ')}\n\nActual output:\n${output}`
    );
  }
}

async function runPromptSmokeTest(config: AgentConfig, testCase: SmokeCase): Promise<void> {
  const tools = createTools();
  const adapter = createModelAdapter(config);
  const agent = new AgentRunner(config, adapter, tools, createSilentUi());

  console.log(`\n[smoke] ${testCase.name}`);
  console.log(`[smoke] prompt: ${testCase.prompt}`);
  const reply = await agent.runTurn(testCase.prompt);
  console.log(`[smoke] reply:\n${reply}\n`);

  assertIncludesAll(reply, testCase.expectedSnippets, testCase.name);
}

async function runWorkspaceCreateSmokeTest(config: AgentConfig): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mmca-smoke-'));
  const workspaceName = path.basename(tempRoot);
  const targetDir = path.join(tempRoot, 'smoke-output');
  const targetFile = path.join(targetDir, 'hello.txt');
  const prompt = `${workspaceName} dir 안에 smoke-output 폴더를 만들고 hello.txt 파일을 만들어서 Hello Smoke!를 써줘`;
  const tools = createTools();
  const adapter = createModelAdapter({
    ...config,
    workdir: tempRoot,
    autoApprove: true,
  });
  const agent = new AgentRunner(
    {
      ...config,
      workdir: tempRoot,
      autoApprove: true,
    },
    adapter,
    tools,
    createSilentUi()
  );

  try {
    console.log(`\n[smoke] Workspace-local file creation`);
    console.log(`[smoke] prompt: ${prompt}`);
    const reply = await agent.runTurn(prompt);
    console.log(`[smoke] reply:\n${reply}\n`);

    if (!existsSync(targetFile)) {
      throw new Error(`Workspace-local file creation failed. Missing file: ${targetFile}`);
    }

    const content = await readFile(targetFile, 'utf8');
    if (!content.includes('Hello Smoke!')) {
      throw new Error(
        `Workspace-local file creation failed. Unexpected content in ${targetFile}: ${content}`
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const npm = getNpmCommand();
  const config = buildSmokeConfig();

  console.log('[smoke] Running typecheck...');
  await runCommand(npm, ['run', 'typecheck']);

  console.log('\n[smoke] Running build...');
  await runCommand(npm, ['run', 'build']);

  const cases: SmokeCase[] = [
    {
      name: 'Project structure summary',
      prompt: '이 프로젝트 구조를 한국어로 요약해줘',
      expectedSnippets: ['package.json', 'README.md', 'src/index.ts'],
    },
    {
      name: 'Entrypoint flow summary',
      prompt: '이 프로젝트의 메인 진입점과 실행 흐름을 한국어로 설명해줘',
      expectedSnippets: ['src/index.ts', 'src/env.ts', 'src/config.ts'],
    },
    {
      name: 'Config summary',
      prompt: '이 프로젝트 설정이 어디서 정의되고 어떻게 적용되는지 한국어로 설명해줘',
      expectedSnippets: ['.env.example', 'src/config.ts', 'src/index.ts'],
    },
  ];

  console.log(
    `\n[smoke] Using provider=${config.provider}, model=${config.model}, workdir=${config.workdir}`
  );

  for (const testCase of cases) {
    await runPromptSmokeTest(config, testCase);
  }

  await runWorkspaceCreateSmokeTest(config);

  console.log('\n[smoke] All smoke checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[smoke] Failed: ${message}`);
  process.exitCode = 1;
});
