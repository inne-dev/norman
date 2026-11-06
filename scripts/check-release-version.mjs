import { readFileSync } from 'node:fs';

const tag = process.argv[2];
if (!tag || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  console.error('Usage: npm run release:check -- vMAJOR.MINOR.PATCH');
  process.exit(1);
}

const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tauriVersion = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
const tagVersion = tag.slice(1);

if (packageVersion !== tauriVersion || tagVersion !== packageVersion) {
  console.error(
    `Release version mismatch: tag=${tagVersion}, package.json=${packageVersion}, tauri.conf.json=${tauriVersion}`,
  );
  process.exit(1);
}

console.log(`Release version ${tag} matches package.json and tauri.conf.json.`);
