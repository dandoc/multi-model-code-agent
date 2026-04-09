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

type ProfileListRenderOptions = {
  query?: string;
};

type ProfileDiffField = {
  label: string;
  current: string;
  saved: string;
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

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function matchesProfileSearch(profile: SavedProfile, query: string): boolean {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return true;
  }

  return [
    profile.name,
    profile.provider,
    profile.model,
    profile.baseUrl,
    profile.workdir,
  ].some((value) => value.toLowerCase().includes(normalized));
}

function findProfileSearchMatch(profile: SavedProfile, query: string): string | undefined {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return undefined;
  }

  const candidates: Array<[label: string, value: string]> = [
    ['name', profile.name],
    ['provider', profile.provider],
    ['model', profile.model || '(provider default)'],
    ['base URL', profile.baseUrl],
    ['workdir', profile.workdir],
  ];

  const found = candidates.find(([, value]) => value.toLowerCase().includes(normalized));
  return found ? `match: ${found[0]} -> ${found[1]}` : undefined;
}

export async function findMatchingProfiles(config: AgentConfig): Promise<SavedProfile[]> {
  const profiles = await listProfiles();
  return profiles.filter((profile) => matchesCurrentProfile(profile, config));
}

export async function renderMatchingProfilesLine(config: AgentConfig): Promise<string> {
  try {
    const matchingProfiles = await findMatchingProfiles(config);
    if (matchingProfiles.length === 0) {
      return 'Matching profiles: (none)';
    }

    return `Matching profiles: ${matchingProfiles.map((profile) => profile.name).join(', ')}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Matching profiles: unavailable (${message})`;
  }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

function renderBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

function collectProfileDiff(currentConfig: AgentConfig, profile: SavedProfile): ProfileDiffField[] {
  const fields: ProfileDiffField[] = [];

  if (currentConfig.provider !== profile.provider) {
    fields.push({ label: 'provider', current: currentConfig.provider, saved: profile.provider });
  }
  if (currentConfig.model !== profile.model) {
    fields.push({ label: 'model', current: currentConfig.model, saved: profile.model });
  }
  if (currentConfig.baseUrl !== profile.baseUrl) {
    fields.push({ label: 'base URL', current: currentConfig.baseUrl, saved: profile.baseUrl });
  }
  if (currentConfig.workdir !== profile.workdir) {
    fields.push({ label: 'workdir', current: currentConfig.workdir, saved: profile.workdir });
  }
  if (currentConfig.autoApprove !== profile.autoApprove) {
    fields.push({
      label: 'autoApprove',
      current: renderBoolean(currentConfig.autoApprove),
      saved: renderBoolean(profile.autoApprove),
    });
  }
  if (currentConfig.maxTurns !== profile.maxTurns) {
    fields.push({
      label: 'maxTurns',
      current: String(currentConfig.maxTurns),
      saved: String(profile.maxTurns),
    });
  }
  if (currentConfig.temperature !== profile.temperature) {
    fields.push({
      label: 'temperature',
      current: String(currentConfig.temperature),
      saved: String(profile.temperature),
    });
  }

  return fields;
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

export async function renameProfile(fromName: string, toName: string): Promise<SavedProfile | null> {
  const normalizedFrom = normalizeProfileName(fromName);
  const normalizedTo = normalizeProfileName(toName);

  return withProfilesLock(async () => {
    const current = await loadProfilesFile();
    const existing = current.profiles.find((profile) => profile.name === normalizedFrom);
    if (!existing) {
      return null;
    }

    if (normalizedFrom !== normalizedTo && current.profiles.some((profile) => profile.name === normalizedTo)) {
      throw new Error(`A saved profile named "${normalizedTo}" already exists.`);
    }

    const renamed: SavedProfile = {
      ...existing,
      name: normalizedTo,
      updatedAt: new Date().toISOString(),
    };
    const nextProfiles = current.profiles.filter(
      (profile) => profile.name !== normalizedFrom && profile.name !== normalizedTo
    );
    nextProfiles.push(renamed);
    await writeProfilesFile(nextProfiles);
    return renamed;
  });
}

export function renderProfileDiff(currentConfig: AgentConfig, profile: SavedProfile): string {
  const diffFields = collectProfileDiff(currentConfig, profile);
  const lines = [
    `Profile diff: ${profile.name}`,
    `Updated: ${formatTimestamp(profile.updatedAt)}`,
    `Current runtime: provider=${currentConfig.provider}, model=${currentConfig.model}, workdir=${currentConfig.workdir}`,
    `Saved profile: provider=${profile.provider}, model=${profile.model}, workdir=${profile.workdir}`,
  ];

  if (diffFields.length === 0) {
    lines.push('No changes. This profile already matches the current runtime exactly.');
    return lines.join('\n');
  }

  lines.push(`Changed fields (${diffFields.length}):`);
  for (const field of diffFields) {
    lines.push(`- ${field.label}: ${field.current} -> ${field.saved}`);
  }

  return lines.join('\n');
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

export async function renderProfileList(
  currentConfig: AgentConfig,
  options: ProfileListRenderOptions = {}
): Promise<string> {
  const profiles = await listProfiles();
  const filtered = options.query ? profiles.filter((profile) => matchesProfileSearch(profile, options.query!)) : profiles;
  const profilesPath = getProfilesPath();

  if (filtered.length === 0) {
    if (profiles.length === 0) {
      return [
        `Saved profiles (0)`,
        `Path: ${profilesPath}`,
        'No saved profiles yet. Use /profiles save <name>.',
      ].join('\n');
    }

    return [
      'Saved profiles (0)',
      `Path: ${profilesPath}`,
      `Filter: ${options.query}`,
      'No saved profiles matched that filter.',
    ].join('\n');
  }

  const lines = [`Saved profiles (${filtered.length})`, `Path: ${profilesPath}`];
  if (options.query) {
    lines.push(`Filter: ${options.query}`);
  }

  for (const profile of filtered) {
    const currentLabel = matchesCurrentProfile(profile, currentConfig) ? ' (current match)' : '';
    lines.push(`- name: ${profile.name}${currentLabel}`);
    lines.push(`  updated: ${formatTimestamp(profile.updatedAt)}`);
    lines.push(
      `  provider=${profile.provider}, model=${profile.model || '(provider default)'}, workdir=${profile.workdir}`
    );
    lines.push(
      `  flags: autoApprove=${profile.autoApprove}, maxTurns=${profile.maxTurns}, temperature=${profile.temperature}`
    );
    const matchLine = options.query ? findProfileSearchMatch(profile, options.query) : undefined;
    if (matchLine) {
      lines.push(`  ${matchLine}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
