import os from 'node:os';
import path from 'node:path';

export function getAgentHomeDir(): string {
  const override = process.env.MM_AGENT_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(os.homedir(), '.multi-model-code-agent');
}

