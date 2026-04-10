import { readFileSync } from 'node:fs';

interface PackageMetadata {
  name?: string;
  version?: string;
  description?: string;
}

let cachedPackageMetadata: PackageMetadata | undefined;

function readPackageMetadata(): PackageMetadata {
  if (cachedPackageMetadata) {
    return cachedPackageMetadata;
  }

  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  cachedPackageMetadata = JSON.parse(raw) as PackageMetadata;
  return cachedPackageMetadata;
}

export function getProjectName(): string {
  return readPackageMetadata().name ?? 'multi-model-code-agent';
}

export function getProjectVersion(): string {
  return readPackageMetadata().version ?? '0.0.0';
}

export function renderProjectVersion(): string {
  return `${getProjectName()} ${getProjectVersion()}`;
}
