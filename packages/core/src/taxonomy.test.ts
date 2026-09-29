import { describe, expect, it } from 'vitest';
import { capabilityManifestSchema } from './capabilities.js';
import { relevanceScore } from './registry.js';
import { classify, extractSignals, packageText, rankSuggestions, RELATED_THRESHOLD, signalsOfPackage, tokenize, type SuggestCandidate } from './taxonomy.js';

const manifest = (over: Record<string, unknown>) =>
  capabilityManifestSchema.parse({ id: 'pkg', name: 'Pkg', version: '1.0.0', type: 'skill', description: '', publisher: 'x', trust: 'LOCAL', ...over });

describe('tokenize', () => {
  it('keeps technology spellings and splits compound words', () => {
    expect(tokenize('Next.js, C# and .NET; GITHUB_TOKEN react-review')).toEqual(expect.arrayContaining(['next.js', 'c#', '.net', 'github_token', 'github', 'token', 'react-review', 'react', 'review']));
  });
});

describe('classify', () => {
  it('categorises a skill from its name, description and instructions', () => {
    const m = manifest({ id: 'react-testing', name: 'React testing', description: 'Write React Testing Library and Vitest tests for components.', skill: { instructions: 'Use vitest. Mock network calls.' } });
    const c = classify(packageText({ name: m.id, displayName: m.name, description: m.description, manifest: m }));
    expect(c.categories[0]).toBe('testing');
    expect(c.categories).toContain('frontend');
    expect(c.technologies).toEqual(expect.arrayContaining(['react', 'vitest']));
  });

  it('reads MCP commands and environment variables', () => {
    const m = manifest({
      id: 'server-postgres',
      name: 'Postgres',
      type: 'mcp',
      description: 'Read-only access to a database.',
      permissions: ['network.outbound'],
      mcp: { transport: 'stdio', command: ['npx', '-y', '@modelcontextprotocol/server-postgres'], env: { DATABASE_URL: 'secret:DB' } },
    });
    const c = classify(packageText({ name: m.id, displayName: m.name, description: m.description, manifest: m }));
    expect(c.categories[0]).toBe('databases');
    expect(c.technologies).toContain('postgres');
  });

  it('files unclear packages under other and respects declared categories', () => {
    expect(classify({ title: 'thing', description: 'Does a thing.' }).categories).toEqual(['other']);
    expect(classify({ title: 'thing', description: 'Does a thing.', declaredCategories: ['security', 'nope'] }).categories).toEqual(['security']);
  });

  it('does not treat a passing mention in a long readme as a technology', () => {
    expect(classify({ title: 'notes', description: 'Keeps notes.', body: 'Unlike Slack, this keeps notes.' }).technologies).not.toContain('slack');
  });
});

describe('suggestions', () => {
  const pkg = (name: string, over: Partial<SuggestCandidate> = {}): SuggestCandidate => ({ name, displayName: name, description: '', categories: ['other'], technologies: [], keywords: [], curated: false, trust: 'COMMUNITY', installs: 0, ...over });
  const catalog = [
    pkg('react-review', { categories: ['code-quality', 'frontend'], technologies: ['react'], keywords: ['react', 'review'] }),
    pkg('django-helper', { categories: ['backend'], technologies: ['django', 'python'], keywords: ['django'] }),
    pkg('playwright-e2e', { categories: ['testing'], technologies: ['playwright'], keywords: ['playwright', 'e2e'], curated: true }),
    pkg('jest-tests', { categories: ['testing'], technologies: ['jest'], keywords: ['jest'] }),
    pkg('slack', { categories: ['communication'], technologies: ['slack'], keywords: ['slack'] }),
  ];

  it('suggests packages for a prompt, curated first, never irrelevant ones', () => {
    const s = rankSuggestions(catalog, extractSignals({ text: 'Add end-to-end tests with Playwright for the React checkout page' }));
    expect(s.map((x) => x.item.name)).toEqual(['playwright-e2e', 'react-review']);
    expect(s[0]!.reasons.join(' ')).toContain('Playwright');
  });

  it('uses a repository stack', () => {
    const s = rankSuggestions(catalog, extractSignals({ text: 'Fix the flaky tests', dependencies: ['jest', 'react'] }));
    expect(s.map((x) => x.item.name)).toContain('jest-tests');
    expect(s.map((x) => x.item.name)).not.toContain('slack');
  });

  it('finds related packages', () => {
    const s = rankSuggestions(catalog.filter((p) => p.name !== 'jest-tests'), signalsOfPackage(catalog[3]!), 10, RELATED_THRESHOLD);
    expect(s[0]!.item.name).toBe('playwright-e2e');
  });

  it('prefers skills about the task’s technologies when selecting for a task', () => {
    const react = manifest({ id: 'aa', name: 'Frontend conventions', description: 'Conventions for React components.', skill: { instructions: 'x' } });
    const django = manifest({ id: 'bb', name: 'Backend conventions', description: 'Conventions for Django views.', skill: { instructions: 'x' } });
    const ctx = { text: 'Refactor the React header component' };
    expect(relevanceScore(react, ctx)).toBeGreaterThan(relevanceScore(django, ctx));
  });
});
