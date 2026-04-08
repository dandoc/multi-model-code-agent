import { spawn } from 'node:child_process';

import type { AgentConfig, ChatMessage, ModelAdapter } from './types.js';

function coerceOpenAIContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (
          part &&
          typeof part === 'object' &&
          'type' in part &&
          'text' in part &&
          (part as { type?: unknown }).type === 'text'
        ) {
          return String((part as { text: unknown }).text);
        }

        return '';
      })
      .join('');
  }

  return '';
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

interface CodexExecEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

const CODEX_LOGIN_TIMEOUT_MS = 15_000;
const CODEX_REQUEST_TIMEOUT_MS = 120_000;
const CODEX_RETRY_TIMEOUT_MS = 180_000;

function getCodexCommand(): string {
  return 'codex';
}

function getCodexEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_ORG_ID;
  delete env.OPENAI_PROJECT;
  return env;
}

function renderCodexPrompt(messages: ChatMessage[]): string {
  const sections = messages.map(
    (message) =>
      `<<${message.role.toUpperCase()}>>\n${message.content.trim()}\n<</${message.role.toUpperCase()}>>`
  );

  return [
    'You are acting as the model backend for another coding agent.',
    'The transcript below already contains the real system prompt and the conversation state.',
    'Follow the SYSTEM message exactly.',
    'Do not inspect files, do not run shell commands, and do not use Codex CLI tools yourself.',
    'If the transcript asks for a tool call, return the requested JSON object as plain text.',
    'Return only the assistant\'s next reply text with no markdown fences.',
    '',
    'Conversation transcript:',
    ...sections,
    '',
    'Assistant reply:',
  ].join('\n');
}

function extractCodexMessage(stdout: string): string {
  let lastAgentMessage = '';

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    try {
      const event = JSON.parse(line) as CodexExecEvent;
      const item =
        event.item && typeof event.item === 'object'
          ? (event.item as { type?: unknown; text?: unknown })
          : null;
      if (
        event.type === 'item.completed' &&
        item?.type === 'agent_message' &&
        typeof item.text === 'string'
      ) {
        lastAgentMessage = item.text;
      }
    } catch {
      continue;
    }
  }

  return lastAgentMessage.trim();
}

async function runCodexCommand(
  args: string[],
  input: string,
  config: AgentConfig,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const command = getCodexCommand();
    const child = spawn(
      process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command,
      process.platform === 'win32' ? ['/d', '/s', '/c', command, ...args] : args,
      {
        cwd: config.workdir,
        env: getCodexEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: { code: number | null; stdout: string; stderr: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error('Codex CLI request timed out.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`Failed to start codex CLI: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });

    child.stdin.end(input);
  });
}

async function ensureCodexLogin(config: AgentConfig): Promise<void> {
  const status = await runCodexCommand(['login', 'status'], '', config, CODEX_LOGIN_TIMEOUT_MS);
  const combined = `${status.stdout}\n${status.stderr}`.trim();

  if (status.code !== 0 || !/Logged in/i.test(combined)) {
    throw new Error(
      'The codex provider requires a logged-in Codex CLI session. Run `codex login` and sign in with ChatGPT first.'
    );
  }
}

function isCodexTimeoutError(error: unknown): boolean {
  return error instanceof Error && /Codex CLI request timed out/i.test(error.message);
}

class OllamaAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;

  async complete(messages: ChatMessage[], config: AgentConfig): Promise<string> {
    const response = await fetch(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages,
        options: {
          temperature: config.temperature,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama request failed (${response.status}): ${await readErrorBody(response)}`
      );
    }

    const payload = (await response.json()) as {
      message?: { content?: string };
    };

    return payload.message?.content?.trim() || '';
  }
}

class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider = 'openai' as const;

  async complete(messages: ChatMessage[], config: AgentConfig): Promise<string> {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is required for the openai provider.');
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible request failed (${response.status}): ${await readErrorBody(response)}`
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: unknown;
        };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    return coerceOpenAIContent(content).trim();
  }
}

class CodexCliAdapter implements ModelAdapter {
  readonly provider = 'codex' as const;

  async complete(messages: ChatMessage[], config: AgentConfig): Promise<string> {
    await ensureCodexLogin(config);

    const args = [
      'exec',
      '-C',
      config.workdir,
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--json',
    ];

    if (config.model.trim()) {
      args.push('-m', config.model.trim());
    }

    args.push('-');

    const prompt = renderCodexPrompt(messages);
    let result: { code: number | null; stdout: string; stderr: string };

    try {
      result = await runCodexCommand(args, prompt, config, CODEX_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (!isCodexTimeoutError(error)) {
        throw error;
      }

      try {
        result = await runCodexCommand(args, prompt, config, CODEX_RETRY_TIMEOUT_MS);
      } catch (retryError) {
        if (isCodexTimeoutError(retryError)) {
          throw new Error(
            'Codex CLI request timed out twice. Try again, switch to a faster model, or narrow the request.'
          );
        }
        throw retryError;
      }
    }

    if (result.code !== 0) {
      const details = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
      throw new Error(`Codex CLI request failed (${result.code}): ${details}`);
    }

    const message = extractCodexMessage(result.stdout);
    if (!message) {
      throw new Error('Codex CLI returned no assistant message.');
    }

    return message;
  }
}

export function createModelAdapter(config: AgentConfig): ModelAdapter {
  if (config.provider === 'openai') {
    return new OpenAICompatibleAdapter();
  }

  if (config.provider === 'codex') {
    return new CodexCliAdapter();
  }

  return new OllamaAdapter();
}
