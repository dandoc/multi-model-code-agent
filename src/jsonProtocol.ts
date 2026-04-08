import type { AgentEnvelope, ToolExecutionResult, ToolName } from './types.js';

function extractFencedJson(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractBalancedJson(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
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
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
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

export function parseAgentEnvelope(rawText: string): AgentEnvelope {
  const cleaned = rawText.trim();
  const candidate = extractFencedJson(cleaned) ?? extractBalancedJson(cleaned);

  if (!candidate) {
    return {
      type: 'message',
      message: cleaned || 'No response returned by the model.',
    };
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;

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

    if (
      parsed.type === 'tool_call' &&
      isToolName(parsed.tool) &&
      parsed.arguments &&
      typeof parsed.arguments === 'object' &&
      !Array.isArray(parsed.arguments)
    ) {
      return {
        type: 'tool_call',
        tool: parsed.tool,
        arguments: parsed.arguments as Record<string, unknown>,
        thinking: typeof parsed.thinking === 'string' ? parsed.thinking : undefined,
      };
    }

    if (
      isToolName(parsed.type) &&
      parsed.arguments &&
      typeof parsed.arguments === 'object' &&
      !Array.isArray(parsed.arguments)
    ) {
      return {
        type: 'tool_call',
        tool: parsed.type,
        arguments: parsed.arguments as Record<string, unknown>,
        thinking: typeof parsed.thinking === 'string' ? parsed.thinking : undefined,
      };
    }

    if (
      isToolName(parsed.type) &&
      parsed.input &&
      typeof parsed.input === 'object' &&
      !Array.isArray(parsed.input)
    ) {
      return {
        type: 'tool_call',
        tool: parsed.type,
        arguments: parsed.input as Record<string, unknown>,
        thinking: typeof parsed.thinking === 'string' ? parsed.thinking : undefined,
      };
    }

    if (isToolName(parsed.type)) {
      const { type, thinking, ...rest } = parsed;
      return {
        type: 'tool_call',
        tool: type,
        arguments: rest as Record<string, unknown>,
        thinking: typeof thinking === 'string' ? thinking : undefined,
      };
    }
  } catch {
    const jsonishMessage = extractJsonishMessage(candidate ?? cleaned);
    if (jsonishMessage !== null) {
      return {
        type: 'message',
        message: jsonishMessage,
      };
    }

    return {
      type: 'message',
      message: cleaned,
    };
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
