import { formatToolResultForModel, parseAgentEnvelope } from './jsonProtocol.js';
import { buildSystemPrompt } from './prompt.js';

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
      const approved = await this.ui.confirm(
        `Approve ${tool.name} with arguments ${JSON.stringify(args)}?`
      );

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
      'Use this deterministic project summary instead of guessing.'
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
      'Use this deterministic entrypoint analysis to explain how the project starts and runs.'
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
      'Use this deterministic config summary instead of guessing.'
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
      const stack = this.getStringArrayMetadata(metadata, 'detectedStack');
      const keyFiles = this.getStringArrayMetadata(metadata, 'keyFiles');
      const recommendedNextFiles = this.getStringArrayMetadata(metadata, 'recommendedNextFiles');
      const candidates = this.getCandidateMetadata(metadata, 'entrypointCandidates');

      if (korean) {
        return [
          `${packageName ? `\`${packageName}\`` : '\uC774 \uD504\uB85C\uC81D\uD2B8'}\uB294 ${
            stack.length > 0 ? stack.join(', ') : '\uC18C\uC2A4 \uCF54\uB4DC'
          } \uAE30\uBC18 \uAD6C\uC870\uC785\uB2C8\uB2E4.`,
          keyFiles.length > 0
            ? `\uD575\uC2EC \uD30C\uC77C\uC740 ${this.formatDisplayPaths(keyFiles).join(', ')} \uC785\uB2C8\uB2E4.`
            : '\uD575\uC2EC \uD30C\uC77C\uC740 \uC544\uC9C1 \uC815\uB9AC\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.',
          candidates.length > 0
            ? `\uC5D4\uD2B8\uB9AC\uD3EC\uC778\uD2B8 \uD6C4\uBCF4\uB294 ${candidates
                .map((candidate) => `\`${this.normalizeDisplayPath(candidate.path)}\`(${candidate.reason})`)
                .join(', ')} \uC785\uB2C8\uB2E4.`
            : '\uC5D4\uD2B8\uB9AC\uD3EC\uC778\uD2B8 \uD6C4\uBCF4\uB294 \uC544\uC9C1 \uBA85\uD655\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.',
          recommendedNextFiles.length > 0
            ? `\uB2E4\uC74C\uC5D0 \uC77D\uC744 \uD30C\uC77C\uC740 ${this.formatDisplayPaths(recommendedNextFiles).join(', ')} \uC785\uB2C8\uB2E4.`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
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
      const supportingSet = new Set(supportingFiles.map((file) => this.normalizeDisplayPath(file)));
      const flowStepsKorean = [
        primaryEntrypoint ? `\`${this.normalizeDisplayPath(primaryEntrypoint)}\`\uC5D0\uC11C \uC2DC\uC791\uD569\uB2C8\uB2E4.` : '',
        supportingSet.has('src/env.ts')
          ? '\uADF8 \uB2E4\uC74C `src/env.ts`\uC5D0\uC11C `.env` \uAC12\uC744 \uBD88\uB7EC\uC635\uB2C8\uB2E4.'
          : '',
        supportingSet.has('src/config.ts')
          ? '`src/config.ts`\uC5D0\uC11C CLI \uC785\uB825\uACFC \uD658\uACBD \uBCC0\uC218\uB97C \uD569\uCCD0 \uC2E4\uD589 \uC124\uC815\uC744 \uB9CC\uB4ED\uB2C8\uB2E4.'
          : '',
        supportingSet.has('src/modelAdapters.ts')
          ? '`src/modelAdapters.ts`\uC5D0\uC11C \uC120\uD0DD\uD55C \uBAA8\uB378 \uC5B4\uB311\uD130\uB97C \uC0DD\uC131\uD569\uB2C8\uB2E4.'
          : '',
        supportingSet.has('src/tools.ts')
          ? '`src/tools.ts`\uC5D0\uC11C \uC0AC\uC6A9 \uAC00\uB2A5\uD55C \uD234\uC744 \uB4F1\uB85D\uD569\uB2C8\uB2E4.'
          : '',
        supportingSet.has('src/agent.ts')
          ? '\uB9C8\uC9C0\uB9C9\uC73C\uB85C `src/agent.ts`\uC758 \uC5D0\uC774\uC804\uD2B8 \uB8E8\uD504\uAC00 \uC0AC\uC6A9\uC790 \uC694\uCCAD\uC744 \uCC98\uB9AC\uD569\uB2C8\uB2E4.'
          : '',
      ].filter(Boolean);
      const flowStepsEnglish = [
        primaryEntrypoint ? `Start from \`${this.normalizeDisplayPath(primaryEntrypoint)}\`.` : '',
        supportingSet.has('src/env.ts') ? 'Load environment variables in `src/env.ts`.' : '',
        supportingSet.has('src/config.ts')
          ? 'Build runtime configuration in `src/config.ts`.'
          : '',
        supportingSet.has('src/modelAdapters.ts')
          ? 'Create the selected model adapter in `src/modelAdapters.ts`.'
          : '',
        supportingSet.has('src/tools.ts') ? 'Register the tools in `src/tools.ts`.' : '',
        supportingSet.has('src/agent.ts') ? 'Hand requests to the agent loop in `src/agent.ts`.' : '',
      ].filter(Boolean);

      if (korean) {
        return [
          primaryEntrypoint
            ? `\uAC00\uC7A5 \uC720\uB825\uD55C \uC9C4\uC785\uC810\uC740 \`${this.normalizeDisplayPath(primaryEntrypoint)}\` \uC785\uB2C8\uB2E4.`
            : '\uBA85\uD655\uD55C \uC9C4\uC785\uC810\uC744 \uC544\uC9C1 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.',
          evidence.length > 0
            ? `\uADFC\uAC70\uB294 ${evidence.map((item) => `\`${item}\``).join(', ')} \uC785\uB2C8\uB2E4.`
            : '',
          supportingFiles.length > 0
            ? `\uD568\uAED8 \uBCF4\uBA74 \uC88B\uC740 \uD30C\uC77C\uC740 ${this.formatDisplayPaths(supportingFiles).join(', ')} \uC785\uB2C8\uB2E4.`
            : '',
          flowStepsKorean.length > 0
            ? `\uC2E4\uD589 \uD750\uB984\uC740 ${flowStepsKorean.join(' ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      }

      return [
        primaryEntrypoint ? `The most likely entrypoint is \`${this.normalizeDisplayPath(primaryEntrypoint)}\`.` : '',
        evidence.length > 0 ? `Evidence: ${evidence.map((item) => `\`${item}\``).join(', ')}.` : '',
        supportingFiles.length > 0
          ? `Supporting files: ${this.formatDisplayPaths(supportingFiles).join(', ')}.`
          : '',
        flowStepsEnglish.length > 0 ? `Startup flow: ${flowStepsEnglish.join(' ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (preferred.toolName === 'summarize_config') {
      const configFiles = this.getStringArrayMetadata(metadata, 'configFiles');
      const envVariables = this.getStringArrayMetadata(metadata, 'envVariables');
      const cliFlags = this.getStringArrayMetadata(metadata, 'cliFlags');
      const configFlow = this.getStringArrayMetadata(metadata, 'configFlow');

      if (korean) {
        return [
          configFiles.length > 0
            ? `\uC124\uC815 \uAD00\uB828 \uD575\uC2EC \uD30C\uC77C\uC740 ${this.formatDisplayPaths(configFiles).join(', ')} \uC785\uB2C8\uB2E4.`
            : '\uC124\uC815 \uAD00\uB828 \uD30C\uC77C\uC744 \uC544\uC9C1 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.',
          envVariables.length > 0
            ? `\uD658\uACBD \uBCC0\uC218\uB294 ${envVariables.map((item) => `\`${item}\``).join(', ')} \uC785\uB2C8\uB2E4.`
            : '',
          cliFlags.length > 0
            ? `CLI \uD50C\uB798\uADF8\uB294 ${cliFlags.map((item) => `\`${item}\``).join(', ')} \uC785\uB2C8\uB2E4.`
            : '',
          configFlow.length > 0
            ? `\uC124\uC815 \uD750\uB984\uC740 ${configFlow.join(' ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      }

      return [
        configFiles.length > 0 ? `Config files: ${this.formatDisplayPaths(configFiles).join(', ')}.` : '',
        envVariables.length > 0
          ? `Environment variables: ${envVariables.map((item) => `\`${item}\``).join(', ')}.`
          : '',
        cliFlags.length > 0 ? `CLI flags: ${cliFlags.map((item) => `\`${item}\``).join(', ')}.` : '',
        configFlow.length > 0 ? `Config flow: ${configFlow.join(' ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
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
