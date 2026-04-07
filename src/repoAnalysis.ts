import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { relativeToRoot, resolvePathInsideRoot, shouldIgnoreDirectory } from './pathUtils.js';

type PackageJson = {
  name?: string;
  type?: string;
  main?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
};

type EntrypointCandidate = {
  path: string;
  reason: string;
  score: number;
};

export interface ProjectSummaryReport {
  packageName?: string;
  topLevelDirectories: string[];
  topLevelFiles: string[];
  detectedStack: string[];
  keyFiles: string[];
  entrypointCandidates: Array<{ path: string; reason: string }>;
  recommendedNextFiles: string[];
}

export interface EntrypointReport {
  packageName?: string;
  primaryEntrypoint: string | null;
  candidatePaths: Array<{ path: string; reason: string }>;
  supportingFiles: string[];
  startupFlow: string[];
  flowSignals: EntrypointFlowSignals;
  evidence: string[];
}

export interface EntrypointFlowSignals {
  loadsDotEnv: boolean;
  buildsConfig: boolean;
  handlesHelp: boolean;
  initializationPieces: string[];
  supportsOneShotPrompt: boolean;
  entersInteractiveRepl: boolean;
  routesPlainTextToAgent: boolean;
  runtimeSettings: string[];
}

export interface ConfigSummaryReport {
  configFiles: string[];
  envVariables: string[];
  cliFlags: string[];
  configFlow: string[];
}

const SCRIPT_FILE_PATTERN =
  /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs)\b/g;
const PROCESS_ENV_PATTERN = /process\.env\.([A-Z0-9_]+)/g;
const ENV_FILE_PATTERN = /^([A-Z][A-Z0-9_]+)=/gm;
const FLAG_PATTERN = /--[a-z][a-z0-9-]*/g;
const LOCAL_IMPORT_PATTERN =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;

async function readTextIfExists(rootDir: string, relativePath: string): Promise<string | null> {
  const absolutePath = resolvePathInsideRoot(rootDir, relativePath);
  if (!existsSync(absolutePath)) {
    return null;
  }

  return readFile(absolutePath, 'utf8');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

async function parsePackageJson(rootDir: string): Promise<PackageJson | null> {
  const text = await readTextIfExists(rootDir, 'package.json');
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

async function collectTopLevelEntries(
  rootDir: string
): Promise<{ directories: string[]; files: string[] }> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const directories: string[] = [];
  const files: string[] = [];

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
    if (entry.isDirectory()) {
      if (!shouldIgnoreDirectory(entry.name)) {
        directories.push(`${entry.name}/`);
      }
      continue;
    }

    if (entry.isFile()) {
      files.push(entry.name);
    }
  }

  return { directories, files };
}

function detectStack(topLevelFiles: string[], topLevelDirectories: string[]): string[] {
  const stack: string[] = [];

  if (topLevelFiles.includes('package.json')) {
    stack.push('Node.js project via package.json');
  }
  if (
    topLevelFiles.includes('tsconfig.json') ||
    topLevelFiles.some((file) => file.endsWith('.ts') || file.endsWith('.tsx')) ||
    topLevelDirectories.includes('src/')
  ) {
    stack.push('TypeScript-style source layout');
  }
  if (topLevelFiles.includes('go.mod')) {
    stack.push('Go project via go.mod');
  }
  if (topLevelFiles.includes('pyproject.toml') || topLevelFiles.includes('requirements.txt')) {
    stack.push('Python project files detected');
  }
  if (topLevelDirectories.includes('docs/')) {
    stack.push('Documentation folder present');
  }

  return uniqueSorted(stack);
}

async function pathExists(rootDir: string, relativePath: string): Promise<boolean> {
  return existsSync(resolvePathInsideRoot(rootDir, relativePath));
}

function addCandidate(
  candidates: Map<string, EntrypointCandidate>,
  relativePath: string,
  reason: string,
  score: number
): void {
  const existing = candidates.get(relativePath);
  if (!existing || score > existing.score) {
    candidates.set(relativePath, {
      path: relativePath,
      reason,
      score,
    });
  }
}

async function maybeAddCandidate(
  rootDir: string,
  candidates: Map<string, EntrypointCandidate>,
  relativePath: string,
  reason: string,
  score: number
): Promise<void> {
  if (await pathExists(rootDir, relativePath)) {
    addCandidate(candidates, relativePath, reason, score);
  }
}

async function maybeAddSourceEquivalent(
  rootDir: string,
  candidates: Map<string, EntrypointCandidate>,
  builtPath: string,
  reason: string,
  score: number
): Promise<void> {
  if (!/^(dist|build)\//.test(builtPath) || !/\.(?:js|mjs|cjs)$/.test(builtPath)) {
    return;
  }

  const sourceBase = builtPath.replace(/^(dist|build)\//, 'src/').replace(/\.(?:js|mjs|cjs)$/, '');
  for (const sourcePath of [`${sourceBase}.ts`, `${sourceBase}.tsx`]) {
    if (await pathExists(rootDir, sourcePath)) {
      addCandidate(candidates, sourcePath, `${reason} (source equivalent)`, score + 5);
      return;
    }
  }
}

function extractScriptPaths(command: string): string[] {
  return uniqueSorted(command.match(SCRIPT_FILE_PATTERN) ?? []);
}

export async function findEntrypointCandidates(
  rootDir: string
): Promise<Array<{ path: string; reason: string }>> {
  const candidates = new Map<string, EntrypointCandidate>();
  const packageJson = await parsePackageJson(rootDir);

  if (packageJson?.scripts) {
    for (const [scriptName, command] of Object.entries(packageJson.scripts)) {
      const baseScore =
        scriptName === 'dev' ? 120 : scriptName === 'start' ? 115 : scriptName === 'build' ? 90 : 80;

      for (const relativePath of extractScriptPaths(command)) {
        await maybeAddCandidate(
          rootDir,
          candidates,
          relativePath,
          `package.json script "${scriptName}" -> ${command}`,
          baseScore
        );
        await maybeAddSourceEquivalent(
          rootDir,
          candidates,
          relativePath,
          `package.json script "${scriptName}" -> ${command}`,
          baseScore
        );
      }
    }
  }

  if (typeof packageJson?.bin === 'string') {
    await maybeAddCandidate(rootDir, candidates, packageJson.bin, 'package.json bin', 105);
    await maybeAddSourceEquivalent(rootDir, candidates, packageJson.bin, 'package.json bin', 105);
  } else if (packageJson?.bin) {
    for (const [binName, relativePath] of Object.entries(packageJson.bin)) {
      await maybeAddCandidate(
        rootDir,
        candidates,
        relativePath,
        `package.json bin "${binName}"`,
        105
      );
      await maybeAddSourceEquivalent(
        rootDir,
        candidates,
        relativePath,
        `package.json bin "${binName}"`,
        105
      );
    }
  }

  if (typeof packageJson?.main === 'string') {
    await maybeAddCandidate(rootDir, candidates, packageJson.main, 'package.json main', 95);
    await maybeAddSourceEquivalent(rootDir, candidates, packageJson.main, 'package.json main', 95);
  }

  const commonPaths: Array<[string, string, number]> = [
    ['src/index.ts', 'common source entrypoint', 110],
    ['src/index.tsx', 'common source entrypoint', 109],
    ['src/main.ts', 'common source entrypoint', 108],
    ['src/cli.ts', 'common CLI entrypoint', 108],
    ['index.ts', 'common root entrypoint', 100],
    ['main.ts', 'common root entrypoint', 99],
    ['cli.ts', 'common root CLI entrypoint', 99],
    ['dist/index.js', 'common built entrypoint', 85],
  ];

  for (const [relativePath, reason, score] of commonPaths) {
    await maybeAddCandidate(rootDir, candidates, relativePath, reason, score);
  }

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map(({ path: relativePath, reason }) => ({
      path: relativePath,
      reason,
    }));
}

function extractMatches(source: string, pattern: RegExp): string[] {
  const matches = new Set<string>();
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1]) {
      matches.add(match[1]);
    } else if (match[0]) {
      matches.add(match[0]);
    }
  }
  pattern.lastIndex = 0;
  return [...matches].sort((left, right) => left.localeCompare(right));
}

function isInsideRoot(rootDir: string, absolutePath: string): boolean {
  const relativePath = path.relative(rootDir, absolutePath);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function resolveRelativeImport(rootDir: string, fromRelativePath: string, specifier: string): string | null {
  const fromAbsolutePath = resolvePathInsideRoot(rootDir, fromRelativePath);
  const basePath = path.resolve(path.dirname(fromAbsolutePath), specifier);
  const extensionlessBasePath = specifier.match(/\.(?:js|jsx|mjs|cjs)$/)
    ? basePath.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
    : basePath;
  const candidates = [
    basePath,
    extensionlessBasePath,
    `${extensionlessBasePath}.ts`,
    `${extensionlessBasePath}.tsx`,
    `${extensionlessBasePath}.js`,
    `${extensionlessBasePath}.jsx`,
    `${extensionlessBasePath}.mjs`,
    `${extensionlessBasePath}.cjs`,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    path.join(extensionlessBasePath, 'index.ts'),
    path.join(extensionlessBasePath, 'index.tsx'),
    path.join(extensionlessBasePath, 'index.js'),
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && isInsideRoot(rootDir, candidate)) {
      return relativeToRoot(rootDir, candidate);
    }
  }

  return null;
}

async function extractSupportingFiles(
  rootDir: string,
  entrypointPath: string,
  maxFiles = 6
): Promise<string[]> {
  const source = await readTextIfExists(rootDir, entrypointPath);
  if (!source) {
    return [];
  }

  const imports = extractMatches(source, LOCAL_IMPORT_PATTERN);
  const supportingFiles: string[] = [];

  for (const specifier of imports) {
    const resolved = resolveRelativeImport(rootDir, entrypointPath, specifier);
    if (!resolved || supportingFiles.includes(resolved)) {
      continue;
    }

    supportingFiles.push(resolved);
    if (supportingFiles.length >= maxFiles) {
      break;
    }
  }

  return supportingFiles;
}

function joinNaturalList(items: string[]): string {
  if (items.length === 0) {
    return '';
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function hasSourceSnippet(source: string, snippet: string): boolean {
  return source.includes(snippet);
}

function buildEntrypointFlow(
  entrypointPath: string,
  entrypointSource: string,
  supportingFiles: string[]
): { steps: string[]; signals: EntrypointFlowSignals } {
  const steps: string[] = [`Start in ${entrypointPath}.`];
  const supportingSet = new Set(supportingFiles.map((file) => file.replace(/\\/g, '/')));
  const signals: EntrypointFlowSignals = {
    loadsDotEnv:
      hasSourceSnippet(entrypointSource, 'loadDotEnv(') || supportingSet.has('src/env.ts'),
    buildsConfig:
      hasSourceSnippet(entrypointSource, 'createConfigFromInputs(') || supportingSet.has('src/config.ts'),
    handlesHelp: hasSourceSnippet(entrypointSource, 'parsed.showHelp'),
    initializationPieces: [],
    supportsOneShotPrompt: hasSourceSnippet(entrypointSource, 'if (parsed.prompt)'),
    entersInteractiveRepl: hasSourceSnippet(entrypointSource, 'while (true)'),
    routesPlainTextToAgent: hasSourceSnippet(entrypointSource, "if (!entry.startsWith('/'))"),
    runtimeSettings: [],
  };

  if (signals.loadsDotEnv) {
    steps.push('Load `.env` values from the current working directory through `src/env.ts`.');
  }

  if (signals.buildsConfig) {
    steps.push(
      'Parse CLI arguments and environment defaults through `src/config.ts` to build the initial runtime config.'
    );
  }

  if (signals.handlesHelp) {
    steps.push('If `--help` is present, print the startup help and exit early.');
  }

  const initializedPieces: string[] = [];
  if (hasSourceSnippet(entrypointSource, 'createTools()')) {
    initializedPieces.push('the tool catalog');
  }
  if (hasSourceSnippet(entrypointSource, 'createInterface({ input, output })')) {
    initializedPieces.push('the readline REPL interface');
  }
  if (hasSourceSnippet(entrypointSource, 'createModelAdapter(config)')) {
    initializedPieces.push('the selected model adapter');
  }
  if (hasSourceSnippet(entrypointSource, 'new AgentRunner(')) {
    initializedPieces.push('the AgentRunner');
  }
  signals.initializationPieces = initializedPieces;

  if (initializedPieces.length > 0) {
    steps.push(`Initialize ${joinNaturalList(initializedPieces)}.`);
  }

  if (signals.supportsOneShotPrompt) {
    steps.push('If a one-shot `--prompt` is provided, run one agent turn and then exit.');
  }

  if (signals.entersInteractiveRepl) {
    steps.push('Otherwise, print the current config summary and enter the interactive REPL loop.');
  }

  if (signals.routesPlainTextToAgent) {
    steps.push('Plain text REPL input is treated as a user request and sent to the agent loop.');
  }

  const runtimeSettings: string[] = [];
  if (hasSourceSnippet(entrypointSource, "if (entry.startsWith('/provider '))")) {
    runtimeSettings.push('provider');
  }
  if (hasSourceSnippet(entrypointSource, "if (entry.startsWith('/model '))")) {
    runtimeSettings.push('model');
  }
  if (hasSourceSnippet(entrypointSource, "if (entry.startsWith('/base-url '))")) {
    runtimeSettings.push('base URL');
  }
  if (hasSourceSnippet(entrypointSource, "if (entry.startsWith('/api-key '))")) {
    runtimeSettings.push('API key');
  }
  if (hasSourceSnippet(entrypointSource, "if (entry.startsWith('/workdir '))")) {
    runtimeSettings.push('workdir');
  }
  if (hasSourceSnippet(entrypointSource, "if (entry.startsWith('/approve '))")) {
    runtimeSettings.push('approval mode');
  }
  signals.runtimeSettings = runtimeSettings;

  if (runtimeSettings.length > 0) {
    steps.push(
      `Slash commands can update runtime settings such as ${joinNaturalList(runtimeSettings)} without restarting the program.`
    );
  }

  return {
    steps,
    signals,
  };
}

export async function analyzeProject(rootDir: string): Promise<ProjectSummaryReport> {
  const packageJson = await parsePackageJson(rootDir);
  const { directories, files } = await collectTopLevelEntries(rootDir);
  const entrypointCandidates = await findEntrypointCandidates(rootDir);
  const keyFiles = [
    'package.json',
    'README.md',
    '.env.example',
    'tsconfig.json',
    'src/index.ts',
    'src/config.ts',
    'src/modelAdapters.ts',
    'src/tools.ts',
    'src/agent.ts',
  ];
  const existingKeyFiles: string[] = [];

  for (const relativePath of keyFiles) {
    if (await pathExists(rootDir, relativePath)) {
      existingKeyFiles.push(relativePath);
    }
  }

  const recommendedNextFiles = uniqueSorted([
    'package.json',
    'README.md',
    entrypointCandidates[0]?.path ?? '',
    'src/config.ts',
    'src/agent.ts',
    'src/tools.ts',
  ]).filter(Boolean);

  return {
    packageName: packageJson?.name,
    topLevelDirectories: directories,
    topLevelFiles: files,
    detectedStack: detectStack(files, directories),
    keyFiles: existingKeyFiles,
    entrypointCandidates: entrypointCandidates.slice(0, 5),
    recommendedNextFiles,
  };
}

export async function analyzeEntrypoint(rootDir: string): Promise<EntrypointReport> {
  const packageJson = await parsePackageJson(rootDir);
  const candidatePaths = await findEntrypointCandidates(rootDir);
  const primaryEntrypoint = candidatePaths[0]?.path ?? null;
  const entrypointSource = primaryEntrypoint ? await readTextIfExists(rootDir, primaryEntrypoint) : null;
  const supportingFiles = primaryEntrypoint
    ? await extractSupportingFiles(rootDir, primaryEntrypoint)
    : [];
  const flowAnalysis =
    primaryEntrypoint && entrypointSource
      ? buildEntrypointFlow(primaryEntrypoint, entrypointSource, supportingFiles)
      : null;
  const startupFlow = flowAnalysis?.steps ?? ['No obvious entrypoint candidate was found in the current workspace.'];
  const evidence = candidatePaths.length
    ? candidatePaths.slice(0, 5).map((candidate) => `${candidate.path}: ${candidate.reason}`)
    : ['No entrypoint candidate was detected from package.json or common file paths.'];

  return {
    packageName: packageJson?.name,
    primaryEntrypoint,
    candidatePaths: candidatePaths.slice(0, 5),
    supportingFiles,
    startupFlow,
    flowSignals: flowAnalysis?.signals ?? {
      loadsDotEnv: false,
      buildsConfig: false,
      handlesHelp: false,
      initializationPieces: [],
      supportsOneShotPrompt: false,
      entersInteractiveRepl: false,
      routesPlainTextToAgent: false,
      runtimeSettings: [],
    },
    evidence,
  };
}

export async function analyzeConfig(rootDir: string): Promise<ConfigSummaryReport> {
  const configFiles = ['.env.example', 'src/config.ts', 'src/index.ts', 'README.md'];
  const existingConfigFiles: string[] = [];
  const envVariables = new Set<string>();
  const cliFlags = new Set<string>();
  const configFlow: string[] = [];

  for (const relativePath of configFiles) {
    const source = await readTextIfExists(rootDir, relativePath);
    if (!source) {
      continue;
    }

    existingConfigFiles.push(relativePath);

    if (relativePath === '.env.example') {
      for (const match of extractMatches(source, ENV_FILE_PATTERN)) {
        envVariables.add(match);
      }
      configFlow.push('.env.example documents the supported environment variables.');
    }

    if (relativePath === 'src/config.ts') {
      for (const match of extractMatches(source, PROCESS_ENV_PATTERN)) {
        envVariables.add(match);
      }
      configFlow.push('src/config.ts merges CLI flags with process.env defaults.');
    }

    if (relativePath === 'src/index.ts') {
      for (const match of source.match(FLAG_PATTERN) ?? []) {
        cliFlags.add(match);
      }

      if (source.includes('loadDotEnv(')) {
        configFlow.push('src/index.ts loads .env values before building the runtime config.');
      }
      if (source.includes('createConfigFromInputs(')) {
        configFlow.push('src/index.ts builds the runtime config from CLI inputs.');
      }
    }

    if (relativePath === 'README.md') {
      if (source.includes('.env.example')) {
        configFlow.push('README.md explains how to create and use the .env file.');
      }
      if (source.includes('--provider') || source.includes('--model') || source.includes('/config')) {
        configFlow.push('README.md documents the main startup flags and REPL config commands.');
      }
    }
  }

  return {
    configFiles: uniqueSorted(existingConfigFiles),
    envVariables: uniqueSorted([...envVariables]),
    cliFlags: uniqueSorted([...cliFlags]),
    configFlow: uniqueInOrder(configFlow),
  };
}
