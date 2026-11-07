import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packageVersionForReleaseTag } from './release-version.mjs';

const releaseTag = process.argv[2];
if (!releaseTag) {
  console.error('Usage: npm run release:set-version -- <GitHub tag>');
  process.exit(1);
}

const version = packageVersionForReleaseTag(releaseTag);
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageLockPath = fileURLToPath(new URL('../package-lock.json', import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));

if (!packageLock.packages?.['']) {
  console.error('package-lock.json does not contain root package metadata.');
  process.exit(1);
}

packageJson.version = version;
packageLock.version = version;
packageLock.packages[''].version = version;

writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
console.log(`Set app package version to ${version} for GitHub tag ${releaseTag}.`);
