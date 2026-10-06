#!/usr/bin/env node
// Prepares what the Tauri bundle embeds, then `tauri dev` / `tauri build` can run:
//   src-tauri/binaries/ao-node-<target triple>   the Node.js sidecar (scripts/fetch-node.mjs)
//   src-tauri/resources/worker.tgz               the worker package (scripts/package-worker.mjs --tarball)
//   src-tauri/resources/WORKER_VERSION           its version
// Usage: node scripts/prepare.mjs [--target <rust target triple>] [--if-missing]
// --if-missing: keep an existing worker package (faster `desktop:dev`; rebuild with `pnpm desktop:prepare`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNode, NODE_VERSION } from './fetch-node.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const tauriDir = path.resolve(here, '..', 'src-tauri');
const resources = path.join(tauriDir, 'resources');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

const { out, downloaded } = await fetchNode({ target: arg('--target'), outDir: path.join(tauriDir, 'binaries') });
console.log(`Node.js ${NODE_VERSION} sidecar: ${out}${downloaded ? ' (downloaded)' : ''}`);

const version = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'worker', 'package.json'), 'utf8')).version;
const packaged = path.join(resources, 'worker.tgz');
const stamp = path.join(resources, 'WORKER_VERSION');
if (process.argv.includes('--if-missing') && fs.existsSync(packaged) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version) {
  console.log(`Worker ${version} package kept: ${packaged}`);
} else {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'package-worker.mjs'), '--tarball'], { cwd: root, stdio: 'inherit' });
  fs.mkdirSync(resources, { recursive: true });
  fs.copyFileSync(path.join(root, '.deploy', `worker-${version}.tgz`), packaged);
  fs.writeFileSync(stamp, version + '\n');
  console.log(`Worker ${version} package: ${packaged}`);
}
