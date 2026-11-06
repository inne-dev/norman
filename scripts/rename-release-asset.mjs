import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const bundleKind = process.env.BUNDLE_KIND;
const releaseTag = process.env.RELEASE_TAG ?? "";
const taggedVersion = releaseTag.match(/^v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1];
const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const version = taggedVersion ?? config.version;

const bundle = {
  dmg: {
    directory: "src-tauri/target/universal-apple-darwin/release/bundle/dmg",
    suffix: ".dmg",
    filename: `norman-${version}-macos-universal.dmg`,
  },
  nsis: {
    directory: "src-tauri/target/release/bundle/nsis",
    suffix: "-setup.exe",
    filename: `norman-${version}-windows-x64-setup.exe`,
  },
  appimage: {
    directory: "src-tauri/target/release/bundle/appimage",
    suffix: ".AppImage",
    filename: `norman-${version}-linux-x86_64.AppImage`,
  },
}[bundleKind];

if (!bundle) {
  throw new Error(`Unsupported bundle kind: ${bundleKind ?? "(empty)"}`);
}

const directoryEntries = await readdir(bundle.directory, { withFileTypes: true });
const matches = directoryEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(bundle.suffix))
  .map((entry) => entry.name);

if (matches.length !== 1) {
  throw new Error(`Expected one ${bundleKind} package in ${bundle.directory}; found ${matches.length}`);
}

const sourcePath = join(bundle.directory, matches[0]);
const targetPath = join(bundle.directory, bundle.filename);

if (sourcePath !== targetPath) {
  await rename(sourcePath, targetPath);
}

console.log(`Prepared release package: ${bundle.filename}`);
