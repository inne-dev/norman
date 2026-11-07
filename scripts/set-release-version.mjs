import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const releaseTag = process.argv[2];
if (!releaseTag || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseTag)) {
  console.error('Usage: npm run release:set-version -- vMAJOR.MINOR.PATCH');
  process.exit(1);
}

const version = releaseTag.slice(1);
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
console.log(`Set app package version to ${version} from GitHub tag ${releaseTag}.`);
