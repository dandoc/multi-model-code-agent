import type { AgentEnvelope, ToolExecutionResult, ToolName } from './types.js';

function extractFencedJson(text: string): string | null {
  const match = text.match(/```(?:[A-Za-z0-9_-]+)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractBalancedJson(text: string): string | null {
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === '{' || char === '[') {
        start = index;
        stack.push(char);
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      stack.push(char);
      continue;
    }

    if (char === '[') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']') {
      const opening = stack.at(-1);
      if (
        (char === '}' && opening === '{') ||
        (char === ']' && opening === '[')
      ) {
        stack.pop();
      }

      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function isToolName(value: unknown): value is ToolName {
  return (
    value === 'summarize_project' ||
    value === 'find_entrypoint' ||
    value === 'summarize_config' ||
    value === 'list_files' ||
    value === 'read_file' ||
    value === 'read_multiple_files' ||
    value === 'search_files' ||
    value === 'write_patch' ||
    value === 'run_files' ||
    value === 'run_shell'
  );
}

function maybeDecodeQuotedString(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed;
  }

  const body = trimmed.slice(1, -1);
  return body
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function stripTrailingCommas(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < value.length && /\s/.test(value[lookahead] ?? '')) {
        lookahead += 1;
      }

      if (value[lookahead] === '}' || value[lookahead] === ']') {
        continue;
      }
    }

    result += char;
  }

  return result;
}

function tryParseJsonValue(text: string): unknown | null {
  const candidates = [text, stripTrailingCommas(text)].filter(
    (candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

function parseObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const cleaned = value.trim();
  if (!cleaned) {
    return null;
  }

  const candidate = extractFencedJson(cleaned) ?? extractBalancedJson(cleaned) ?? cleaned;
  const parsed = tryParseJsonValue(candidate);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  return null;
}

function buildToolCallEnvelope(
  toolValue: unknown,
  argsValue: unknown,
  thinking?: unknown
): AgentEnvelope | null {
  if (!isToolName(toolValue)) {
    return null;
  }

  const argumentsObject = parseObjectLike(argsValue);
  if (!argumentsObject) {
    return null;
  }

  return {
    type: 'tool_call',
    tool: toolValue,
    arguments: argumentsObject,
    thinking: typeof thinking === 'string' ? thinking : undefined,
  };
}

function extractJsonishMessage(cleaned: string): string | null {
  if (!/"type"\s*:\s*"message"/.test(cleaned)) {
    return null;
  }

  const keyIndex = cleaned.indexOf('"message"');
  if (keyIndex === -1) {
    return null;
  }

  const colonIndex = cleaned.indexOf(':', keyIndex);
  if (colonIndex === -1) {
    return null;
  }

  let value = cleaned.slice(colonIndex + 1).trim();
  if (value.endsWith('}')) {
    value = value.slice(0, -1).trim();
  }
  if (value.endsWith(',')) {
    value = value.slice(0, -1).trim();
  }

  return maybeDecodeQuotedString(value);
}

function parseEnvelopeCandidate(candidate: string): AgentEnvelope | null {
  const parsed = tryParseJsonValue(candidate);
  if (parsed === null) {
    return null;
  }

  if (Array.isArray(parsed) && parsed.length === 1) {
    const first = parsed[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return parseEnvelopeRecord(first as Record<string, unknown>);
    }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parseEnvelopeRecord(parsed as Record<string, unknown>);
  }

  return null;
}

function parseEnvelopeRecord(parsed: Record<string, unknown>): AgentEnvelope | null {
  if (parsed.type === 'message' && parsed.message !== undefined) {
    if (typeof parsed.message === 'string') {
      return {
        type: 'message',
        message: parsed.message,
      };
    }

    return {
      type: 'message',
      message: JSON.stringify(parsed.message, null, 2),
    };
  }

  const directToolCall =
    buildToolCallEnvelope(parsed.tool, parsed.arguments ?? parsed.input ?? parsed.args, parsed.thinking) ??
    buildToolCallEnvelope(parsed.type, parsed.arguments ?? parsed.input ?? parsed.args, parsed.thinking) ??
    buildToolCallEnvelope(parsed.name, parsed.arguments ?? parsed.input ?? parsed.args, parsed.thinking);
  if (directToolCall) {
    return directToolCall;
  }

  const functionCall = parseObjectLike(parsed.function_call);
  if (functionCall) {
    const functionEnvelope = buildToolCallEnvelope(
      functionCall.name,
      functionCall.arguments ?? functionCall.input ?? functionCall.args,
      parsed.thinking
    );
    if (functionEnvelope) {
      return functionEnvelope;
    }
  }

  if (Array.isArray(parsed.tool_calls)) {
    for (const item of parsed.tool_calls) {
      const toolCall = parseObjectLike(item);
      if (!toolCall) {
        continue;
      }

      const nestedFunction = parseObjectLike(toolCall.function);
      const nestedEnvelope =
        buildToolCallEnvelope(
          nestedFunction?.name ?? toolCall.name,
          nestedFunction?.arguments ?? nestedFunction?.input ?? toolCall.arguments ?? toolCall.input,
          parsed.thinking
        ) ??
        buildToolCallEnvelope(
          toolCall.tool,
          toolCall.arguments ?? toolCall.input ?? toolCall.args,
          parsed.thinking
        );
      if (nestedEnvelope) {
        return nestedEnvelope;
      }
    }
  }

  if (isToolName(parsed.type)) {
    const { type, thinking, tool, name, function_call, tool_calls, arguments: _arguments, input: _input, args: _args, ...rest } = parsed;
    return {
      type: 'tool_call',
      tool: type,
      arguments: rest as Record<string, unknown>,
      thinking: typeof thinking === 'string' ? thinking : undefined,
    };
  }

  return null;
}

export function parseAgentEnvelope(rawText: string): AgentEnvelope {
  const cleaned = rawText.trim();
  const candidates = [
    extractFencedJson(cleaned),
    extractBalancedJson(cleaned),
    cleaned,
  ].filter((candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const envelope = parseEnvelopeCandidate(candidate);
    if (envelope) {
      return envelope;
    }

    const jsonishMessage = extractJsonishMessage(candidate);
    if (jsonishMessage !== null) {
      return {
        type: 'message',
        message: jsonishMessage,
      };
    }
  }

  return {
    type: 'message',
    message: cleaned,
  };
}

export function formatToolResultForModel(tool: ToolName, result: ToolExecutionResult): string {
  const lines = [
    `TOOL RESULT: ${tool}`,
    `OK: ${result.ok}`,
    `SUMMARY: ${result.summary}`,
    'OUTPUT:',
    result.output,
    result.metadata ? `METADATA: ${JSON.stringify(result.metadata, null, 2)}` : '',
  ];

  if (tool === 'search_files') {
    lines.push(
      'GUIDANCE: If the user wants an explanation or summary, inspect the most relevant matching files before giving the final answer.'
    );
  }

  return lines
    .filter(Boolean)
    .join('\n');
}
