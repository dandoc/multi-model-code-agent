import { spawn, type ChildProcess } from 'node:child_process';

import type { AgentConfig, ChatMessage, ModelAdapter } from './types.js';

type ProviderFailureDiagnosis = {
  summary: string;
  likelyCauses: string[];
  nextSteps: string[];
  detail: string;
};

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
const PROVIDER_RETRY_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  const message = normalizeErrorMessage(error).toLowerCase();
  return includesAny(message, [
    'timed out',
    'timeout',
    'fetch failed',
    'networkerror',
    'econnrefused',
    'enotfound',
    'socket hang up',
    'ecanceled',
    'aborted',
  ]);
}

async function retryProviderRequest<T>(
  fn: (attempt: number) => Promise<T>,
  shouldRetryResult: (value: T) => boolean
): Promise<T> {
  let lastResult: T | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await fn(attempt);
      lastResult = result;
      if (!shouldRetryResult(result) || attempt === 2) {
        return result;
      }
      await sleep(PROVIDER_RETRY_DELAY_MS);
    } catch (error) {
      lastError = error;
      if (!isRetryableFetchError(error) || attempt === 2) {
        throw error;
      }
      await sleep(PROVIDER_RETRY_DELAY_MS);
    }
  }

  if (lastResult !== undefined) {
    return lastResult;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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

export async function terminateChildProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill('SIGKILL');
    } catch {}
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let finished = false;
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });

      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        try {
          child.kill();
        } catch {}
        resolve();
      };

      killer.on('error', finish);
      killer.on('close', finish);
    });
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {}
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
      void terminateChildProcessTree(child);
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

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function diagnoseOllamaFailure(message: string, config: AgentConfig): ProviderFailureDiagnosis {
  const lower = message.toLowerCase();

  if (includesAny(lower, ['fetch failed', 'econnrefused', 'connect econnrefused', 'networkerror'])) {
    return {
      summary: 'Ollama 서버에 연결하지 못했습니다.',
      likelyCauses: [
        'Ollama 앱이나 로컬 서버가 실행 중이 아닙니다.',
        `현재 base URL(${config.baseUrl})이 실제 Ollama 서버 주소와 다릅니다.`,
      ],
      nextSteps: [
        '로컬에서 `ollama list`가 동작하는지 확인하세요.',
        '`/models doctor`로 현재 provider 상태를 진단하세요.',
        `필요하면 \`/base-url ${config.baseUrl || 'http://127.0.0.1:11434'}\`를 다시 설정하세요.`,
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['model', 'not found'])) {
    return {
      summary: '요청한 Ollama 모델을 찾지 못했습니다.',
      likelyCauses: [
        `현재 설정된 모델(${config.model || '(provider default)'})이 로컬에 설치되어 있지 않습니다.`,
      ],
      nextSteps: [
        '`/models ollama`로 설치된 로컬 모델 목록을 확인하세요.',
        `필요하면 \`ollama pull ${config.model || 'qwen2.5-coder:7b'}\`를 실행하거나 \`/model\`로 다른 모델로 바꾸세요.`,
      ],
      detail: message,
    };
  }

  return {
    summary: 'Ollama 요청 처리 중 오류가 발생했습니다.',
    likelyCauses: [
      '로컬 서버 상태, 모델 이름, 또는 응답 형식에 문제가 있을 수 있습니다.',
    ],
    nextSteps: [
      '`/models doctor`로 현재 상태를 확인하세요.',
      '`/models ollama`로 설치된 모델과 현재 모델 이름을 다시 확인하세요.',
    ],
    detail: message,
  };
}

function diagnoseOpenAIFailure(message: string, config: AgentConfig): ProviderFailureDiagnosis {
  const lower = message.toLowerCase();

  if (includesAny(lower, ['requires an api key', 'openai_api_key is required', 'api key is configured'])) {
    return {
      summary: 'OpenAI-compatible 공급자에 API key가 없습니다.',
      likelyCauses: ['현재 세션 또는 .env에 OPENAI_API_KEY가 설정되지 않았습니다.'],
      nextSteps: [
        '`/api-key <value>`로 현재 세션에 키를 넣으세요.',
        '또는 `.env`의 `OPENAI_API_KEY`를 설정한 뒤 다시 실행하세요.',
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['requires a model name', 'no explicit model is set'])) {
    return {
      summary: 'OpenAI-compatible 공급자에 모델 이름이 설정되지 않았습니다.',
      likelyCauses: ['현재 runtime에 model이 비어 있습니다.'],
      nextSteps: [
        '`/models openai`로 live 모델 목록을 확인하세요.',
        '`/model <name>`으로 사용할 모델을 지정하세요.',
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['401', '403', 'unauthorized', 'forbidden', 'invalid_api_key'])) {
    return {
      summary: 'OpenAI-compatible 인증에 실패했습니다.',
      likelyCauses: [
        'API key가 없거나 잘못되었습니다.',
        'base URL은 맞지만 계정/권한이 해당 모델을 허용하지 않을 수 있습니다.',
      ],
      nextSteps: [
        '`/models doctor`로 base URL과 API key 상태를 점검하세요.',
        '다른 키를 `/api-key`로 다시 넣거나 모델 이름을 바꿔 보세요.',
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['404', 'not found'])) {
    return {
      summary: 'OpenAI-compatible 엔드포인트나 모델 경로를 찾지 못했습니다.',
      likelyCauses: [
        `base URL(${config.baseUrl})이 OpenAI-compatible 경로 형식과 맞지 않을 수 있습니다.`,
        `현재 모델(${config.model || '(empty)'})이 공급자에서 지원되지 않을 수 있습니다.`,
      ],
      nextSteps: [
        '`/models doctor`와 `/models openai`로 엔드포인트/모델 상태를 확인하세요.',
        '`/base-url <https://.../v1>` 형식인지 확인하세요.',
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['timeout', 'fetch failed', 'networkerror', 'econnrefused', 'enotfound'])) {
    return {
      summary: 'OpenAI-compatible 엔드포인트에 도달하지 못했습니다.',
      likelyCauses: [
        '네트워크 문제나 base URL 오타가 있을 수 있습니다.',
        '공급자 서버가 일시적으로 응답하지 않을 수 있습니다.',
      ],
      nextSteps: [
        '`/models doctor`로 live endpoint 상태를 확인하세요.',
        '`/base-url`이 정확한지 다시 확인하세요.',
      ],
      detail: message,
    };
  }

  return {
    summary: 'OpenAI-compatible 요청 처리 중 오류가 발생했습니다.',
    likelyCauses: ['인증, base URL, 모델 이름, 또는 네트워크 상태에 문제가 있을 수 있습니다.'],
    nextSteps: [
      '`/models doctor`로 현재 공급자 상태를 점검하세요.',
      '`/models openai`로 모델 목록과 현재 설정을 다시 확인하세요.',
    ],
    detail: message,
  };
}

function diagnoseCodexFailure(message: string, config: AgentConfig): ProviderFailureDiagnosis {
  const lower = message.toLowerCase();

  if (includesAny(lower, ['requires a logged-in codex cli session', 'run `codex login`'])) {
    return {
      summary: 'Codex CLI 로그인 상태가 준비되지 않았습니다.',
      likelyCauses: ['이 환경에서 `codex login`이 아직 끝나지 않았거나 세션이 만료되었습니다.'],
      nextSteps: [
        '`codex login`을 실행하고 ChatGPT로 로그인하세요.',
        '`/models doctor`로 Codex 로그인 상태를 다시 확인하세요.',
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['failed to start codex cli', 'not recognized', 'enoent'])) {
    return {
      summary: 'Codex CLI 자체를 실행하지 못했습니다.',
      likelyCauses: ['이 셸에서 `codex` 명령을 찾지 못했습니다.'],
      nextSteps: [
        'Codex CLI가 설치되어 있는지 확인하세요.',
        '새 터미널을 열어 PATH를 다시 적용한 뒤 `/models doctor`를 실행하세요.',
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['timed out twice', 'request timed out'])) {
    return {
      summary: 'Codex 요청이 시간 안에 끝나지 않았습니다.',
      likelyCauses: [
        '요청 범위가 너무 크거나 현재 모델이 느릴 수 있습니다.',
        `현재 workdir(${config.workdir})에서 읽어야 할 범위가 넓을 수 있습니다.`,
      ],
      nextSteps: [
        '질문 범위를 더 좁혀 보세요.',
        '더 빠른 모델로 바꾸거나 `/max-turns`를 줄여 보세요.',
      ],
      detail: message,
    };
  }

  if (includesAny(lower, ['returned no assistant message'])) {
    return {
      summary: 'Codex CLI가 usable한 assistant 응답을 돌려주지 않았습니다.',
      likelyCauses: ['Codex CLI 출력 형식이 예상과 다르거나 현재 CLI 버전과 맞지 않을 수 있습니다.'],
      nextSteps: [
        '같은 요청을 한 번 더 시도하세요.',
        '계속 반복되면 Codex CLI 버전과 로그인 상태를 다시 확인하세요.',
      ],
      detail: message,
    };
  }

  return {
    summary: 'Codex CLI 요청 처리 중 오류가 발생했습니다.',
    likelyCauses: ['CLI 상태, 로그인 상태, 모델 선택, 또는 응답 시간 문제일 수 있습니다.'],
    nextSteps: [
      '`/models doctor`로 Codex 준비 상태를 확인하세요.',
      '반복되면 더 작은 요청으로 나눠서 다시 시도하세요.',
    ],
    detail: message,
  };
}

export function diagnoseProviderFailure(
  config: AgentConfig,
  error: unknown
): ProviderFailureDiagnosis {
  const message = normalizeErrorMessage(error);

  if (config.provider === 'ollama') {
    return diagnoseOllamaFailure(message, config);
  }

  if (config.provider === 'openai') {
    return diagnoseOpenAIFailure(message, config);
  }

  return diagnoseCodexFailure(message, config);
}

class OllamaAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;

  async complete(messages: ChatMessage[], config: AgentConfig): Promise<string> {
    const response = await retryProviderRequest(
      async () =>
        await fetch(`${config.baseUrl}/api/chat`, {
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
        }),
      (candidate) => !candidate.ok && isRetryableHttpStatus(candidate.status)
    );

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

    const response = await retryProviderRequest(
      async () =>
        await fetch(`${config.baseUrl}/chat/completions`, {
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
        }),
      (candidate) => !candidate.ok && isRetryableHttpStatus(candidate.status)
    );

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

export async function getCodexLoginStatus(config: AgentConfig): Promise<{
  available: boolean;
  loggedIn: boolean;
  detail: string;
}> {
  try {
    const status = await runCodexCommand(['login', 'status'], '', config, CODEX_LOGIN_TIMEOUT_MS);
    const detail = `${status.stdout}\n${status.stderr}`.trim() || 'No status output.';
    return {
      available: true,
      loggedIn: status.code === 0 && /Logged in/i.test(detail),
      detail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Failed to start codex CLI/i.test(message)) {
      return {
        available: false,
        loggedIn: false,
        detail: message,
      };
    }

    return {
      available: true,
      loggedIn: false,
      detail: message,
    };
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
