import { describe, expect, it } from 'vitest';
import { analyzeReadiness, type RepoFacts } from './readiness.js';
import { capabilityManifestSchema } from './capabilities.js';

const repo = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  files: ['package.json', 'README.md'],
  packageManager: 'pnpm',
  scripts: { test: 'vitest', typecheck: 'tsc --noEmit', build: 'vite build' },
  dependencies: ['react', 'vite'],
  languages: ['typescript'],
  isGitRepo: true,
  gitClean: true,
  hasRemote: true,
  hasTests: true,
  hasCi: true,
  hasDocker: false,
  hasPlaywright: false,
  hasAgentInstructions: false,
  readmeLength: 1000,
  ...over,
});
const worker = { agents: [{ id: 'claude-code', installed: true }], providers: [{ id: 'anthropic', healthy: true }, { id: 'openai', healthy: true }], tools: ['node', 'git'] };

describe('AI readiness (spec §41)', () => {
  it('reports a well-set-up web project as ready with browser recommendation', () => {
    const r = analyzeReadiness({ repo: repo(), worker, capabilities: [], installedCapabilityIds: [] });
    expect(r.items.filter((i) => i.category === 'required')).toEqual([]);
    expect(r.items.find((i) => i.id === 'browser')?.category).toBe('recommended');
    expect(r.items.find((i) => i.id === 'tests')?.category).toBe('available');
    expect(r.summary).toMatch(/Ready/);
    expect(r.score).toBeGreaterThan(50);
  });

  it('flags hard requirements: git, agent, provider, tests, missing tools', () => {
    const r = analyzeReadiness({
      repo: repo({ isGitRepo: false, hasTests: false, scripts: { test: 'echo "Error: no test specified" && exit 1' }, languages: ['python'] }),
      worker: { agents: [], providers: [], tools: [] },
      capabilities: [],
      installedCapabilityIds: [],
    });
    const required = r.items.filter((i) => i.category === 'required').map((i) => i.id);
    expect(required).toEqual(expect.arrayContaining(['git.repo', 'agents', 'providers', 'tests', 'tool.python']));
    expect(r.items[0]!.category).toBe('required'); // sorted
  });

  it('browser verification becomes required when the task is about UI', () => {
    const r = analyzeReadiness({ repo: repo(), worker, capabilities: [], installedCapabilityIds: [], prompt: 'Fix the checkout page form' });
    expect(r.items.find((i) => i.id === 'browser')?.category).toBe('required');
  });

  it('recommends registry capabilities whose triggers match, and marks installed ones available', () => {
    const shopify = capabilityManifestSchema.parse({ id: 'shopify-dev', name: 'Shopify', version: '1.0.0', type: 'skill', skill: { instructions: 'x' }, triggers: { dependencies: ['@shopify/cli'], keywords: ['shopify'] } });
    const unrelated = capabilityManifestSchema.parse({ id: 'php-std', name: 'PHP', version: '1.0.0', type: 'skill', skill: { instructions: 'x' }, triggers: { files: ['composer.json'] } });
    const r = analyzeReadiness({ repo: repo({ dependencies: ['@shopify/cli'] }), worker, capabilities: [shopify, unrelated], installedCapabilityIds: [], prompt: 'shopify theme' });
    expect(r.items.find((i) => i.capabilityId === 'shopify-dev')).toMatchObject({ category: 'recommended', confidence: 'high' });
    expect(r.items.some((i) => i.capabilityId === 'php-std')).toBe(false);
    const r2 = analyzeReadiness({ repo: repo({ dependencies: ['@shopify/cli'] }), worker, capabilities: [shopify], installedCapabilityIds: ['shopify-dev'] });
    expect(r2.items.find((i) => i.capabilityId === 'shopify-dev')?.category).toBe('available');
  });
});
