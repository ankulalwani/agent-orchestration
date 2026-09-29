#!/usr/bin/env node
// Boundary guard (docs/PUBLIC_PRIVATE_BOUNDARY.md). Fails when this repository references code, packages,
// configuration or identifiers that belong to a distribution built on top of it. The core must build and
// run on its own, so nothing here may import from, name, or configure an extension that is not in this
// repository. Runs in CI; run it locally with `node scripts/check-boundary.mjs`.
//
// A distribution built on this repository can add its own identifiers without publishing them here:
//   BOUNDARY_EXTRA_PATTERNS=<file with one regular expression per line> node scripts/check-boundary.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const SELF = 'scripts/check-boundary.mjs';

/** Paths that must not exist in this repository. */
const FORBIDDEN_PATHS = [/^cloud\//, /(^|\/)(billing|subscriptions?|provisioning)(\/|\.[a-z]+$)/i];

/** Content that must not appear in tracked files. */
const FORBIDDEN_CONTENT = [
  { rule: 'private package', re: /@ao\/cloud|agent-orchestrator-cloud/ },
  { rule: 'import from a sibling private checkout', re: /from\s+['"](\.\.\/)+(cloud|private|saas)[/'"]/ },
  { rule: 'payment provider', re: /\bstripe\b|STRIPE_|\bpaddle\b|\bchargebee\b|\bbraintree\b/i },
];
if (process.env.BOUNDARY_EXTRA_PATTERNS) {
  for (const line of fs.readFileSync(process.env.BOUNDARY_EXTRA_PATTERNS, 'utf8').split(/\r?\n/)) {
    if (line.trim() && !line.startsWith('#')) FORBIDDEN_CONTENT.push({ rule: 'distribution identifier', re: new RegExp(line.trim()) });
  }
}

/** Files whose content is not source (binary or generated). */
const SKIP_CONTENT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|tgz|vsix)$|(^|\/)pnpm-lock\.yaml$/;

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => f !== SELF && fs.existsSync(f));

const problems = [];
for (const f of files) {
  for (const re of FORBIDDEN_PATHS) if (re.test(f)) problems.push(`${f}: forbidden path (${re})`);
  if (SKIP_CONTENT.test(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { rule, re } of FORBIDDEN_CONTENT) if (re.test(line)) problems.push(`${f}:${i + 1}: ${rule}`);
  });
}

// Workspace dependencies must all be packages of this repository.
const workspaceNames = new Set(
  files.filter((f) => f.endsWith('package.json')).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).name),
);
for (const f of files.filter((x) => x.endsWith('package.json'))) {
  const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) {
    if (String(range).startsWith('workspace:') && !workspaceNames.has(name)) problems.push(`${f}: depends on ${name}, which is not in this repository`);
    if (/^(file|link|git\+|github:)/.test(String(range))) problems.push(`${f}: ${name} uses a non-registry source (${range})`);
  }
}

if (problems.length) {
  console.error(`Boundary check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Boundary check passed: ${files.length} files, no references to private code.`);
