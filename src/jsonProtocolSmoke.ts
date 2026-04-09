import { parseAgentEnvelope } from './jsonProtocol.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const stringArguments = parseAgentEnvelope(
    '{"type":"tool_call","tool":"read_file","arguments":"{\\"path\\":\\"src/index.ts\\"}"}'
  );
  assert(
    stringArguments.type === 'tool_call' &&
      stringArguments.tool === 'read_file' &&
      stringArguments.arguments.path === 'src/index.ts',
    'Expected stringified arguments JSON to normalize into a tool call.'
  );

  const functionCall = parseAgentEnvelope(
    '{"function_call":{"name":"read_file","arguments":"{\\"path\\":\\"src/config.ts\\",}"}}'
  );
  assert(
    functionCall.type === 'tool_call' &&
      functionCall.tool === 'read_file' &&
      functionCall.arguments.path === 'src/config.ts',
    'Expected legacy function_call payloads with trailing commas to normalize into a tool call.'
  );

  const toolCallsArray = parseAgentEnvelope(
    '{"tool_calls":[{"function":{"name":"write_patch","arguments":"{\\"operation\\":\\"create\\",\\"path\\":\\"notes/hello.txt\\",\\"content\\":\\"hi\\"}"}}]}'
  );
  assert(
    toolCallsArray.type === 'tool_call' &&
      toolCallsArray.tool === 'write_patch' &&
      toolCallsArray.arguments.path === 'notes/hello.txt',
    'Expected tool_calls arrays to yield the first valid tool call envelope.'
  );

  const fencedJsonc = parseAgentEnvelope(
    [
      'I will use a tool.',
      '```jsonc',
      '{',
      '  "type": "tool_call",',
      '  "tool": "search_files",',
      '  "arguments": {',
      '    "pattern": "AgentRunner",',
      '  },',
      '}',
      '```',
    ].join('\n')
  );
  assert(
    fencedJsonc.type === 'tool_call' &&
      fencedJsonc.tool === 'search_files' &&
      fencedJsonc.arguments.pattern === 'AgentRunner',
    'Expected fenced jsonc payloads with trailing commas to normalize into a tool call.'
  );

  const arrayEnvelope = parseAgentEnvelope(
    '[{"type":"tool_call","tool":"read_multiple_files","arguments":{"paths":["README.md","src/index.ts"]}}]'
  );
  assert(
    arrayEnvelope.type === 'tool_call' &&
      arrayEnvelope.tool === 'read_multiple_files' &&
      Array.isArray(arrayEnvelope.arguments.paths),
    'Expected single-item JSON arrays to normalize into a tool call envelope.'
  );

  const explanatoryFenceFallback = parseAgentEnvelope(
    [
      'This bash snippet is not the real payload:',
      '```bash',
      'echo not-json',
      '```',
      'Actual payload follows {"type":"tool_call","tool":"run_shell","arguments":{"command":"echo hello"}}',
    ].join('\n')
  );
  assert(
    explanatoryFenceFallback.type === 'tool_call' &&
      explanatoryFenceFallback.tool === 'run_shell' &&
      explanatoryFenceFallback.arguments.command === 'echo hello',
    'Expected the parser to fall back from a non-JSON fence to balanced JSON later in the response.'
  );

  const plainMessage = parseAgentEnvelope('Not JSON at all.');
  assert(
    plainMessage.type === 'message' && plainMessage.message === 'Not JSON at all.',
    'Expected plain text to remain a plain assistant message.'
  );

  console.log('[json-protocol-smoke] All JSON protocol checks passed.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[json-protocol-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
