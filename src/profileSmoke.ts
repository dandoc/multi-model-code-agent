import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  deleteProfile,
  findMatchingProfiles,
  listProfiles,
  loadProfile,
  renameProfile,
  renderProfileDiff,
  renderProfileLoadPreview,
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
      requestTimeoutMs: 120_000,
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
      requestTimeoutMs: 240_000,
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
    if (!rendered.includes('requestTimeout=240s')) {
      throw new Error('Rendered profile list should show the saved request timeout in seconds.');
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
    const diffSame = renderProfileDiff(
      {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirA,
        autoApprove: false,
        maxTurns: 8,
        temperature: 0.2,
      },
      saved
    );
    if (!diffSame.includes('No changes. This profile already matches the current runtime exactly.')) {
      throw new Error('Profile diff should explain when the saved profile already matches the current runtime.');
    }
    const loadPreviewSame = renderProfileLoadPreview(
      {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirA,
        autoApprove: false,
        maxTurns: 8,
        temperature: 0.2,
      },
      saved
    );
    if (
      !loadPreviewSame.includes('Load profile: local-qwen') ||
      !loadPreviewSame.includes('This profile already matches the current runtime.') ||
      !loadPreviewSame.includes('Loading a profile resets the current conversation.')
    ) {
      throw new Error('Profile load preview should explain the no-op case and conversation reset.');
    }
    const diffChanged = renderProfileDiff(
      {
        provider: 'codex',
        model: 'gpt-5.4',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirB,
        autoApprove: true,
        maxTurns: 42,
        temperature: 0.7,
      },
      saved
    );
    if (
      !diffChanged.includes('Changed fields (6):') ||
      !diffChanged.includes(`- provider: codex -> ollama`) ||
      !diffChanged.includes(`- workdir: ${workdirB} -> ${workdirA}`) ||
      !diffChanged.includes(`- autoApprove: true -> false`)
    ) {
      throw new Error('Profile diff should list changed runtime fields.');
    }
    const loadPreviewChanged = renderProfileLoadPreview(
      {
        provider: 'codex',
        model: 'gpt-5.4',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirB,
        autoApprove: true,
        maxTurns: 42,
        temperature: 0.7,
      },
      saved
    );
    if (
      !loadPreviewChanged.includes('Changed fields (6):') ||
      !loadPreviewChanged.includes(`- provider: codex -> ollama`) ||
      !loadPreviewChanged.includes('Loading a profile resets the current conversation.')
    ) {
      throw new Error('Profile load preview should list changed fields before confirmation.');
    }
    const timeoutDiff = renderProfileDiff(
      {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirA,
        autoApprove: false,
        maxTurns: 8,
        temperature: 0.2,
        requestTimeoutMs: 300_000,
      },
      saved
    );
    if (!timeoutDiff.includes('- requestTimeout: 300s -> 120s')) {
      throw new Error('Profile diff should surface request-timeout changes.');
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
    const filteredProfiles = await renderProfileList(
      {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirA,
        autoApprove: false,
        maxTurns: 8,
        temperature: 0.2,
      },
      { query: 'codex' }
    );
    if (!filteredProfiles.includes('Saved profiles (1)') || !filteredProfiles.includes('match: name -> remote-codex')) {
      throw new Error('Filtered profile list should include a match preview for codex.');
    }
    if (filteredProfiles.includes('local-qwen')) {
      throw new Error('Filtered profile list should not include non-matching profiles.');
    }
    const noFilteredProfiles = await renderProfileList(
      {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434',
        workdir: workdirA,
        autoApprove: false,
        maxTurns: 8,
        temperature: 0.2,
      },
      { query: 'does-not-exist' }
    );
    if (
      !noFilteredProfiles.includes('Saved profiles (0)') ||
      !noFilteredProfiles.includes('Filter: does-not-exist') ||
      !noFilteredProfiles.includes('No saved profiles matched that filter.')
    ) {
      throw new Error('Filtered empty profile list should explain that no profiles matched the filter.');
    }

    const renamed = await renameProfile('remote-codex', 'remote-codex-renamed');
    if (!renamed || renamed.name !== 'remote-codex-renamed') {
      throw new Error('Expected profile rename to return the renamed profile.');
    }
    const missingOld = await loadProfile('remote-codex');
    if (missingOld) {
      throw new Error('Old profile name should no longer resolve after rename.');
    }
    const renamedLoaded = await loadProfile('remote-codex-renamed');
    if (!renamedLoaded || renamedLoaded.provider !== 'codex') {
      throw new Error('Renamed profile could not be loaded back.');
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

    const deleted = await deleteProfile('remote-codex-renamed');
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
