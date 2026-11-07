import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2];
if (!tag || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  console.error('Usage: npm run release:check -- vMAJOR.MINOR.PATCH');
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
const tagVersion = tag.slice(1);

if (packageVersion !== tauriVersion
  || packageLock.version !== packageVersion
  || packageLock.packages?.['']?.version !== packageVersion
  || tagVersion !== packageVersion) {
  console.error(
    `Release version mismatch: tag=${tagVersion}, package.json=${packageVersion}, tauri.conf.json=${tauriVersionSource}, package-lock.json=${packageLock.version}/${packageLock.packages?.['']?.version}`,
  );
  process.exit(1);
}

console.log(`Release version ${tag} is set in package metadata and read by Tauri from package.json.`);
