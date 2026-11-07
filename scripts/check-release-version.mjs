import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersionForReleaseTag } from './release-version.mjs';

const tag = process.argv[2];
if (!tag) {
  console.error('Usage: npm run release:check -- <GitHub tag>');
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const tauriConfigPath = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url));
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
const packageVersion = packageJson.version;
const tauriVersionSource = tauriConfig.version;
const tauriVersionPath = typeof tauriVersionSource === 'string'
  ? resolve(dirname(tauriConfigPath), tauriVersionSource)
  : '';
const tauriVersion = tauriVersionPath === fileURLToPath(new URL('../package.json', import.meta.url))
  ? packageVersion
  : tauriVersionSource;
const expectedVersion = packageVersionForReleaseTag(tag);

if (packageVersion !== tauriVersion
  || packageLock.version !== packageVersion
  || packageLock.packages?.['']?.version !== packageVersion
  || expectedVersion !== packageVersion) {
  console.error(
    `Release version mismatch: tag=${tag}, expected package version=${expectedVersion}, package.json=${packageVersion}, tauri.conf.json=${tauriVersionSource}, package-lock.json=${packageLock.version}/${packageLock.packages?.['']?.version}`,
  );
  process.exit(1);
}

console.log(`Release tag ${tag} maps to bundle version ${packageVersion}, read by Tauri from package.json.`);
