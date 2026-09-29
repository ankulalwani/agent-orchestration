import fs from 'node:fs';
import path from 'node:path';
import { runCommand, type RepoFacts } from '@ao/core';

/**
 * Collect repository facts for the readiness analysis (spec §36, §41). Reads only project metadata
 * (manifests, top-level entries, Git state); no source code leaves the machine.
 */
export async function collectRepoFacts(root: string): Promise<RepoFacts> {
  const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const exists = (f: string) => fs.existsSync(path.join(root, f));
  const readJson = (f: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const pkg = readJson('package.json');
  const composer = readJson('composer.json');
  const deps = new Set<string>();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) for (const d of Object.keys(pkg?.[k] ?? {})) deps.add(d.toLowerCase());
  for (const k of ['require', 'require-dev']) for (const d of Object.keys(composer?.[k] ?? {})) deps.add(d.toLowerCase());
  for (const f of ['requirements.txt', 'requirements-dev.txt']) {
    if (!exists(f)) continue;
    for (const line of fs.readFileSync(path.join(root, f), 'utf8').split('\n')) {
      const name = /^\s*([A-Za-z0-9_.-]+)/.exec(line)?.[1];
      if (name) deps.add(name.toLowerCase());
    }
  }
  if (exists('pyproject.toml')) {
    const t = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
    for (const m of t.matchAll(/^\s*"?([A-Za-z0-9_.-]+)\s*[<>=~!]/gm)) deps.add(m[1]!.toLowerCase());
  }

  const languages: string[] = [];
  if (exists('tsconfig.json') || deps.has('typescript')) languages.push('typescript');
  else if (pkg) languages.push('javascript');
  if (composer || entries.some((e) => e.endsWith('.php'))) languages.push('php');
  if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py')) languages.push('python');
  if (exists('go.mod')) languages.push('go');
  if (exists('Cargo.toml')) languages.push('rust');
  if (exists('pom.xml') || exists('build.gradle') || exists('build.gradle.kts')) languages.push('java');

  const git = async (args: string[]) => runCommand('git', args, { cwd: root, timeoutMs: 15_000 }).catch(() => null);
  const isRepo = (await git(['rev-parse', '--is-inside-work-tree']))?.stdout.trim() === 'true';
  const status = isRepo ? await git(['status', '--porcelain']) : null;
  const remotes = isRepo ? await git(['remote']) : null;
  const readme = entries.find((e) => /^readme(\.md|\.rst|\.txt)?$/i.test(e));

  return {
    files: entries.filter((e) => !e.startsWith('.') || ['.github', '.gitlab-ci.yml', '.cursorrules'].includes(e)).slice(0, 300),
    packageManager: exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : exists('bun.lockb') || exists('bun.lock') ? 'bun' : exists('package-lock.json') ? 'npm' : null,
    scripts: pkg?.scripts ?? {},
    dependencies: [...deps].slice(0, 2000),
    languages,
    isGitRepo: isRepo,
    gitClean: status ? status.stdout.split('\n').filter((l) => l.trim() && !l.includes('.agent-orchestrator/')).length === 0 : null,
    hasRemote: remotes ? remotes.stdout.trim().length > 0 : null,
    hasTests: ['test', 'tests', '__tests__', 'spec', 'e2e'].some(exists) || entries.some((e) => /\.(test|spec)\.[jt]sx?$/.test(e)) || exists('phpunit.xml') || exists('pytest.ini'),
    hasCi: exists('.github/workflows') || exists('.gitlab-ci.yml') || exists('.circleci'),
    hasDocker: exists('Dockerfile') || exists('docker-compose.yml') || exists('compose.yaml') || exists('docker-compose.yaml'),
    hasPlaywright: deps.has('playwright') || deps.has('@playwright/test') || entries.some((e) => /^playwright\.config\./.test(e)),
    hasAgentInstructions: ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', 'CONVENTIONS.md'].some(exists),
    readmeLength: readme ? fs.statSync(path.join(root, readme)).size : 0,
  };
}
