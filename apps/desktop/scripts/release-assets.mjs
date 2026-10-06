#!/usr/bin/env node
// Release files of the desktop app, used by .github/workflows/release-desktop.yml.
//
//   node scripts/release-assets.mjs collect <bundle dir> <rust target triple> <out dir>
//     Copies what `tauri build` produced for one target to <out dir>, under names without a version, so
//     https://github.com/<repo>/releases/latest/download/<name> always is the newest installer.
//
//   node scripts/release-assets.mjs latest <dir> <version> <download base URL>
//     Writes <dir>/latest.json, which installed apps read to find an update (tauri-plugin-updater). Only
//     files with a signature (`.sig`, made when TAURI_SIGNING_PRIVATE_KEY is set) are listed; without any,
//     no latest.json is written and installed apps stay on their version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSET_PREFIX = 'agent-orchestration-worker';

/** Per Rust target: the name part, and the updater's platform key (`<os>-<arch>`). */
export const TARGETS = {
  'x86_64-pc-windows-msvc': { name: 'windows-x64', updater: 'windows-x86_64' },
  'aarch64-pc-windows-msvc': { name: 'windows-arm64', updater: 'windows-aarch64' },
  'x86_64-apple-darwin': { name: 'macos-x64', updater: 'darwin-x86_64' },
  'aarch64-apple-darwin': { name: 'macos-arm64', updater: 'darwin-aarch64' },
  'x86_64-unknown-linux-gnu': { name: 'linux-x64', updater: 'linux-x86_64' },
  'aarch64-unknown-linux-gnu': { name: 'linux-arm64', updater: 'linux-aarch64' },
};

/** Bundle sub-folder, file ending as Tauri writes it, ending of the release file, and whether the updater installs it. */
const KINDS = [
  { folder: 'nsis', ending: '-setup.exe', as: '-setup.exe', updater: true },
  { folder: 'dmg', ending: '.dmg', as: '.dmg', updater: false },
  { folder: 'macos', ending: '.app.tar.gz', as: '.app.tar.gz', updater: true },
  { folder: 'appimage', ending: '.AppImage', as: '.AppImage', updater: true },
  { folder: 'deb', ending: '.deb', as: '.deb', updater: false },
];

export function collect(bundleDir, target, outDir) {
  const t = TARGETS[target];
  if (!t) throw new Error(`Unknown target ${target}. Known: ${Object.keys(TARGETS).join(', ')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  for (const kind of KINDS) {
    const dir = path.join(bundleDir, kind.folder);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(kind.ending));
    if (files.length > 1) throw new Error(`More than one ${kind.ending} file in ${dir}: ${files.join(', ')}`);
    if (!files.length) continue;
    const name = `${ASSET_PREFIX}-${t.name}${kind.as}`;
    fs.copyFileSync(path.join(dir, files[0]), path.join(outDir, name));
    copied.push(name);
    const signature = path.join(dir, `${files[0]}.sig`);
    if (fs.existsSync(signature)) {
      fs.copyFileSync(signature, path.join(outDir, `${name}.sig`));
      copied.push(`${name}.sig`);
    }
  }
  if (!copied.length) throw new Error(`No installer found in ${bundleDir}`);
  return copied;
}

export function latestJson(dir, version, baseUrl, now = new Date()) {
  const platforms = {};
  for (const t of Object.values(TARGETS)) {
    for (const kind of KINDS.filter((k) => k.updater)) {
      const name = `${ASSET_PREFIX}-${t.name}${kind.as}`;
      const signature = path.join(dir, `${name}.sig`);
      if (fs.existsSync(path.join(dir, name)) && fs.existsSync(signature)) {
        platforms[t.updater] = { signature: fs.readFileSync(signature, 'utf8').trim(), url: `${baseUrl.replace(/\/+$/, '')}/${name}` };
      }
    }
  }
  if (!Object.keys(platforms).length) return null;
  return { version, notes: `Agent Orchestration Worker ${version}`, pub_date: now.toISOString(), platforms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'collect' && args.length === 3) {
    for (const name of collect(args[0], args[1], args[2])) console.log(name);
  } else if (command === 'latest' && args.length === 3) {
    const json = latestJson(args[0], args[1], args[2]);
    if (json) {
      fs.writeFileSync(path.join(args[0], 'latest.json'), JSON.stringify(json, null, 2) + '\n');
      console.log(`latest.json: ${args[1]} for ${Object.keys(json.platforms).join(', ')}`);
    } else {
      console.log('No signed update files: latest.json not written (installed apps stay on their version).');
    }
  } else {
    console.error('Usage: release-assets.mjs collect <bundle dir> <target> <out dir> | latest <dir> <version> <base URL>');
    process.exit(2);
  }
}
