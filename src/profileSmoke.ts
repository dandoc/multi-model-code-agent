import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  deleteProfile,
  findMatchingProfiles,
  listProfiles,
  loadProfile,
  renderMatchingProfilesLine,
  renderProfileList,
  saveProfile,
} from './profileStore.js';
import { getAgentHomeDir } from './storagePaths.js';

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
    const matches = await findMatchingProfiles({
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      baseUrl: 'http://127.0.0.1:11434',
      workdir: workdirA,
      autoApprove: false,
      maxTurns: 8,
      temperature: 0.2,
    });
    if (matches.length !== 1 || matches[0]?.name !== 'local-qwen') {
      throw new Error('Expected current runtime profile matching to find local-qwen.');
    }
    const matchLine = await renderMatchingProfilesLine({
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      baseUrl: 'http://127.0.0.1:11434',
      workdir: workdirA,
      autoApprove: false,
      maxTurns: 8,
      temperature: 0.2,
    });
    if (matchLine !== 'Matching profiles: local-qwen') {
      throw new Error(`Unexpected matching profile line: ${matchLine}`);
    }
    const noMatchLine = await renderMatchingProfilesLine({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      baseUrl: 'http://127.0.0.1:11434',
      workdir: workdirB,
      autoApprove: false,
      maxTurns: 8,
      temperature: 0.2,
    });
    if (noMatchLine !== 'Matching profiles: (none)') {
      throw new Error(`Unexpected empty matching profile line: ${noMatchLine}`);
    }

    const previousUserProfile = process.env.USERPROFILE;
    delete process.env.MM_AGENT_HOME;
    delete process.env.USERPROFILE;
    const expectedFallbackHome = path.join(os.homedir(), '.multi-model-code-agent');
    if (getAgentHomeDir() !== expectedFallbackHome) {
      throw new Error('Profile storage should fall back to os.homedir() when MM_AGENT_HOME is unset.');
    }
    process.env.MM_AGENT_HOME = tempRoot;
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    await Promise.all([
      saveProfile('concurrent-a', {
        provider: 'ollama',
        model: 'qwen2.5-coder:7b',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirA,
        autoApprove: false,
        maxTurns: 8,
        temperature: 0.2,
      }),
      saveProfile('concurrent-b', {
        provider: 'openai',
        model: 'gpt-5.4',
        baseUrl: 'https://api.example.test/v1',
        workdir: workdirB,
        autoApprove: true,
        maxTurns: 24,
        temperature: 0.9,
      }),
    ]);

    const concurrentProfiles = await listProfiles();
    if (!concurrentProfiles.some((profile) => profile.name === 'concurrent-a')) {
      throw new Error('Concurrent profile save dropped profile concurrent-a.');
    }
    if (!concurrentProfiles.some((profile) => profile.name === 'concurrent-b')) {
      throw new Error('Concurrent profile save dropped profile concurrent-b.');
    }
    const profilesFile = path.join(tempRoot, 'profiles.json');
    if (!existsSync(profilesFile)) {
      throw new Error('Profiles file was not created under MM_AGENT_HOME.');
    }
    const rawProfiles = await readFile(profilesFile, 'utf8');
    if (!rawProfiles.includes('"concurrent-a"') || !rawProfiles.includes('"concurrent-b"')) {
      throw new Error('Profiles file is missing one of the concurrently saved profiles.');
    }

    const deleted = await deleteProfile('remote-codex');
    if (!deleted) {
      throw new Error('Expected remote-codex profile to be deleted.');
    }
    await deleteProfile('concurrent-a');
    await deleteProfile('concurrent-b');

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
