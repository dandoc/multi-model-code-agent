import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deleteProfile, listProfiles, loadProfile, renderProfileList, saveProfile } from './profileStore.js';

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mmca-profile-smoke-'));
  const previousHome = process.env.MM_AGENT_HOME;

  try {
    process.env.MM_AGENT_HOME = tempRoot;
    const workdirA = path.join(tempRoot, 'workspace-a');
    const workdirB = path.join(tempRoot, 'workspace-b');
    await mkdir(workdirA, { recursive: true });
    await mkdir(workdirB, { recursive: true });

    const saved = await saveProfile('local-qwen', {
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      baseUrl: 'http://127.0.0.1:11434',
      workdir: workdirA,
      autoApprove: false,
      maxTurns: 8,
      temperature: 0.2,
    });

    if (saved.name !== 'local-qwen') {
      throw new Error('Saved profile name did not round-trip correctly.');
    }

    const loaded = await loadProfile('local-qwen');
    if (!loaded || loaded.workdir !== workdirA || loaded.provider !== 'ollama') {
      throw new Error('Saved profile could not be loaded back.');
    }

    await saveProfile('remote-codex', {
      provider: 'codex',
      model: 'gpt-5.4',
      baseUrl: 'http://127.0.0.1:11434',
      workdir: workdirB,
      autoApprove: true,
      maxTurns: 42,
      temperature: 0.7,
    });

    const listed = await listProfiles();
    if (listed.length !== 2) {
      throw new Error(`Expected 2 saved profiles, got ${listed.length}.`);
    }

    const rendered = await renderProfileList({
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      baseUrl: 'http://127.0.0.1:11434',
      workdir: workdirA,
      autoApprove: false,
      maxTurns: 8,
      temperature: 0.2,
    });
    if (!rendered.includes('Saved profiles (2)')) {
      throw new Error('Rendered profile list is missing the profile count.');
    }
    if (!rendered.includes('- name: local-qwen (current match)')) {
      throw new Error('Rendered profile list did not mark the matching runtime profile.');
    }
    if (!rendered.includes('provider=codex, model=gpt-5.4')) {
      throw new Error('Rendered profile list is missing the codex profile summary.');
    }

    const deleted = await deleteProfile('remote-codex');
    if (!deleted) {
      throw new Error('Expected remote-codex profile to be deleted.');
    }

    const remaining = await listProfiles();
    if (remaining.length !== 1 || remaining[0]?.name !== 'local-qwen') {
      throw new Error('Unexpected remaining profiles after deletion.');
    }

    console.log('[profile-smoke] All profile checks passed.');
  } finally {
    if (previousHome === undefined) {
      delete process.env.MM_AGENT_HOME;
    } else {
      process.env.MM_AGENT_HOME = previousHome;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[profile-smoke] Failed: ${message}`);
  process.exitCode = 1;
});
