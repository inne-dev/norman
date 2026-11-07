import { createHash } from 'node:crypto';

const MAX_VERSION_COMPONENT = 65_535;

export function packageVersionForReleaseTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new TypeError('A GitHub release tag is required.');
  }

  const semverMatch = tag.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (semverMatch) {
    const components = semverMatch.slice(1).map(Number);
    if (components.every((component) => Number.isSafeInteger(component) && component <= MAX_VERSION_COMPONENT)) {
      return components.join('.');
    }
  }

  // Tauri and native bundle formats require a numeric SemVer. Keep unusual GitHub
  // tags verbatim for display, and map them deterministically to a safe bundle version.
  const digest = createHash('sha256').update(tag).digest('hex');
  const components = [0, 4, 8].map((offset) => Number.parseInt(digest.slice(offset, offset + 4), 16));
  return components.join('.');
}

export function releaseFilenameVersion(tag, fallbackVersion) {
  const source = tag || fallbackVersion;
  const displayTag = source.replace(/^v(?=\d)/, '');
  const normalized = displayTag.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const safe = normalized.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'release';
  const wasChanged = safe !== displayTag || safe.length > 80;
  if (!wasChanged) return safe;

  const suffix = createHash('sha256').update(source).digest('hex').slice(0, 8);
  return `${safe.slice(0, 71).replace(/[.-]+$/g, '') || 'release'}-${suffix}`;
}
