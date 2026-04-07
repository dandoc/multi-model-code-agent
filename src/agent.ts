import path from 'node:path';

import { formatToolResultForModel, parseAgentEnvelope } from './jsonProtocol.js';
import { buildSystemPrompt } from './prompt.js';
import { previewWritePatch, renderWritePatchPreview } from './writePatchPreview.js';

import type {
  AgentConfig,
  ChatMessage,
  ModelAdapter,
  ToolDefinition,
  ToolExecutionResult,
} from './types.js';

const STRUCTURE_KEYWORDS = [
  'project structure',
  'directory structure',
  'architecture',
  'file layout',
  'project summary',
  'folder structure',
  'repo structure',
  'summarize this project',
  '\uD504\uB85C\uC81D\uD2B8 \uAD6C\uC870',
  '\uD3F4\uB354 \uAD6C\uC870',
  '\uB9AC\uD3EC \uAD6C\uC870',
  '\uD504\uB85C\uC81D\uD2B8 \uC694\uC57D',
  '\uAD6C\uC870 \uC694\uC57D',
];

const ENTRYPOINT_KEYWORDS = [
  'entrypoint',
  'entry point',
  'execution flow',
  'startup flow',
  'how to run',
  'run this project',
  'main file',
  'main entry',
  '\uC2E4\uD589 \uD750\uB984',
  '\uC5D4\uD2B8\uB9AC\uD3EC\uC778\uD2B8',
  '\uC5B4\uB5BB\uAC8C \uC2E4\uD589',
  '\uC2E4\uD589 \uBC29\uBC95',
];

const CONFIG_KEYWORDS = [
  'config',
  'configuration',
  'environment variable',
  'env file',
  'config parsing',
  '\uC124\uC815',
  '\uD658\uACBD \uBCC0\uC218',
  '\uC124\uC815 \uD30C\uC2F1',
];

interface AgentUI {
  confirm: (message: string) => Promise<boolean>;
  log: (message: string) => void;
}

type EntrypointFlowSignals = {
  loadsDotEnv: boolean;
  buildsConfig: boolean;
  handlesHelp: boolean;
  initializationPieces: string[];
  supportsOneShotPrompt: boolean;
  entersInteractiveRepl: boolean;
  routesPlainTextToAgent: boolean;
  runtimeSettings: string[];
};

function matchesAnyKeyword(userInput: string, keywords: string[]): boolean {
  const normalized = userInput.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

export class AgentRunner {
  private history: ChatMessage[] = [];
  private toolMap: Map<ToolDefinition['name'], ToolDefinition>;
  private bootstrapResults = new Map<ToolDefinition['name'], ToolExecutionResult>();

  constructor(
    private config: AgentConfig,
    private adapter: ModelAdapter,
    private tools: ToolDefinition[],
    private ui: AgentUI
  ) {
    this.toolMap = new Map(this.tools.map((tool) => [tool.name, tool]));
  }

  updateConfig(config: AgentConfig): void {
    this.config = config;
  }

  updateAdapter(adapter: ModelAdapter): void {
    this.adapter = adapter;
  }

  reset(): void {
    this.history = [];
    this.bootstrapResults.clear();
  }

  private buildMessages(): ChatMessage[] {
    return [
      {
        role: 'system',
        content: buildSystemPrompt(this.config, this.tools),
      },
      ...this.history,
    ];
  }

  private isStructureQuestion(userInput: string): boolean {
    return matchesAnyKeyword(userInput, STRUCTURE_KEYWORDS);
  }

  private isEntrypointQuestion(userInput: string): boolean {
    return matchesAnyKeyword(userInput, ENTRYPOINT_KEYWORDS);
  }

  private isConfigQuestion(userInput: string): boolean {
    return matchesAnyKeyword(userInput, CONFIG_KEYWORDS);
  }

  private looksLikeWorkspaceLocalCreationTask(userInput: string): boolean {
    const normalized = userInput.toLowerCase();
    const hasCreationIntent =
      /(?:^|\s)(?:create|make|generate|write|add)\b/.test(normalized) ||
      /만들|생성|작성|추가/.test(userInput);
    const hasFileOrFolderIntent =
      /\b(?:file|files|folder|directory|directories|dir)\b/.test(normalized) ||
      /파일|폴더|디렉터리|폴더를|파일을/.test(userInput);
    const hasCodeArtifactHint =
      /\b(?:c\+\+|python|java|c#|cpp|source code)\b/.test(normalized) ||
      /\.(?:c|cpp|py|java|cs)\b/i.test(userInput);

    return hasCreationIntent && (hasFileOrFolderIntent || hasCodeArtifactHint);
  }

  private mentionsExplicitOutsidePath(userInput: string): boolean {
    const windowsPaths = userInput.match(/[A-Za-z]:\\[^\s"'`]+/g) ?? [];
    const normalizedWorkdir = this.config.workdir.toLowerCase();

    if (windowsPaths.some((pathValue) => !pathValue.toLowerCase().startsWith(normalizedWorkdir))) {
      return true;
    }

    return /\.\.[\\/]/.test(userInput);
  }

  private isSafeWorkspaceLocalCreationTask(userInput: string): boolean {
    return (
      this.looksLikeWorkspaceLocalCreationTask(userInput) &&
      !this.mentionsExplicitOutsidePath(userInput)
    );
  }

  private requiresFileAnchoredAnswer(userInput: string): boolean {
    return (
      this.isStructureQuestion(userInput) ||
      this.isEntrypointQuestion(userInput) ||
      this.isConfigQuestion(userInput) ||
      this.extractExplicitFilePaths(userInput).length > 0
    );
  }

  private countFileReferences(text: string): number {
    const matches =
      text.match(
        /\b(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|txt|sh|ps1|cjs|mjs)\b/g
      ) ?? [];

    return new Set(matches).size;
  }

  private needsMoreGroundedAnswer(userInput: string, text: string): boolean {
    const fileReferenceCount = this.countFileReferences(text);

    if (this.isEntrypointQuestion(userInput)) {
      return fileReferenceCount < 2;
    }

    if (this.isStructureQuestion(userInput) || this.isConfigQuestion(userInput)) {
      return fileReferenceCount < 2;
    }

    return fileReferenceCount < 1;
  }

  private looksLikeNumberedChecklist(text: string): boolean {
    const numberedLines = text.match(/^\s*\d+\.\s/mg) ?? [];
    return numberedLines.length >= 3;
  }

  private containsRawEnglishSectionLabels(text: string): boolean {
    return /\b(?:TOP-LEVEL FILES|KEY FILES|ENTRYPOINT CANDIDATES|DETECTED STACK|CONFIG FILES|ENV VARIABLES|CLI FLAGS|CONFIG FLOW)\b/.test(
      text
    );
  }

  private containsAwkwardKoreanPhrase(text: string): boolean {
    return /빌립니다|빌려/i.test(text);
  }

  private extractExplicitFilePaths(userInput: string): string[] {
    const matches =
      userInput.match(
        /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|txt|sh|ps1|cjs|mjs)\b/g
      ) ?? [];

    return [...new Set(matches)];
  }

  private async executeTool(
    tool: ToolDefinition,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const needsApproval = tool.requiresApproval && !this.config.autoApprove;

    if (needsApproval) {
      const approved = await this.ui.confirm(await this.buildApprovalMessage(tool, args));

      if (!approved) {
        return {
          ok: false,
          summary: `${tool.name} was denied by the user.`,
          output:
            'The user denied this tool call. Choose a safer alternative or explain what you need.',
        };
      }
    }

    this.ui.log(`Running ${tool.name}...`);

    try {
      return await tool.run(args, {
        config: this.config,
        confirm: this.ui.confirm,
        log: this.ui.log,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `${tool.name} failed.`,
        output: message,
      };
    }
  }

  private async buildApprovalMessage(
    tool: ToolDefinition,
    args: Record<string, unknown>
  ): Promise<string> {
    if (tool.name === 'write_patch') {
      try {
        const preview = await previewWritePatch(this.config.workdir, args);
        return [renderWritePatchPreview(preview, 'approval'), '', 'Approve this edit?'].join('\n');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [`Approve write_patch?`, `Preview unavailable: ${message}`].join('\n');
      }
    }

    if (tool.name === 'run_shell') {
      const command = typeof args.command === 'string' ? args.command : '(missing command)';
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000;
      return [
        `Approve shell command in ${this.config.workdir}?`,
        `Timeout: ${timeoutMs}ms`,
        'Command:',
        command,
      ].join('\n');
    }

    return `Approve ${tool.name} with arguments ${JSON.stringify(args)}?`;
  }

  private async bootstrapContext(
    userInput: string,
    toolName: ToolDefinition['name'],
    logMessage: string,
    intro: string,
    instructions: string
  ): Promise<void> {
    const tool = this.toolMap.get(toolName);
    if (!tool) {
      return;
    }

    this.ui.log(logMessage);
    const result = await this.executeTool(tool, {});
    this.bootstrapResults.set(toolName, result);

    this.history.push({
      role: 'user',
      content: [
        intro,
        `Original question: ${userInput}`,
        instructions,
        'When you answer, mention the concrete file paths you relied on.',
        formatToolResultForModel(toolName, result),
      ].join('\n\n'),
    });
  }

  private async maybeBootstrapStructureContext(userInput: string): Promise<void> {
    if (!this.isStructureQuestion(userInput)) {
      return;
    }

    await this.bootstrapContext(
      userInput,
      'summarize_project',
      'Bootstrapping structure context with summarize_project...',
      'Structure bootstrap for the current workspace.',
      'Use this deterministic project summary instead of guessing. Prefer natural Korean labels and do not repeat raw headings like TOP-LEVEL FILES or KEY FILES.'
    );
  }

  private async maybeBootstrapExplicitFileContext(userInput: string): Promise<void> {
    const paths = this.extractExplicitFilePaths(userInput);
    if (paths.length < 2) {
      return;
    }

    const readMultipleFilesTool = this.toolMap.get('read_multiple_files');
    if (!readMultipleFilesTool) {
      return;
    }

    this.ui.log('Bootstrapping explicit file context with read_multiple_files...');
    const result = await this.executeTool(readMultipleFilesTool, {
      paths,
      startLine: 1,
      maxLinesPerFile: 180,
      maxFiles: 6,
    });

    this.history.push({
      role: 'user',
      content: [
        'Explicit file bootstrap for the current workspace.',
        `Original question: ${userInput}`,
        'Use these real file contents instead of guessing.',
        'When you answer, cite the file paths you relied on.',
        formatToolResultForModel('read_multiple_files', result),
      ].join('\n\n'),
    });
  }

  private async maybeBootstrapEntrypointContext(userInput: string): Promise<void> {
    if (!this.isEntrypointQuestion(userInput)) {
      return;
    }

    await this.bootstrapContext(
      userInput,
      'find_entrypoint',
      'Bootstrapping entrypoint context with find_entrypoint...',
      'Entrypoint bootstrap for the current workspace.',
      'Use this deterministic entrypoint analysis to explain how the project starts and runs. Prefer a short natural explanation instead of a numbered import list.'
    );
  }

  private async maybeBootstrapConfigContext(userInput: string): Promise<void> {
    if (!this.isConfigQuestion(userInput)) {
      return;
    }

    await this.bootstrapContext(
      userInput,
      'summarize_config',
      'Bootstrapping config context with summarize_config...',
      'Config bootstrap for the current workspace.',
      'Use this deterministic config summary instead of guessing. Prefer a short natural explanation over a numbered checklist, and avoid awkward phrases like "런타임 설정을 빌립니다".'
    );
  }

  private isInvalidFinalResponse(rawResponse: string): boolean {
    const cleaned = rawResponse.trim();
    if (/^TOOL RESULT:/im.test(cleaned)) {
      return true;
    }

    if (/^SUMMARY:/im.test(cleaned) && /^OUTPUT:/im.test(cleaned)) {
      return true;
    }

    return false;
  }

  private looksLikeGenericRefusal(text: string): boolean {
    return /(?:i(?:'| a)m sorry|can't assist|cannot assist|can not assist|unable to assist|outside of the workspace|outside of the workspace root|outside the workspace|denied because)/i.test(
      text
    );
  }

  private buildWorkspaceCreationRetryInstruction(): string {
    const workspaceName = path.basename(this.config.workdir);

    return [
      'The previous refusal was incorrect.',
      `The current workspace root is ${this.config.workdir}.`,
      'Creating files and nested directories inside this workspace is allowed.',
      'Use write_patch with operation="create" for each new file. Parent directories will be created automatically.',
      `If the user says "${workspaceName} dir 안에" or "inside ${workspaceName}", treat that as inside the current workspace root.`,
      'Do not refuse unless the user explicitly asks for a path outside the current workspace.',
      'Continue with the file creation task now.',
    ].join('\n');
  }

  private isLikelyKorean(text: string): boolean {
    return /[\u3131-\uD79D]/.test(text) || /\bin korean\b/i.test(text) || /\uD55C\uAD6D\uC5B4/.test(text);
  }

  private getStringMetadata(
    metadata: Record<string, unknown> | undefined,
    key: string
  ): string | null {
    const value = metadata?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private getStringArrayMetadata(
    metadata: Record<string, unknown> | undefined,
    key: string
  ): string[] {
    const value = metadata?.[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  }

  private getCandidateMetadata(
    metadata: Record<string, unknown> | undefined,
    key: string
  ): Array<{ path: string; reason: string }> {
    const value = metadata?.[key];
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }

      const pathValue = 'path' in item && typeof item.path === 'string' ? item.path : null;
      const reasonValue = 'reason' in item && typeof item.reason === 'string' ? item.reason : null;

      return pathValue && reasonValue ? [{ path: pathValue, reason: reasonValue }] : [];
    });
  }

  private countToolResults(toolName: ToolDefinition['name']): number {
    return this.history.filter(
      (message) => message.role === 'user' && message.content.includes(`TOOL RESULT: ${toolName}`)
    ).length;
  }

  private looksLikeTaskCompletionClaim(text: string): boolean {
    return /(?:\bdone\b|\bcompleted\b|\bcreated\b|\bfinished\b|\bupdated\b|\bwrote\b|완료|생성|만들었|작성)/i.test(
      text
    );
  }

  private buildCreationToolUseRetryInstruction(): string {
    return [
      'You have not created any files yet.',
      'The user asked for real files and folders inside the current workspace.',
      'Do not say the task is complete until you have successful write_patch tool results.',
      'Use write_patch now to create the requested files.',
    ].join('\n');
  }

  private getPreferredBootstrapResult(
    userInput: string
  ): { toolName: ToolDefinition['name']; result: ToolExecutionResult } | null {
    if (this.isEntrypointQuestion(userInput)) {
      const result = this.bootstrapResults.get('find_entrypoint');
      if (result) {
        return { toolName: 'find_entrypoint', result };
      }
    }

    if (this.isConfigQuestion(userInput)) {
      const result = this.bootstrapResults.get('summarize_config');
      if (result) {
        return { toolName: 'summarize_config', result };
      }
    }

    if (this.isStructureQuestion(userInput)) {
      const result = this.bootstrapResults.get('summarize_project');
      if (result) {
        return { toolName: 'summarize_project', result };
      }
    }

    return null;
  }

  private normalizeDisplayPath(pathValue: string): string {
    return pathValue.replace(/\\/g, '/');
  }

  private formatDisplayPaths(paths: string[]): string[] {
    return paths.map((pathValue) => `\`${this.normalizeDisplayPath(pathValue)}\``);
  }

  private translateProjectStackLabel(label: string): string {
    switch (label) {
      case 'Documentation folder present':
        return '\uBB38\uC11C \uD3F4\uB354\uAC00 \uC788\uB294';
      case 'Node.js project via package.json':
        return 'package.json \uAE30\uBC18 Node.js';
      case 'TypeScript-style source layout':
        return 'TypeScript \uC2A4\uD0C0\uC77C \uC18C\uC2A4 \uB808\uC774\uC544\uC6C3';
      case 'Go project via go.mod':
        return 'go.mod \uAE30\uBC18 Go';
      case 'Python project files detected':
        return 'Python \uD504\uB85C\uC81D\uD2B8 \uD30C\uC77C\uC774 \uAC10\uC9C0\uB41C';
      default:
        return label;
    }
  }

  private joinNaturalKorean(items: string[]): string {
    const pairJoiner = (left: string, right: string): string => {
      const lastChar = left[left.length - 1];
      const codePoint = lastChar ? lastChar.charCodeAt(0) : 0;
      const isHangulSyllable = codePoint >= 0xac00 && codePoint <= 0xd7a3;
      const hasBatchim = isHangulSyllable ? (codePoint - 0xac00) % 28 !== 0 : false;
      return `${left}${hasBatchim ? '과' : '와'} ${right}`;
    };

    if (items.length === 0) {
      return '';
    }
    if (items.length === 1) {
      return items[0];
    }
    if (items.length === 2) {
      return pairJoiner(items[0], items[1]);
    }

    return `${items.slice(0, -1).join(', ')}, ${items[items.length - 1]}`;
  }

  private joinNaturalEnglish(items: string[]): string {
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

  private translateRuntimeSetting(setting: string): string {
    switch (setting) {
      case 'provider':
        return 'provider';
      case 'model':
        return 'model';
      case 'base URL':
        return 'base URL';
      case 'API key':
        return 'API key';
      case 'workdir':
        return 'workdir';
      case 'approval mode':
        return '승인 모드';
      default:
        return setting;
    }
  }

  private translateInitializationPiece(piece: string): string {
    switch (piece) {
      case 'the tool catalog':
        return '`createTools()`로 만든 툴 목록';
      case 'the readline REPL interface':
        return 'readline 기반 REPL 인터페이스';
      case 'the selected model adapter':
        return '선택한 모델 어댑터';
      case 'the AgentRunner':
        return '`AgentRunner`';
      default:
        return piece;
    }
  }

  private getEntrypointFlowSignals(
    metadata: Record<string, unknown> | undefined
  ): EntrypointFlowSignals {
    const value = metadata?.flowSignals;
    if (!value || typeof value !== 'object') {
      return {
        loadsDotEnv: false,
        buildsConfig: false,
        handlesHelp: false,
        initializationPieces: [],
        supportsOneShotPrompt: false,
        entersInteractiveRepl: false,
        routesPlainTextToAgent: false,
        runtimeSettings: [],
      };
    }

    const record = value as Record<string, unknown>;
    return {
      loadsDotEnv: record.loadsDotEnv === true,
      buildsConfig: record.buildsConfig === true,
      handlesHelp: record.handlesHelp === true,
      initializationPieces: Array.isArray(record.initializationPieces)
        ? record.initializationPieces.filter(
            (item): item is string => typeof item === 'string' && item.length > 0
          )
        : [],
      supportsOneShotPrompt: record.supportsOneShotPrompt === true,
      entersInteractiveRepl: record.entersInteractiveRepl === true,
      routesPlainTextToAgent: record.routesPlainTextToAgent === true,
      runtimeSettings: Array.isArray(record.runtimeSettings)
        ? record.runtimeSettings.filter(
            (item): item is string => typeof item === 'string' && item.length > 0
          )
        : [],
    };
  }

  private buildEntrypointNarrativeKorean(
    primaryEntrypoint: string | null,
    supportingFiles: string[],
    signals: EntrypointFlowSignals,
    evidence: string[]
  ): string {
    const paragraphs: string[] = [];

    const introParts: string[] = [];
    if (primaryEntrypoint) {
      introParts.push(`이 프로젝트는 \`${this.normalizeDisplayPath(primaryEntrypoint)}\`에서 시작합니다.`);
    }
    if (signals.loadsDotEnv && signals.buildsConfig) {
      introParts.push(
        '먼저 `src/env.ts`를 통해 `.env` 값을 불러오고, `src/config.ts`에서 CLI 인자와 환경 변수를 합쳐 현재 실행 설정을 만듭니다.'
      );
    } else if (signals.loadsDotEnv) {
      introParts.push('먼저 `src/env.ts`를 통해 `.env` 값을 불러옵니다.');
    } else if (signals.buildsConfig) {
      introParts.push('먼저 `src/config.ts`에서 CLI 인자와 환경 변수를 합쳐 현재 실행 설정을 만듭니다.');
    }
    if (signals.handlesHelp) {
      introParts.push('`--help`가 있으면 시작 도움말만 출력하고 바로 종료합니다.');
    }
    if (introParts.length > 0) {
      paragraphs.push(introParts.join(' '));
    }

    const setupParts: string[] = [];
    if (signals.initializationPieces.length > 0) {
      const translatedPieces = signals.initializationPieces.map((piece) =>
        this.translateInitializationPiece(piece)
      );
      setupParts.push(`그다음 ${this.joinNaturalKorean(translatedPieces)}를 준비합니다.`);
    }
    if (signals.supportsOneShotPrompt && signals.entersInteractiveRepl) {
      setupParts.push(
        '`--prompt`가 있으면 요청을 한 번 실행하고 종료하고, 없으면 현재 설정을 보여준 뒤 대화형 REPL로 들어갑니다.'
      );
    } else if (signals.supportsOneShotPrompt) {
      setupParts.push('`--prompt`가 있으면 요청을 한 번 실행하고 종료합니다.');
    } else if (signals.entersInteractiveRepl) {
      setupParts.push('현재 설정을 보여준 뒤 대화형 REPL로 들어갑니다.');
    }
    if (setupParts.length > 0) {
      paragraphs.push(setupParts.join(' '));
    }

    const interactionParts: string[] = [];
    if (signals.routesPlainTextToAgent) {
      interactionParts.push('REPL에 일반 텍스트를 입력하면 에이전트가 그 요청을 처리합니다.');
    }
    if (signals.runtimeSettings.length > 0) {
      const translatedSettings = signals.runtimeSettings.map((setting) =>
        this.translateRuntimeSetting(setting)
      );
      interactionParts.push(
        `\`/provider\`나 \`/model\` 같은 슬래시 명령으로 ${this.joinNaturalKorean(
          translatedSettings
        )}를 바꿀 수 있습니다.`
      );
    }
    if (interactionParts.length > 0) {
      paragraphs.push(interactionParts.join(' '));
    }

    if (supportingFiles.length > 0) {
      paragraphs.push(`참고한 파일은 ${this.formatDisplayPaths(supportingFiles).join(', ')} 입니다.`);
    }

    if (evidence.length > 0) {
      paragraphs.push(`엔트리포인트 근거는 ${evidence.map((item) => `\`${item}\``).join(', ')} 입니다.`);
    }

    return paragraphs.join('\n\n');
  }

  private buildProjectSummaryNarrativeKorean(
    packageName: string | null,
    topLevelDirectories: string[],
    stack: string[],
    keyFiles: string[],
    recommendedNextFiles: string[],
    candidates: Array<{ path: string; reason: string }>
  ): string {
    const paragraphs: string[] = [];
    const translatedStack = stack.map((label) => this.translateProjectStackLabel(label));

    const introParts: string[] = [];
    if (packageName) {
      introParts.push(`\`${packageName}\`\uB294 ${
        translatedStack.length > 0
          ? `${translatedStack.join(', ')} \uAD6C\uC870\uC758 \uD504\uB85C\uC81D\uD2B8`
          : '\uD604\uC7AC \uC791\uC5C5 \uC911\uC778 \uD504\uB85C\uC81D\uD2B8'
      }\uC785\uB2C8\uB2E4.`);
    } else if (translatedStack.length > 0) {
      introParts.push(`\uC774 \uD504\uB85C\uC81D\uD2B8\uB294 ${translatedStack.join(', ')} \uAD6C\uC870\uB97C \uAC16\uACE0 \uC788\uC2B5\uB2C8\uB2E4.`);
    }

    if (topLevelDirectories.length > 0) {
      introParts.push(
        `\uC0C1\uC704 \uB514\uB809\uD130\uB9AC\uB294 ${this.formatDisplayPaths(topLevelDirectories).join(', ')} \uC785\uB2C8\uB2E4.`
      );
    }

    if (introParts.length > 0) {
      paragraphs.push(introParts.join(' '));
    }

    if (keyFiles.length > 0) {
      paragraphs.push(
        `\uD575\uC2EC \uD30C\uC77C\uC740 ${this.formatDisplayPaths(keyFiles).join(', ')} \uC785\uB2C8\uB2E4.`
      );
    }

    if (candidates.length > 0) {
      paragraphs.push(
        `\uC5D4\uD2B8\uB9AC\uD3EC\uC778\uD2B8 \uD6C4\uBCF4\uB294 ${candidates
          .map((candidate) => `\`${this.normalizeDisplayPath(candidate.path)}\`(${candidate.reason})`)
          .join(', ')} \uC785\uB2C8\uB2E4.`
      );
    }

    if (recommendedNextFiles.length > 0) {
      paragraphs.push(
        `\uB2E4\uC74C\uC5D0 \uC6B0\uC120 \uBCF4\uAE30 \uC88B\uC740 \uD30C\uC77C\uC740 ${this.formatDisplayPaths(
          recommendedNextFiles
        ).join(', ')} \uC785\uB2C8\uB2E4.`
      );
    }

    return paragraphs.join('\n\n');
  }

  private buildEntrypointNarrativeEnglish(
    primaryEntrypoint: string | null,
    supportingFiles: string[],
    signals: EntrypointFlowSignals,
    evidence: string[]
  ): string {
    const paragraphs: string[] = [];

    const introParts: string[] = [];
    if (primaryEntrypoint) {
      introParts.push(`This project starts in \`${this.normalizeDisplayPath(primaryEntrypoint)}\`.`);
    }
    if (signals.loadsDotEnv && signals.buildsConfig) {
      introParts.push(
        'It first loads `.env` values through `src/env.ts`, then combines CLI arguments and environment defaults in `src/config.ts` to build the runtime config.'
      );
    } else if (signals.loadsDotEnv) {
      introParts.push('It first loads `.env` values through `src/env.ts`.');
    } else if (signals.buildsConfig) {
      introParts.push('It first builds the runtime config in `src/config.ts`.');
    }
    if (signals.handlesHelp) {
      introParts.push('If `--help` is present, it prints the startup help and exits early.');
    }
    if (introParts.length > 0) {
      paragraphs.push(introParts.join(' '));
    }

    const setupParts: string[] = [];
    if (signals.initializationPieces.length > 0) {
      setupParts.push(
        `It then prepares ${this.joinNaturalEnglish(signals.initializationPieces)}.`
      );
    }
    if (signals.supportsOneShotPrompt && signals.entersInteractiveRepl) {
      setupParts.push(
        'If `--prompt` is provided, it runs one agent turn and exits; otherwise it shows the current config summary and enters the interactive REPL.'
      );
    } else if (signals.supportsOneShotPrompt) {
      setupParts.push('If `--prompt` is provided, it runs one agent turn and exits.');
    } else if (signals.entersInteractiveRepl) {
      setupParts.push('It then shows the current config summary and enters the interactive REPL.');
    }
    if (setupParts.length > 0) {
      paragraphs.push(setupParts.join(' '));
    }

    const interactionParts: string[] = [];
    if (signals.routesPlainTextToAgent) {
      interactionParts.push('Plain REPL input is treated as a user request and sent to the agent.');
    }
    if (signals.runtimeSettings.length > 0) {
      interactionParts.push(
        `Slash commands can update runtime settings such as ${this.joinNaturalEnglish(
          signals.runtimeSettings
        )} without restarting the program.`
      );
    }
    if (interactionParts.length > 0) {
      paragraphs.push(interactionParts.join(' '));
    }

    if (supportingFiles.length > 0) {
      paragraphs.push(`Supporting files: ${this.formatDisplayPaths(supportingFiles).join(', ')}.`);
    }

    if (evidence.length > 0) {
      paragraphs.push(`Entrypoint evidence: ${evidence.map((item) => `\`${item}\``).join(', ')}.`);
    }

    return paragraphs.join('\n\n');
  }

  private buildConfigNarrativeKorean(
    configFiles: string[],
    envVariables: string[],
    cliFlags: string[],
    configFlow: string[]
  ): string {
    const paragraphs: string[] = [];
    const hasEnvDoc = configFlow.includes('.env.example documents the supported environment variables.');
    const loadsDotEnv = configFlow.includes(
      'src/index.ts loads .env values before building the runtime config.'
    );
    const buildsFromCli = configFlow.includes('src/index.ts builds the runtime config from CLI inputs.');
    const mergesDefaults = configFlow.includes('src/config.ts merges CLI flags with process.env defaults.');
    const readmeExplainsEnv = configFlow.includes('README.md explains how to create and use the .env file.');
    const readmeExplainsCommands = configFlow.includes(
      'README.md documents the main startup flags and REPL config commands.'
    );

    if (configFiles.length > 0) {
      paragraphs.push(
        `설정과 관련해 먼저 보면 좋은 파일은 ${this.formatDisplayPaths(configFiles).join(', ')} 입니다.`
      );
    }

    const flowParts: string[] = [];
    if (hasEnvDoc) {
      flowParts.push('`.env.example`에는 지원하는 환경 변수가 정리되어 있습니다.');
    }
    if (loadsDotEnv && mergesDefaults) {
      flowParts.push(
        '실행이 시작되면 `src/index.ts`가 `.env` 값을 먼저 불러오고, `src/config.ts`가 CLI 인자와 환경 변수 기본값을 합쳐 런타임 설정을 만듭니다.'
      );
    } else if (loadsDotEnv) {
      flowParts.push('실행 시 `src/index.ts`가 `.env` 값을 먼저 불러옵니다.');
    } else if (mergesDefaults || buildsFromCli) {
      flowParts.push('실행 시 `src/config.ts`와 `src/index.ts`가 CLI 인자와 기본값을 바탕으로 런타임 설정을 만듭니다.');
    }
    if (readmeExplainsEnv || readmeExplainsCommands) {
      const readmeDetails: string[] = [];
      if (readmeExplainsEnv) {
        readmeDetails.push('`.env` 파일을 만드는 방법');
      }
      if (readmeExplainsCommands) {
        readmeDetails.push('주요 실행 옵션과 REPL 명령');
      }
      flowParts.push(`또한 \`README.md\`에는 ${this.joinNaturalKorean(readmeDetails)}이 정리되어 있습니다.`);
    }
    if (flowParts.length > 0) {
      paragraphs.push(flowParts.join(' '));
    }

    if (envVariables.length > 0) {
      paragraphs.push(`주요 환경 변수는 ${envVariables.map((item) => `\`${item}\``).join(', ')} 입니다.`);
    }

    if (cliFlags.length > 0) {
      paragraphs.push(
        `CLI에서 바로 바꿀 수 있는 옵션은 ${cliFlags.map((item) => `\`${item}\``).join(', ')} 입니다.`
      );
    }

    return paragraphs.join('\n\n');
  }

  private buildConfigNarrativeEnglish(
    configFiles: string[],
    envVariables: string[],
    cliFlags: string[],
    configFlow: string[]
  ): string {
    const paragraphs: string[] = [];
    const hasEnvDoc = configFlow.includes('.env.example documents the supported environment variables.');
    const loadsDotEnv = configFlow.includes(
      'src/index.ts loads .env values before building the runtime config.'
    );
    const buildsFromCli = configFlow.includes('src/index.ts builds the runtime config from CLI inputs.');
    const mergesDefaults = configFlow.includes('src/config.ts merges CLI flags with process.env defaults.');
    const readmeExplainsEnv = configFlow.includes('README.md explains how to create and use the .env file.');
    const readmeExplainsCommands = configFlow.includes(
      'README.md documents the main startup flags and REPL config commands.'
    );

    if (configFiles.length > 0) {
      paragraphs.push(`The main config-related files are ${this.formatDisplayPaths(configFiles).join(', ')}.`);
    }

    const flowParts: string[] = [];
    if (hasEnvDoc) {
      flowParts.push('`.env.example` lists the supported environment variables.');
    }
    if (loadsDotEnv && mergesDefaults) {
      flowParts.push(
        '`src/index.ts` loads `.env` values first, then `src/config.ts` combines CLI arguments and environment defaults into the runtime config.'
      );
    } else if (loadsDotEnv) {
      flowParts.push('`src/index.ts` loads `.env` values before runtime setup.');
    } else if (mergesDefaults || buildsFromCli) {
      flowParts.push('`src/config.ts` and `src/index.ts` build the runtime config from CLI input and defaults.');
    }
    if (readmeExplainsEnv || readmeExplainsCommands) {
      const readmeDetails: string[] = [];
      if (readmeExplainsEnv) {
        readmeDetails.push('how to create the `.env` file');
      }
      if (readmeExplainsCommands) {
        readmeDetails.push('the main startup flags and REPL commands');
      }
      flowParts.push(`\`README.md\` also documents ${this.joinNaturalEnglish(readmeDetails)}.`);
    }
    if (flowParts.length > 0) {
      paragraphs.push(flowParts.join(' '));
    }

    if (envVariables.length > 0) {
      paragraphs.push(
        `Key environment variables are ${envVariables.map((item) => `\`${item}\``).join(', ')}.`
      );
    }

    if (cliFlags.length > 0) {
      paragraphs.push(`CLI options you can change directly are ${cliFlags.map((item) => `\`${item}\``).join(', ')}.`);
    }

    return paragraphs.join('\n\n');
  }

  private buildDeterministicFallback(userInput: string): string | null {
    const preferred = this.getPreferredBootstrapResult(userInput);
    if (!preferred) {
      return null;
    }

    const metadata =
      preferred.result.metadata && typeof preferred.result.metadata === 'object'
        ? preferred.result.metadata
        : undefined;
    const korean = this.isLikelyKorean(userInput);

    if (preferred.toolName === 'summarize_project') {
      const packageName = this.getStringMetadata(metadata, 'packageName');
      const topLevelDirectories = this.getStringArrayMetadata(metadata, 'topLevelDirectories');
      const stack = this.getStringArrayMetadata(metadata, 'detectedStack');
      const keyFiles = this.getStringArrayMetadata(metadata, 'keyFiles');
      const recommendedNextFiles = this.getStringArrayMetadata(metadata, 'recommendedNextFiles');
      const candidates = this.getCandidateMetadata(metadata, 'entrypointCandidates');

      if (korean) {
        return this.buildProjectSummaryNarrativeKorean(
          packageName,
          topLevelDirectories,
          stack,
          keyFiles,
          recommendedNextFiles,
          candidates
        );
      }

      return [
        `${packageName ?? 'This project'} is currently identified as ${stack.join(', ') || 'a local code workspace'}.`,
        keyFiles.length > 0 ? `Key files: ${this.formatDisplayPaths(keyFiles).join(', ')}.` : '',
        candidates.length > 0
          ? `Entrypoint candidates: ${candidates
              .map((candidate) => `\`${this.normalizeDisplayPath(candidate.path)}\` (${candidate.reason})`)
              .join(', ')}.`
          : '',
        recommendedNextFiles.length > 0
          ? `Recommended next reads: ${this.formatDisplayPaths(recommendedNextFiles).join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (preferred.toolName === 'find_entrypoint') {
      const primaryEntrypoint = this.getStringMetadata(metadata, 'primaryEntrypoint');
      const supportingFiles = this.getStringArrayMetadata(metadata, 'supportingFiles');
      const evidence = this.getStringArrayMetadata(metadata, 'evidence');
      const flowSignals = this.getEntrypointFlowSignals(metadata);

      if (korean) {
        return this.buildEntrypointNarrativeKorean(
          primaryEntrypoint,
          supportingFiles,
          flowSignals,
          evidence
        );
      }

      return this.buildEntrypointNarrativeEnglish(
        primaryEntrypoint,
        supportingFiles,
        flowSignals,
        evidence
      );
    }

    if (preferred.toolName === 'summarize_config') {
      const configFiles = this.getStringArrayMetadata(metadata, 'configFiles');
      const envVariables = this.getStringArrayMetadata(metadata, 'envVariables');
      const cliFlags = this.getStringArrayMetadata(metadata, 'cliFlags');
      const configFlow = this.getStringArrayMetadata(metadata, 'configFlow');

      if (korean) {
        return this.buildConfigNarrativeKorean(configFiles, envVariables, cliFlags, configFlow);
      }

      return this.buildConfigNarrativeEnglish(configFiles, envVariables, cliFlags, configFlow);
    }

    return null;
  }

  async runTurn(userInput: string): Promise<string> {
    this.bootstrapResults.clear();
    this.history.push({
      role: 'user',
      content: userInput,
    });

    await this.maybeBootstrapStructureContext(userInput);
    await this.maybeBootstrapExplicitFileContext(userInput);
    await this.maybeBootstrapEntrypointContext(userInput);
    await this.maybeBootstrapConfigContext(userInput);

    let invalidResponseCount = 0;
    let ungroundedAnswerCount = 0;
    let styleRewriteCount = 0;
    let creationRefusalCount = 0;
    let creationNoToolCount = 0;
    const initialWritePatchCount = this.countToolResults('write_patch');

    for (let step = 1; step <= this.config.maxTurns; step += 1) {
      const rawResponse = await this.adapter.complete(this.buildMessages(), this.config);
      const envelope = parseAgentEnvelope(rawResponse);

      this.history.push({
        role: 'assistant',
        content: rawResponse,
      });

      if (envelope.type === 'message') {
        if (this.isInvalidFinalResponse(rawResponse)) {
          invalidResponseCount += 1;
          const fallback = this.buildDeterministicFallback(userInput);
          if (fallback && invalidResponseCount >= 2) {
            this.ui.log('Model kept returning invalid final responses. Returning deterministic fallback.');
            this.history.push({
              role: 'assistant',
              content: fallback,
            });
            return fallback;
          }

          this.ui.log('Model returned an invalid final response. Asking it to try again.');
          this.history.push({
            role: 'user',
            content: [
              'Your previous response was invalid.',
              'Do not fabricate TOOL RESULT blocks or pretend a tool already ran.',
              'If you need a tool, return a valid JSON tool_call.',
              'If you are ready to answer, return a JSON message with a plain-language answer based only on real tool outputs already provided.',
            ].join('\n'),
          });
          continue;
        }

        if (
          this.isSafeWorkspaceLocalCreationTask(userInput) &&
          this.looksLikeGenericRefusal(envelope.message)
        ) {
          creationRefusalCount += 1;

          if (creationRefusalCount >= 2) {
            const fallback = [
              'The model kept refusing a workspace-local file creation task even after clarification.',
              `Creating files and folders inside \`${this.config.workdir}\` is allowed.`,
              'Please retry the request or switch to a stronger model if this keeps happening.',
            ].join('\n');
            this.ui.log(
              'Model kept refusing a safe workspace-local creation task. Returning a corrective fallback.'
            );
            this.history.push({
              role: 'assistant',
              content: fallback,
            });
            return fallback;
          }

          this.ui.log(
            'Model refused a safe workspace-local creation task. Asking it to use write_patch.'
          );
          this.history.push({
            role: 'user',
            content: this.buildWorkspaceCreationRetryInstruction(),
          });
          continue;
        }

        if (
          this.isSafeWorkspaceLocalCreationTask(userInput) &&
          this.countToolResults('write_patch') === initialWritePatchCount &&
          this.looksLikeTaskCompletionClaim(envelope.message)
        ) {
          creationNoToolCount += 1;

          if (creationNoToolCount >= 2) {
            const fallback = [
              'The model claimed the files were created, but no successful write_patch call actually happened.',
              `Please retry the request inside \`${this.config.workdir}\`, or switch to a stronger model if this keeps happening.`,
            ].join('\n');
            this.ui.log(
              'Model claimed a workspace-local creation task was done without using write_patch. Returning a corrective fallback.'
            );
            this.history.push({
              role: 'assistant',
              content: fallback,
            });
            return fallback;
          }

          this.ui.log(
            'Model claimed a workspace-local creation task was done without using write_patch. Asking it to actually create the files.'
          );
          this.history.push({
            role: 'user',
            content: this.buildCreationToolUseRetryInstruction(),
          });
          continue;
        }

        if (
          this.requiresFileAnchoredAnswer(userInput) &&
          this.needsMoreGroundedAnswer(userInput, envelope.message)
        ) {
          ungroundedAnswerCount += 1;
          const fallback = this.buildDeterministicFallback(userInput);
          if (fallback && ungroundedAnswerCount >= 2) {
            this.ui.log('Model did not anchor the answer. Returning deterministic fallback.');
            this.history.push({
              role: 'assistant',
              content: fallback,
            });
            return fallback;
          }

          this.ui.log('Model answered without citing concrete files. Asking it to anchor the answer.');
          this.history.push({
            role: 'user',
            content: [
              'Your previous answer was too generic.',
              'Answer again using only the real tool outputs already in the conversation.',
              'You must mention the exact file paths you relied on.',
              'If you still do not have enough evidence, call another tool instead of guessing.',
            ].join('\n'),
          });
          continue;
        }

        if (this.isConfigQuestion(userInput) && this.looksLikeNumberedChecklist(envelope.message)) {
          styleRewriteCount += 1;
          const fallback = this.buildDeterministicFallback(userInput);
          if (fallback && styleRewriteCount >= 2) {
            this.ui.log('Model kept using a checklist style for config. Returning deterministic fallback.');
            this.history.push({
              role: 'assistant',
              content: fallback,
            });
            return fallback;
          }

          this.ui.log('Model answered with a checklist style. Asking it to rewrite naturally.');
          this.history.push({
            role: 'user',
            content: [
              'Rewrite the answer as short natural paragraphs.',
              'Do not use a numbered checklist.',
              'Keep the same concrete file references and real config details.',
            ].join('\n'),
          });
          continue;
        }

        if (
          this.isLikelyKorean(userInput) &&
          this.isStructureQuestion(userInput) &&
          this.containsRawEnglishSectionLabels(envelope.message)
        ) {
          styleRewriteCount += 1;
          const fallback = this.buildDeterministicFallback(userInput);
          if (fallback && styleRewriteCount >= 2) {
            this.ui.log('Model kept using raw English structure labels. Returning deterministic fallback.');
            this.history.push({
              role: 'assistant',
              content: fallback,
            });
            return fallback;
          }

          this.ui.log('Model used raw English structure labels. Asking it to rewrite naturally.');
          this.history.push({
            role: 'user',
            content: [
              'Rewrite the answer in natural Korean.',
              'Do not repeat raw headings like TOP-LEVEL FILES, KEY FILES, or ENTRYPOINT CANDIDATES.',
              'Keep the same real file references and project facts.',
            ].join('\n'),
          });
          continue;
        }

        if (
          this.isLikelyKorean(userInput) &&
          this.isConfigQuestion(userInput) &&
          this.containsAwkwardKoreanPhrase(envelope.message)
        ) {
          styleRewriteCount += 1;
          const fallback = this.buildDeterministicFallback(userInput);
          if (fallback && styleRewriteCount >= 2) {
            this.ui.log('Model kept using awkward Korean config phrasing. Returning deterministic fallback.');
            this.history.push({
              role: 'assistant',
              content: fallback,
            });
            return fallback;
          }

          this.ui.log('Model used awkward Korean config phrasing. Asking it to rewrite naturally.');
          this.history.push({
            role: 'user',
            content: [
              'Rewrite the answer in natural Korean.',
              'Avoid awkward phrases like "런타임 설정을 빌립니다".',
              'Keep the same concrete file references and config details.',
            ].join('\n'),
          });
          continue;
        }

        return envelope.message;
      }

      const tool = this.toolMap.get(envelope.tool);
      if (!tool) {
        this.history.push({
          role: 'user',
          content: formatToolResultForModel(envelope.tool, {
            ok: false,
            summary: `Unknown tool: ${envelope.tool}`,
            output: 'This tool does not exist in the current runtime.',
          }),
        });
        continue;
      }

      if (envelope.thinking) {
        this.ui.log(`Model reasoning: ${envelope.thinking}`);
      }

      const result = await this.executeTool(tool, envelope.arguments);
      this.ui.log(result.summary);

      this.history.push({
        role: 'user',
        content: formatToolResultForModel(tool.name, result),
      });
    }

    const fallback =
      'I reached the tool-loop limit for this request. Please refine the task or increase max turns.';

    this.history.push({
      role: 'assistant',
      content: fallback,
    });

    return fallback;
  }
}
