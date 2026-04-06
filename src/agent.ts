import { formatToolResultForModel, parseAgentEnvelope } from './jsonProtocol.js';
import { buildSystemPrompt } from './prompt.js';

import type { AgentConfig, ChatMessage, ModelAdapter, ToolDefinition, ToolExecutionResult } from './types.js';

interface AgentUI {
  confirm: (message: string) => Promise<boolean>;
  log: (message: string) => void;
}

export class AgentRunner {
  private history: ChatMessage[] = [];
  private toolMap: Map<ToolDefinition['name'], ToolDefinition>;

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
    return /project structure|directory structure|architecture|entrypoint|entry point|file layout|구조|아키텍처|엔트리포인트|프로젝트 요약/i.test(
      userInput
    );
  }

  private async executeTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const needsApproval = tool.requiresApproval && !this.config.autoApprove;

    if (needsApproval) {
      const approved = await this.ui.confirm(
        `Approve ${tool.name} with arguments ${JSON.stringify(args)}?`
      );

      if (!approved) {
        return {
          ok: false,
          summary: `${tool.name} was denied by the user.`,
          output: 'The user denied this tool call. Choose a safer alternative or explain what you need.',
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

  private async maybeBootstrapStructureContext(userInput: string): Promise<void> {
    if (!this.isStructureQuestion(userInput)) {
      return;
    }

    const listFilesTool = this.toolMap.get('list_files');
    if (!listFilesTool) {
      return;
    }

    this.ui.log('Bootstrapping structure context with list_files...');
    const result = await this.executeTool(listFilesTool, {
      path: '.',
      maxDepth: 2,
      maxEntries: 160,
      includeFiles: true,
      includeDirectories: true,
    });

    this.history.push({
      role: 'user',
      content: [
        'Structure bootstrap for the current workspace.',
        'Use this real file tree instead of guessing.',
        formatToolResultForModel('list_files', result),
      ].join('\n\n'),
    });
  }

  async runTurn(userInput: string): Promise<string> {
    this.history.push({
      role: 'user',
      content: userInput,
    });

    await this.maybeBootstrapStructureContext(userInput);

    for (let step = 1; step <= this.config.maxTurns; step += 1) {
      const rawResponse = await this.adapter.complete(this.buildMessages(), this.config);
      const envelope = parseAgentEnvelope(rawResponse);

      this.history.push({
        role: 'assistant',
        content: rawResponse,
      });

      if (envelope.type === 'message') {
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
