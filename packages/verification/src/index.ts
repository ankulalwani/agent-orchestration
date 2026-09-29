import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatCommand, killTree, redactString, runCommand, safeSpawn, type VerificationStep } from '@ao/core';
import { routesFromFiles, sameOriginLinks } from './routes.js';

/**
 * Verification engine (spec §43). A task is never complete because the agent said so; completion
 * requires every *required* step here to pass. Steps come from policy or are auto-detected from
 * project files. Commands are argv arrays run without a shell.
 */

export interface StepResult {
  kind: string;
  name: string;
  command?: string;
  required: boolean;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  exitCode?: number | null;
  durationMs: number;
  outputTail?: string;
  artifacts: Array<{ name: string; key: string; contentType: string }>;
  reason?: string;
}

export interface VerificationRun {
  attempt: number;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  steps: StepResult[];
  warnings: string[];
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

function exists(root: string, f: string) {
  return fs.existsSync(path.join(root, f));
}

export function detectPackageManager(root: string): PackageManager {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun';
  return 'npm';
}

const PLACEHOLDER_TEST = /no test specified/i;

/** Auto-detect verification steps from project files (Node, PHP, Python, Go, Rust). */
export function detectSteps(root: string): VerificationStep[] {
  const steps: VerificationStep[] = [];
  const step = (kind: VerificationStep['kind'], name: string, command: string[], timeoutMs = 15 * 60_000): VerificationStep => ({ kind, name, command, required: true, timeoutMs });

  if (exists(root, 'package.json')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const pm = detectPackageManager(root);
    const run = (script: string) => (pm === 'npm' ? ['npm', 'run', '--silent', script] : [pm, 'run', script]);
    const pick = (...names: string[]) => names.find((n) => scripts[n]);
    const typecheck = pick('typecheck', 'type-check', 'tsc', 'check-types');
    if (typecheck) steps.push(step('typecheck', `${typecheck} (${pm})`, run(typecheck)));
    const lint = pick('lint');
    if (lint) steps.push(step('lint', `lint (${pm})`, run(lint)));
    const build = pick('build');
    if (build) steps.push(step('build', `build (${pm})`, run(build)));
    const test = pick('test:ci', 'test:unit', 'test');
    if (test && !PLACEHOLDER_TEST.test(scripts[test]!)) steps.push(step('test', `${test} (${pm})`, run(test)));
  }
  if (exists(root, 'composer.json')) {
    const composer = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    if (composer.scripts?.test) steps.push(step('test', 'composer test', ['composer', 'test']));
    else if (exists(root, 'vendor/bin/phpunit')) steps.push(step('test', 'phpunit', [path.join('vendor', 'bin', process.platform === 'win32' ? 'phpunit.bat' : 'phpunit')]));
  }
  if (exists(root, 'pyproject.toml') || exists(root, 'requirements.txt') || exists(root, 'setup.py')) {
    if (exists(root, 'tests') || exists(root, 'pytest.ini') || exists(root, 'conftest.py')) steps.push(step('test', 'pytest', ['python', '-m', 'pytest', '-q']));
  }
  if (exists(root, 'go.mod')) {
    steps.push(step('build', 'go build', ['go', 'build', './...']));
    steps.push(step('test', 'go test', ['go', 'test', './...']));
  }
  if (exists(root, 'Cargo.toml')) {
    steps.push(step('build', 'cargo build', ['cargo', 'build', '--quiet']));
    steps.push(step('test', 'cargo test', ['cargo', 'test', '--quiet']));
  }
  return steps;
}

/** Resolve a CLI name to an executable, preferring Windows .cmd shims where npm installs them. */
function resolveCommand(cmd: string): string {
  if (process.platform !== 'win32' || path.extname(cmd)) return cmd;
  if (['npm', 'pnpm', 'yarn', 'npx', 'composer'].includes(cmd)) return `${cmd}.cmd`;
  return cmd;
}

const tail = (s: string, n = 4000) => redactString(s.length > n ? s.slice(-n) : s);

export interface ArtifactSink {
  put(name: string, data: Buffer, contentType: string): Promise<string>;
}

export class VerificationEngine {
  constructor(
    private root: string,
    private opts: { artifacts?: ArtifactSink; env?: Record<string, string>; onStep?: (r: StepResult) => void } = {},
  ) {}

  async run(steps: VerificationStep[], attempt: number, opts: { autoDetect?: boolean } = {}): Promise<VerificationRun> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];
    let plan = steps;
    if (!plan.length && opts.autoDetect !== false) plan = detectSteps(this.root);
    const substantive = plan.filter((s) => s.kind !== 'git_status');
    if (!substantive.length) warnings.push('No automated tests, type checks, lint or build were found for this project; verification is limited.');

    const results: StepResult[] = [];
    for (const s of plan) {
      const r = await this.runStep(s);
      results.push(r);
      this.opts.onStep?.(r);
    }
    const failed = results.some((r) => r.required && (r.status === 'failed' || r.status === 'error'));
    return { attempt, status: failed ? 'failed' : 'passed', startedAt, finishedAt: new Date().toISOString(), steps: results, warnings };
  }

  async runStep(s: VerificationStep): Promise<StepResult> {
    const name = s.name ?? s.kind;
    const base = { kind: s.kind, name, required: s.required, artifacts: [] as StepResult['artifacts'] };
    const t0 = Date.now();
    try {
      if (s.kind === 'browser' || s.kind === 'smoke') return await this.browserStep(s, base, t0);
      if (!s.command) return { ...base, status: 'skipped', durationMs: 0, reason: 'No command configured' };
      const [cmd, ...args] = s.command;
      const r = await runCommand(resolveCommand(cmd!), args, { cwd: this.root, timeoutMs: s.timeoutMs, env: { ...process.env, CI: '1', ...(this.opts.env ?? {}) } });
      return {
        ...base,
        command: formatCommand(cmd!, args),
        status: r.timedOut ? 'failed' : r.exitCode === 0 ? 'passed' : 'failed',
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        outputTail: tail(`${r.stdout}\n${r.stderr}`) + (r.timedOut ? `\n[timed out after ${s.timeoutMs} ms]` : ''),
      };
    } catch (e) {
      return { ...base, status: 'error', durationMs: Date.now() - t0, reason: redactString(String((e as Error).message ?? e)) };
    }
  }

  /**
   * smoke: HTTP GET must answer < 400. browser: Playwright (resolved from the project) loads the page,
   * captures console errors, page errors, failed requests and a screenshot; with `discover` it also
   * visits the app's other pages (QA route discovery, spec §76). With `start`, the app is started for
   * the step and stopped afterwards. If Playwright is not installed in the project, a browser step fails
   * with an explanation — it never passes silently.
   */
  private async browserStep(s: VerificationStep, base: Omit<StepResult, 'status' | 'durationMs'>, t0: number): Promise<StepResult> {
    if (!s.url) return { ...base, status: 'error', durationMs: 0, reason: 'Browser/smoke step requires a url' } as StepResult;
    const app = s.start ? this.startApp(s.start) : null;
    try {
      if (app) {
        const ready = await waitForUrl(s.url, s.start!.readyTimeoutMs, app);
        if (!ready.ok) return { ...base, status: 'failed', durationMs: Date.now() - t0, reason: ready.reason, outputTail: tail(app.output()) } as StepResult;
      }
      if (s.kind === 'smoke') {
        const res = await fetch(s.url, { signal: AbortSignal.timeout(s.timeoutMs) });
        return { ...base, status: res.status < 400 ? 'passed' : 'failed', durationMs: Date.now() - t0, outputTail: `GET ${s.url} → ${res.status}` } as StepResult;
      }
      let playwright: { chromium: { launch(o: object): Promise<any> } };
      try {
        const req = createRequire(path.join(this.root, 'package.json'));
        playwright = req(req.resolve('playwright'));
      } catch {
        return { ...base, status: 'failed', durationMs: Date.now() - t0, reason: 'Playwright is not installed in this project (npm i -D playwright && npx playwright install chromium)' } as StepResult;
      }
      const browser = await playwright.chromium.launch({ headless: true });
      const pages: PageCheck[] = [];
      try {
        const deadline = t0 + s.timeoutMs;
        const origin = new URL(s.url).origin;
        const d = s.discover;
        const excluded = (u: string) => (d?.exclude ?? []).some((x) => new URL(u).pathname.startsWith(x));
        const queue: Array<{ url: string; depth: number; source: string }> = [{ url: s.url, depth: 0, source: 'start' }];
        if (d) {
          for (const p of d.paths) queue.push({ url: origin + p, depth: 0, source: 'configured' });
          for (const p of routesFromFiles(this.root)) queue.push({ url: origin + p, depth: 0, source: 'routes' });
        }
        const seen = new Set<string>();
        const limit = d ? d.maxPages : 1;
        while (queue.length && pages.length < limit && Date.now() < deadline) {
          const next = queue.shift()!;
          const key = next.url.replace(/\/$/, '');
          if (seen.has(key) || excluded(next.url)) continue;
          seen.add(key);
          const check = await this.checkPage(browser, next.url, Math.max(1000, Math.min(60_000, deadline - Date.now())));
          check.source = next.source;
          pages.push(check);
          if (d && next.depth < d.maxDepth) for (const link of check.links) queue.push({ url: link, depth: next.depth + 1, source: 'link' });
        }
        // Screenshots: the start page, and every page with problems (up to 10).
        for (const [i, p] of pages.entries()) {
          if ((i === 0 || p.problems.length) && p.screenshot && this.opts.artifacts && base.artifacts.length < 10) {
            const name = i === 0 ? 'screenshot.png' : `screenshot-${i + 1}.png`;
            base.artifacts.push({ name, key: await this.opts.artifacts.put(name, p.screenshot, 'image/png'), contentType: 'image/png' });
          }
        }
      } finally {
        await browser.close();
      }
      const bad = pages.filter((p) => p.problems.length);
      const lines = s.discover
        ? [
            `Visited ${pages.length} page(s); ${bad.length} with problems.`,
            ...pages.map((p) => `${p.problems.length ? '✗' : '✓'} ${new URL(p.url).pathname} (${p.status || 'no response'}, ${p.source})${p.problems.map((x) => `\n    ${x}`).join('')}`),
          ]
        : bad.flatMap((p) => p.problems);
      return { ...base, status: bad.length ? 'failed' : 'passed', durationMs: Date.now() - t0, outputTail: tail(lines.join('\n') || 'No console errors, page errors or failed requests') } as StepResult;
    } finally {
      await app?.stop();
    }
  }

  private async checkPage(browser: any, url: string, timeoutMs: number): Promise<PageCheck> {
    const problems: string[] = [];
    const page = await browser.newPage();
    page.on('console', (m: any) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
    page.on('pageerror', (e: Error) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r: any) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
    let status = 0;
    let links: string[] = [];
    let screenshot: Buffer | null = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
      status = resp?.status() ?? 0;
      if (status >= 400) problems.push(`HTTP ${status}`);
      links = sameOriginLinks(await page.$$eval('a[href]', (as: Array<{ href: string }>) => as.map((a) => a.href)), page.url());
      screenshot = await page.screenshot({ fullPage: true });
    } catch (e) {
      problems.push(`navigation: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await page.close();
    }
    return { url, status, problems, links, screenshot, source: '' };
  }

  /** Starts the app for a browser/smoke step; its output is kept for the report. */
  private startApp(start: NonNullable<VerificationStep['start']>) {
    const [cmd, ...args] = start.command;
    const child = safeSpawn(resolveCommand(cmd!), args, {
      cwd: this.root,
      env: { ...process.env, CI: '1', BROWSER: 'none', ...(this.opts.env ?? {}), ...start.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let out = '';
    const collect = (d: Buffer) => (out = (out + d.toString('utf8')).slice(-20_000));
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let exited: number | null | undefined;
    const exit = new Promise<void>((r) =>
      child.once('exit', (code) => {
        exited = code;
        r();
      }),
    );
    child.once('error', (e) => {
      out += `\n${e.message}`;
      exited = -1;
    });
    return {
      output: () => out,
      exited: () => exited,
      stop: async () => {
        if (exited !== undefined) return;
        killTree(child);
        await Promise.race([exit, new Promise((r) => setTimeout(r, 5000))]);
      },
    };
  }
}

interface PageCheck {
  url: string;
  status: number;
  problems: string[];
  links: string[];
  screenshot: Buffer | null;
  source: string;
}

async function waitForUrl(url: string, timeoutMs: number, app: { exited(): number | null | undefined }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (app.exited() !== undefined) return { ok: false, reason: `The app exited (code ${app.exited()}) before ${url} answered` };
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { ok: true };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { ok: false, reason: `${url} did not answer within ${timeoutMs} ms of starting the app` };
}

/** Human-readable failure summary fed back to the agent for remediation (spec §44). */
export function failureSummary(run: VerificationRun): string {
  return run.steps
    .filter((s) => s.required && (s.status === 'failed' || s.status === 'error'))
    .map((s) => `### ${s.name} (${s.status}${s.exitCode != null ? `, exit ${s.exitCode}` : ''})\n${s.command ? `Command: ${s.command}\n` : ''}${s.reason ? `Reason: ${s.reason}\n` : ''}\`\`\`\n${(s.outputTail ?? '').slice(-3000)}\n\`\`\``)
    .join('\n\n');
}
export { routesFromFiles, sameOriginLinks } from './routes.js';
