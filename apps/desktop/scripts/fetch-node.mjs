#!/usr/bin/env node
// Downloads the Node.js binary the desktop app ships as its sidecar and writes it where Tauri expects it:
//   src-tauri/binaries/ao-node-<target triple>[.exe]
// Usage: node scripts/fetch-node.mjs [--target <rust target triple>] [--force]
// The file must match the SHA-256 pinned below (copied from https://nodejs.org/dist/v<version>/SHASUMS256.txt),
// so a changed download is refused. To move to another Node.js version, change NODE_VERSION and every checksum.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '24.21.0';

/** Rust target triple → file on nodejs.org and its SHA-256. */
export const NODE_BUILDS = {
  'x86_64-pc-windows-msvc': { file: 'win-x64/node.exe', sha256: 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32' },
  'aarch64-pc-windows-msvc': { file: 'win-arm64/node.exe', sha256: 'dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7' },
  'x86_64-apple-darwin': { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097' },
  'aarch64-apple-darwin': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057' },
  'x86_64-unknown-linux-gnu': { file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff' },
  'aarch64-unknown-linux-gnu': { file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`, sha256: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5' },
};

/** Rust's GNU toolchain on Windows (a local build without the Visual Studio build tools) ships the same Node.js. */
const SAME_BUILD_AS = { 'x86_64-pc-windows-gnu': 'x86_64-pc-windows-msvc' };

/** The target triple of the machine this runs on (what `tauri build` uses without --target). */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  const system = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[platform];
  if (!cpu || !system) throw new Error(`No Node.js build is pinned for ${platform} ${arch}`);
  return `${cpu}-${system}`;
}

export function verifyChecksum(data, expected, name) {
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`${name} does not match its pinned checksum (expected ${expected}, got ${actual})`);
}

export async function fetchNode({ target = hostTarget(), outDir, force = false, fetchImpl = fetch } = {}) {
  const build = NODE_BUILDS[SAME_BUILD_AS[target] ?? target];
  if (!build) throw new Error(`No Node.js build is pinned for ${target}. Supported: ${Object.keys(NODE_BUILDS).join(', ')}`);
  const windows = target.includes('windows');
  const out = path.join(outDir, `ao-node-${target}${windows ? '.exe' : ''}`);
  const stamp = `${out}.version`;
  if (!force && fs.existsSync(out) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === build.sha256) return { out, downloaded: false };

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${build.file}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  verifyChecksum(data, build.sha256, build.file);

  fs.mkdirSync(outDir, { recursive: true });
  if (windows) {
    fs.writeFileSync(out, data);
  } else {
    // The archive holds the whole distribution; only bin/node is needed.
    const tar = await import('tar');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-node-'));
    try {
      const archive = path.join(tmp, 'node.tar.gz');
      fs.writeFileSync(archive, data);
      const member = `${build.file.replace(/\.tar\.gz$/, '')}/bin/node`;
      tar.x({ file: archive, cwd: tmp, sync: true, strict: true }, [member]);
      fs.copyFileSync(path.join(tmp, member), out);
      fs.chmodSync(out, 0o755);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(stamp, build.sha256 + '\n');
  return { out, downloaded: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'binaries');
  const { out, downloaded } = await fetchNode({ target: arg('--target'), outDir, force: process.argv.includes('--force') });
  console.log(`${downloaded ? 'Downloaded' : 'Already present:'} Node.js ${NODE_VERSION} ${downloaded ? 'to ' : ''}${out}`);
}
