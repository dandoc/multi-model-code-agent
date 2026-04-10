export type ModelProvider = 'ollama' | 'openai' | 'codex';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AgentConfig {
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  apiKey?: string;
  workdir: string;
  autoApprove: boolean;
  maxTurns: number;
  temperature: number;
  requestTimeoutMs?: number;
}

export type ToolName =
  | 'summarize_project'
  | 'find_entrypoint'
  | 'summarize_config'
  | 'list_files'
  | 'read_file'
  | 'read_multiple_files'
  | 'search_files'
  | 'write_patch'
  | 'run_files'
  | 'run_shell';

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  config: AgentConfig;
  confirm: (message: string) => Promise<boolean>;
  log: (message: string) => void;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputShape: string;
  requiresApproval: boolean;
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>;
}

export interface AssistantEnvelope {
  type: 'message';
  message: string;
}

export interface ToolCallEnvelope {
  type: 'tool_call';
  tool: ToolName;
  arguments: Record<string, unknown>;
  thinking?: string;
}

export type AgentEnvelope = AssistantEnvelope | ToolCallEnvelope;

export interface ModelAdapter {
  readonly provider: ModelProvider;
  complete: (messages: ChatMessage[], config: AgentConfig) => Promise<string>;
}

export interface ParsedCliInput {
  config: AgentConfig;
  prompt?: string;
  showHelp: boolean;
  showVersion: boolean;
}
