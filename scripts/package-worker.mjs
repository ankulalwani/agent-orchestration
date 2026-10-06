#!/usr/bin/env node
// Builds a self-contained worker (+ agentctl) into .deploy/worker. Run from the repository root:
//   node scripts/package-worker.mjs [--tarball] [--hosted-url <url>]
// The result is what the installers copy: `node .deploy/worker/dist/main.js` runs the worker.
// --hosted-url: a distribution's hosted control plane, offered as a one-click choice when pairing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const out = path.join(root, '.deploy', 'worker');
const pnpm = (args) =>
  // pnpm switches itself to the version in package.json's `packageManager` field.
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32', // .cmd shims need a shell on Windows; arguments are fixed literals
  });

pnpm(['install', '--frozen-lockfile']);
pnpm(['--filter', '@ao/worker-ui', 'build']);
pnpm(['--filter', '@ao/worker', 'build']);
pnpm(['--filter', '@ao/cli', 'build']);
fs.rmSync(out, { recursive: true, force: true });
// Hoisted (flat) node_modules: the package is copied by installers, which would break pnpm's symlinked layout.
pnpm(['--config.node-linker=hoisted', '--filter', '@ao/worker', 'deploy', '--prod', path.relative(root, out)]);
// pnpm deploy leaves a copy of its virtual-store path inside the target; it is not used at runtime.
fs.rmSync(path.join(out, '.deploy'), { recursive: true, force: true });
// One package serves every OS (updates, the one-click install, the desktop app), but pnpm installs native
// add-ons for the build machine only: a package built on Linux had no Windows or macOS keyring binary, and
// those workers fell back to the encrypted-file credential store. Install them for every supported platform,
// in the packaged folder only (the repository's own install stays as it is).
const NATIVE_TARGETS = ['win32-x64-msvc', 'win32-arm64-msvc', 'darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl'];
const deployWorkspace = path.join(out, 'pnpm-workspace.yaml');
const deployConfig = fs.existsSync(deployWorkspace) ? fs.readFileSync(deployWorkspace, 'utf8').replace(/^(nodeLinker|supportedArchitectures):.*\n(?:[ \t]+.*\n)*/gm, '') : '';
fs.writeFileSync(deployWorkspace, `${deployConfig.trimEnd()}\nnodeLinker: hoisted\nsupportedArchitectures:\n  os: [win32, darwin, linux]\n  cpu: [x64, arm64]\n  libc: [glibc, musl]\n`.trimStart());
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install', '--prod', '--frozen-lockfile'], { cwd: out, stdio: 'inherit', shell: process.platform === 'win32' });
const missingNative = NATIVE_TARGETS.filter((t) => !fs.existsSync(path.join(out, 'node_modules', '@napi-rs', `keyring-${t}`, `keyring.${t}.node`)));
if (missingNative.length) throw new Error(`The packaged worker has no credential-store binary for: ${missingNative.join(', ')}`);
fs.cpSync(path.join(root, 'apps', 'worker-ui', 'dist'), path.join(out, 'dist', 'ui'), { recursive: true });
// agentctl ships inside the worker package (it uses the worker's credential-store code).
fs.copyFileSync(path.join(root, 'apps', 'cli', 'dist', 'main.js'), path.join(out, 'dist', 'agentctl.js'));
// The installers ship inside the package so the one-click install (/api/v1/install/worker.sh|ps1) can run them.
fs.cpSync(path.join(root, 'installers'), path.join(out, 'installers'), { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'worker', 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(out, 'VERSION'), version + '\n');
const hostedArg = process.argv.indexOf('--hosted-url');
if (hostedArg > 0) {
  const hostedUrl = new URL(process.argv[hostedArg + 1] ?? '').toString().replace(/\/$/, '');
  fs.writeFileSync(path.join(out, 'HOSTED_URL'), hostedUrl + '\n');
  console.log(`Hosted service offered when pairing: ${hostedUrl}`);
}
console.log(`\nWorker packaged at ${out}`);

// --tarball: also produce the release package that `scripts/sign-release.mjs sign` signs and workers install.
if (process.argv.includes('--tarball')) {
  const tgz = path.join(root, '.deploy', `worker-${version}.tgz`);
  // node-tar rather than the OS tar (Windows' bsdtar crashes on this tree).
  const tar = await import('tar');
  // pnpm hard-links files from its store and adds node_modules/.bin symlinks. Archived as-is, extraction on Windows
  // (no symlink privilege) aborts midway and leaves a partial node_modules. Pack a copy of regular files only.
  const stage = path.join(root, '.deploy', 'pack');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.cpSync(out, path.join(stage, 'worker'), { recursive: true, dereference: true });
  fs.rmSync(path.join(stage, 'worker', 'node_modules', '.bin'), { recursive: true, force: true });
  tar.c({ gzip: true, file: tgz, cwd: stage, portable: true, sync: true }, ['worker']);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`Release package: ${tgz}`);
}
