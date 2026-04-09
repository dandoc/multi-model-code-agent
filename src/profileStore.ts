import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getAgentHomeDir } from './storagePaths.js';
import type { AgentConfig } from './types.js';

export type SavedProfile = {
  name: string;
  provider: AgentConfig['provider'];
  model: string;
  baseUrl: string;
  workdir: string;
  autoApprove: boolean;
  maxTurns: number;
  temperature: number;
  updatedAt: string;
};

type StoredProfilesFile = {
  version: 1;
  profiles: SavedProfile[];
};

function getProfilesPath(): string {
  return path.join(getAgentHomeDir(), 'profiles.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSavedProfile(value: unknown): value is SavedProfile {
  return (
    isRecord(value) &&
    (value.provider === 'ollama' || value.provider === 'openai' || value.provider === 'codex') &&
    typeof value.name === 'string' &&
    typeof value.model === 'string' &&
    typeof value.baseUrl === 'string' &&
    typeof value.workdir === 'string' &&
    typeof value.autoApprove === 'boolean' &&
    typeof value.maxTurns === 'number' &&
    typeof value.temperature === 'number' &&
    typeof value.updatedAt === 'string'
  );
}

function normalizeProfileName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new Error('Profile name cannot be empty.');
  }
  if (normalized.length > 80) {
    throw new Error('Profile name must be 80 characters or fewer.');
  }
  if (/[\r\n\t]/.test(normalized)) {
    throw new Error('Profile name cannot contain control characters.');
  }
  return normalized;
}

function compareProfileNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' });
}

function matchesCurrentProfile(profile: SavedProfile, config: AgentConfig): boolean {
  return (
    profile.provider === config.provider &&
    profile.model === config.model &&
    profile.baseUrl === config.baseUrl &&
    profile.workdir === config.workdir &&
    profile.autoApprove === config.autoApprove &&
    profile.maxTurns === config.maxTurns &&
    profile.temperature === config.temperature
  );
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

async function loadProfilesFile(): Promise<StoredProfilesFile> {
  const profilesPath = getProfilesPath();
  if (!existsSync(profilesPath)) {
    return { version: 1, profiles: [] };
  }

  const raw = await readFile(profilesPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (
    isRecord(parsed) &&
    parsed.version === 1 &&
    Array.isArray(parsed.profiles) &&
    parsed.profiles.every((entry) => isSavedProfile(entry))
  ) {
    return {
      version: 1,
      profiles: [...parsed.profiles].sort((left, right) => compareProfileNames(left.name, right.name)),
    };
  }

  throw new Error(`Profiles file is corrupted: ${profilesPath}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withProfilesLock<T>(action: () => Promise<T>): Promise<T> {
  const agentHome = getAgentHomeDir();
  await mkdir(agentHome, { recursive: true });
  const lockDir = `${getProfilesPath()}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt > 5_000) {
        throw new Error(`Timed out waiting for the profiles lock: ${lockDir}`);
      }

      await sleep(25);
    }
  }

  try {
    return await action();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function writeProfilesFile(profiles: SavedProfile[]): Promise<void> {
  const agentHome = getAgentHomeDir();
  await mkdir(agentHome, { recursive: true });
  const profilesPath = getProfilesPath();
  const tempPath = `${profilesPath}.${process.pid}.${Date.now()}.tmp`;
  const payload: StoredProfilesFile = {
    version: 1,
    profiles: [...profiles].sort((left, right) => compareProfileNames(left.name, right.name)),
  };
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tempPath, profilesPath);
}

export async function listProfiles(): Promise<SavedProfile[]> {
  return (await loadProfilesFile()).profiles;
}

export async function loadProfile(name: string): Promise<SavedProfile | null> {
  const normalizedName = normalizeProfileName(name);
  const profiles = await listProfiles();
  return profiles.find((profile) => profile.name === normalizedName) ?? null;
}

export async function saveProfile(name: string, config: AgentConfig): Promise<SavedProfile> {
  const normalizedName = normalizeProfileName(name);
  const nextProfile: SavedProfile = {
    name: normalizedName,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    workdir: config.workdir,
    autoApprove: config.autoApprove,
    maxTurns: config.maxTurns,
    temperature: config.temperature,
    updatedAt: new Date().toISOString(),
  };

  await withProfilesLock(async () => {
    const current = await loadProfilesFile();
    const nextProfiles = current.profiles.filter((profile) => profile.name !== normalizedName);
    nextProfiles.push(nextProfile);
    await writeProfilesFile(nextProfiles);
  });
  return nextProfile;
}

export async function deleteProfile(name: string): Promise<boolean> {
  const normalizedName = normalizeProfileName(name);
  return withProfilesLock(async () => {
    const current = await loadProfilesFile();
    const nextProfiles = current.profiles.filter((profile) => profile.name !== normalizedName);
    if (nextProfiles.length === current.profiles.length) {
      return false;
    }

    if (nextProfiles.length === 0) {
      const profilesPath = getProfilesPath();
      if (existsSync(profilesPath)) {
        await rm(profilesPath, { force: true });
      }
      return true;
    }

    await writeProfilesFile(nextProfiles);
    return true;
  });
}

export async function renderProfileList(currentConfig: AgentConfig): Promise<string> {
  const profiles = await listProfiles();
  const profilesPath = getProfilesPath();

  if (profiles.length === 0) {
    return [`Saved profiles (0)`, `Path: ${profilesPath}`, 'No saved profiles yet. Use /profiles save <name>.'].join(
      '\n'
    );
  }

  const lines = [`Saved profiles (${profiles.length})`, `Path: ${profilesPath}`];
  for (const profile of profiles) {
    const currentLabel = matchesCurrentProfile(profile, currentConfig) ? ' (current match)' : '';
    lines.push(`- name: ${profile.name}${currentLabel}`);
    lines.push(`  updated: ${formatTimestamp(profile.updatedAt)}`);
    lines.push(
      `  provider=${profile.provider}, model=${profile.model || '(provider default)'}, workdir=${profile.workdir}`
    );
    lines.push(
      `  flags: autoApprove=${profile.autoApprove}, maxTurns=${profile.maxTurns}, temperature=${profile.temperature}`
    );
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
