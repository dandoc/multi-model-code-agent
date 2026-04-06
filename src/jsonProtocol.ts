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
    value === 'list_files' ||
    value === 'read_file' ||
    value === 'search_files' ||
    value === 'write_patch' ||
    value === 'run_shell'
  );
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
  } catch {
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
  return [
    `TOOL RESULT: ${tool}`,
    `OK: ${result.ok}`,
    `SUMMARY: ${result.summary}`,
    'OUTPUT:',
    result.output,
    result.metadata ? `METADATA: ${JSON.stringify(result.metadata, null, 2)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
