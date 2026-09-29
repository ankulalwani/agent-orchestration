/**
 * The real agent CLIs through the real session runtime (AGENT-006..009): detection, the command line
 * each adapter builds, spawning, output parsing and exit classification. Without valid credentials the
 * expected outcome is AUTH_REQUIRED — which proves the CLI accepted our arguments (a rejected flag
 * would exit immediately as FAILED/CRASHED) and that the failure is recognised, not reported as success.
 *
 * Opt-in (AO_TEST_AGENT_CLIS=1) because it makes real, rejected requests to OpenAI, Google and
 * Anthropic. The CLIs are taken from .tools/ (see docs/development).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { AiderAdapter, CodexAdapter, GeminiAdapter, OpenCodeAdapter, startAgentSession, type AgentAdapter, type AgentEvent } from '../../packages/agents/src/index.js';

const bins = [path.resolve('.tools/agents/node_modules/.bin'), path.resolve(process.platform === 'win32' ? '.tools/aider-venv/Scripts' : '.tools/aider-venv/bin')];
const enabled = process.env.AO_TEST_AGENT_CLIS === '1' && bins.every((b) => fs.existsSync(b));

async function run(adapter: AgentAdapter, provider: { providerId: string; kind: string; modelId: string; apiKey?: string }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ao-cli-${adapter.id}-`));
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(home, 'codex'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'a@example.com');
  git('config', 'user.name', 'A');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  const inst = await adapter.detect();
  expect(inst.installed, `${adapter.id} detected`).toBe(true);
  const req = {
    taskId: 't1',
    cwd: repo,
    prompt: 'Say hello.',
    provider: { ...provider, apiKey: provider.apiKey ?? 'invalid-key-for-verification' },
    sessionId: randomUUID(),
    stateDir: path.join(repo, '.agent-orchestrator'),
    // Keep every CLI's config/cache out of the real user profile.
    env: { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.data'), CODEX_HOME: path.join(home, 'codex') },
  };
  const session = startAgentSession(adapter, inst, req, await adapter.buildInvocation(req, inst), { hangTimeoutMs: 170_000 });
  const events: AgentEvent[] = [];
  for await (const e of session.events) events.push(e);
  const exit = await session.done;
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString();
  return { exit, events, status, inst };
}

describe.runIf(enabled)('real agent CLIs (invalid credentials)', () => {
  beforeAll(() => {
    process.env.PATH = [...bins, process.env.PATH].join(path.delimiter);
  });

  it('Codex', async () => {
    const r = await run(new CodexAdapter(), { providerId: 'openai', kind: 'openai', modelId: 'default', apiKey: '' });
    expect(r.exit.state).toBe('AUTH_REQUIRED');
    expect(r.events.some((e) => e.type === 'session')).toBe(true);
  }, 240_000);

  it('Gemini CLI', async () => {
    const r = await run(new GeminiAdapter(), { providerId: 'google', kind: 'google', modelId: 'default' });
    expect(r.exit.state).toBe('AUTH_REQUIRED');
    expect(r.events.some((e) => e.type === 'session')).toBe(true);
  }, 240_000);

  it('OpenCode', async () => {
    const r = await run(new OpenCodeAdapter(), { providerId: 'anthropic', kind: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(r.exit.state).toBe('AUTH_REQUIRED');
  }, 240_000);

  it('Aider: recognised as a failure although it exits 0, and the repository stays clean', async () => {
    const r = await run(new AiderAdapter(), { providerId: 'anthropic', kind: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5' });
    expect(r.exit.state).toBe('AUTH_REQUIRED');
    // .gitignore untouched and no chat history in the project; only the repo-map cache, which the
    // worker hides via .git/info/exclude (AiderAdapter gitExcludes), and our own state directory.
    const untracked = r.status.split('\n').filter(Boolean).map((l) => l.slice(3));
    expect(untracked.filter((f) => !f.startsWith('.aider.tags.cache') && !f.startsWith('.agent-orchestrator'))).toEqual([]);
  }, 240_000);
});
