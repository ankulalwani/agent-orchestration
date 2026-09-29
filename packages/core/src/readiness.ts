import type { CapabilityManifest } from './capabilities.js';

/**
 * AI readiness analysis — "Prepare Project for AI" (spec §36, §41). Pure: the worker collects repository
 * facts (it is the only component with access to the code) and this function turns them, plus worker
 * inventory and the capability registry, into Required / Recommended / Already available / Not required
 * items with explanations and a confidence level.
 */

export interface RepoFacts {
  files: string[]; // notable root-level files/dirs present, e.g. "package.json", "tests", ".github"
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  scripts: Record<string, string>; // package.json scripts
  dependencies: string[]; // npm + composer + python dependency names (lowercased)
  languages: string[]; // "typescript", "javascript", "php", "python", "go", "rust", "java"
  isGitRepo: boolean;
  gitClean: boolean | null;
  hasRemote: boolean | null;
  hasTests: boolean;
  hasCi: boolean;
  hasDocker: boolean;
  hasPlaywright: boolean;
  hasAgentInstructions: boolean; // CLAUDE.md / AGENTS.md / GEMINI.md / .cursorrules etc.
  readmeLength: number;
}

export interface ReadinessInput {
  repo: RepoFacts;
  worker: { agents: Array<{ id: string; installed: boolean }>; providers: Array<{ id: string; healthy: boolean }>; tools: string[] };
  capabilities: CapabilityManifest[]; // registry entries visible to the org
  installedCapabilityIds: string[];
  prompt?: string; // optional task prompt to tailor recommendations
}

export type ReadinessCategory = 'required' | 'recommended' | 'available' | 'not_required';
export interface ReadinessItem {
  id: string;
  area: 'git' | 'agents' | 'providers' | 'tests' | 'build' | 'browser' | 'dependencies' | 'capabilities' | 'docs' | 'environment';
  category: ReadinessCategory;
  title: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  capabilityId?: string;
}

export interface ReadinessReport {
  score: number; // 0–100, share of required+recommended items already satisfied
  items: ReadinessItem[];
  summary: string;
}

const has = (list: string[], x: string) => list.includes(x);

export function analyzeReadiness(input: ReadinessInput): ReadinessReport {
  const { repo, worker } = input;
  const items: ReadinessItem[] = [];
  const add = (i: ReadinessItem) => items.push(i);
  const prompt = (input.prompt ?? '').toLowerCase();

  // Git
  if (!repo.isGitRepo) add({ id: 'git.repo', area: 'git', category: 'required', title: 'Initialize a Git repository', explanation: 'Without Git the orchestrator cannot isolate task changes, commit results or protect existing work.', confidence: 'high' });
  else {
    add({ id: 'git.repo', area: 'git', category: 'available', title: 'Git repository', explanation: 'Task changes are committed on a task branch according to the Git policy.', confidence: 'high' });
    if (repo.gitClean === false) add({ id: 'git.clean', area: 'git', category: 'recommended', title: 'Commit or stash local changes', explanation: 'Uncommitted changes are preserved and never included in task commits, but a clean tree makes results easier to review.', confidence: 'high' });
    if (repo.hasRemote === false) add({ id: 'git.remote', area: 'git', category: 'recommended', title: 'Add a Git remote', explanation: 'Needed for COMMIT_AND_PUSH and PULL_REQUEST policies.', confidence: 'high' });
  }

  // Agents and providers
  const agents = worker.agents.filter((a) => a.installed && a.id !== 'mock');
  add(
    agents.length
      ? { id: 'agents', area: 'agents', category: 'available', title: `Coding agents: ${agents.map((a) => a.id).join(', ')}`, explanation: 'At least one agent can execute tasks on this worker.', confidence: 'high' }
      : { id: 'agents', area: 'agents', category: 'required', title: 'Install a coding agent', explanation: 'No supported coding agent (Claude Code, Codex, Gemini CLI, OpenCode, Aider) is installed on this worker.', confidence: 'high' },
  );
  const healthy = worker.providers.filter((p) => p.healthy);
  add(
    healthy.length
      ? { id: 'providers', area: 'providers', category: 'available', title: `AI providers: ${healthy.map((p) => p.id).join(', ')}`, explanation: 'Models are available for execution.', confidence: 'high' }
      : { id: 'providers', area: 'providers', category: 'required', title: 'Configure an AI provider', explanation: 'No healthy provider is configured on this worker. Add one in the worker UI (or mark an agent login).', confidence: 'high' },
  );
  if (healthy.length === 1) add({ id: 'providers.fallback', area: 'providers', category: 'recommended', title: 'Add a second provider for fallback', explanation: 'With one provider, usage limits pause tasks until reset. A compatible second provider lets the fallback policy continue work.', confidence: 'medium' });

  // Tests, build, lint
  const scripts = repo.scripts;
  const testScript = scripts.test && !/no test specified/i.test(scripts.test);
  if (repo.hasTests || testScript) add({ id: 'tests', area: 'tests', category: 'available', title: 'Automated tests', explanation: 'Verification will run the project tests after every change.', confidence: 'high' });
  else add({ id: 'tests', area: 'tests', category: 'required', title: 'Add automated tests', explanation: 'Tasks can only be verified by automated checks. Without tests, verification is limited to build/type checks and completion claims are weaker.', confidence: 'high' });
  if (has(repo.languages, 'typescript')) {
    add(scripts.typecheck || scripts['type-check'] ? { id: 'typecheck', area: 'build', category: 'available', title: 'Type checking', explanation: 'A typecheck script is used during verification.', confidence: 'high' } : { id: 'typecheck', area: 'build', category: 'recommended', title: 'Add a "typecheck" script', explanation: 'e.g. "typecheck": "tsc --noEmit" — catches errors the agent introduces.', confidence: 'high' });
  }
  if (repo.files.includes('package.json')) {
    add(scripts.lint ? { id: 'lint', area: 'build', category: 'available', title: 'Linting', explanation: 'A lint script is used during verification.', confidence: 'high' } : { id: 'lint', area: 'build', category: 'recommended', title: 'Add a "lint" script', explanation: 'Keeps agent changes consistent with project style.', confidence: 'medium' });
    if (scripts.build) add({ id: 'build', area: 'build', category: 'available', title: 'Build', explanation: 'The build is verified after changes.', confidence: 'high' });
    if (!repo.packageManager) add({ id: 'lockfile', area: 'dependencies', category: 'recommended', title: 'Commit a lockfile', explanation: 'Reproducible installs make verification reliable across workers.', confidence: 'medium' });
  }

  // Browser verification
  const webApp = ['react', 'vue', 'svelte', 'next', 'nuxt', '@angular/core', 'vite', 'laravel/framework', 'django', 'flask', 'express'].some((d) => has(repo.dependencies, d));
  const wantsBrowser = /\b(ui|page|checkout|browser|frontend|screen|form|click)\b/.test(prompt);
  if (webApp || wantsBrowser) {
    add(
      repo.hasPlaywright
        ? { id: 'browser', area: 'browser', category: 'available', title: 'Browser verification (Playwright)', explanation: 'UI changes can be verified in a real browser.', confidence: 'high' }
        : { id: 'browser', area: 'browser', category: wantsBrowser ? 'required' : 'recommended', title: 'Add Playwright for browser verification', explanation: 'This looks like a web application. Install Playwright in the project so UI changes can be verified with screenshots and console checks.', confidence: webApp ? 'high' : 'medium' },
    );
  } else add({ id: 'browser', area: 'browser', category: 'not_required', title: 'Browser verification', explanation: 'No web UI framework detected.', confidence: 'medium' });

  // Environment
  if (repo.hasDocker) add({ id: 'docker', area: 'environment', category: has(worker.tools, 'docker') ? 'available' : 'recommended', title: 'Docker', explanation: has(worker.tools, 'docker') ? 'Docker is available for services the project needs.' : 'The project has Docker configuration but Docker is not installed on this worker.', confidence: 'medium' });
  for (const lang of repo.languages) {
    const tool = { typescript: 'node', javascript: 'node', php: 'php', python: 'python', go: 'go', rust: 'cargo', java: 'java' }[lang];
    if (tool && !has(worker.tools, tool)) add({ id: `tool.${tool}`, area: 'environment', category: 'required', title: `Install ${tool} on the worker`, explanation: `The project uses ${lang}; verification needs ${tool}.`, confidence: 'high' });
  }

  // Docs / agent instructions
  add(
    repo.hasAgentInstructions
      ? { id: 'docs.agent', area: 'docs', category: 'available', title: 'Agent instructions file', explanation: 'Agents read project conventions from it.', confidence: 'high' }
      : { id: 'docs.agent', area: 'docs', category: 'recommended', title: 'Add project knowledge', explanation: 'Describe architecture, conventions and how to run things in the project knowledge (dashboard) or an AGENTS.md/CLAUDE.md file.', confidence: 'medium' },
  );
  if (repo.readmeLength < 200) add({ id: 'docs.readme', area: 'docs', category: 'recommended', title: 'Expand the README', explanation: 'Agents rely on it to understand setup and structure.', confidence: 'low' });
  if (!repo.hasCi) add({ id: 'ci', area: 'build', category: 'not_required', title: 'CI configuration', explanation: 'Not needed by the orchestrator (it verifies on the worker), but useful for pull requests.', confidence: 'low' });

  // Capabilities from the registry whose triggers match
  for (const cap of input.capabilities) {
    const t = cap.triggers ?? { files: [], dependencies: [], keywords: [] };
    const reasons: string[] = [];
    if (t.files.some((f) => repo.files.includes(f))) reasons.push('matching project files');
    if (t.dependencies.some((d) => has(repo.dependencies, d.toLowerCase()))) reasons.push('matching dependencies');
    if (t.keywords.some((k) => prompt.includes(k.toLowerCase()))) reasons.push('mentioned in the task');
    if (!reasons.length) continue;
    const installed = input.installedCapabilityIds.includes(cap.id);
    add({
      id: `cap.${cap.id}`,
      area: 'capabilities',
      category: installed ? 'available' : 'recommended',
      title: `${installed ? '' : 'Install '}${cap.name} (${cap.type})`,
      explanation: `${cap.description || 'Relevant capability'} — ${reasons.join(', ')}.`,
      confidence: reasons.length > 1 ? 'high' : 'medium',
      capabilityId: cap.id,
    });
  }

  const relevant = items.filter((i) => i.category !== 'not_required');
  const satisfied = relevant.filter((i) => i.category === 'available').length;
  const score = relevant.length ? Math.round((satisfied / relevant.length) * 100) : 100;
  const required = items.filter((i) => i.category === 'required');
  const summary = required.length
    ? `${required.length} required item${required.length > 1 ? 's' : ''} before tasks can run reliably: ${required.map((r) => r.title.toLowerCase()).join('; ')}.`
    : 'Ready for AI tasks. Recommended items improve verification and recovery.';
  const order: Record<ReadinessCategory, number> = { required: 0, recommended: 1, available: 2, not_required: 3 };
  items.sort((a, b) => order[a.category] - order[b.category]);
  return { score, items, summary };
}
