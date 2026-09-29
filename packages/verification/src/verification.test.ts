import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerificationEngine, detectPackageManager, detectSteps, failureSummary } from './index.js';

function project(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-ver-'));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

describe('step detection', () => {
  it('detects node scripts with the right package manager and ignores the npm placeholder test', () => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', build: 'vite build', test: 'echo "Error: no test specified" && exit 1' } }), 'pnpm-lock.yaml': '' });
    expect(detectPackageManager(dir)).toBe('pnpm');
    const steps = detectSteps(dir);
    expect(steps.map((s) => s.kind)).toEqual(['typecheck', 'lint', 'build']);
    expect(steps[0]!.command).toEqual(['pnpm', 'run', 'typecheck']);
  });

  it('detects python, go, rust, php', () => {
    expect(detectSteps(project({ 'pyproject.toml': '', 'tests/test_a.py': '' })).map((s) => s.name)).toEqual(['pytest']);
    expect(detectSteps(project({ 'go.mod': '' })).map((s) => s.kind)).toEqual(['build', 'test']);
    expect(detectSteps(project({ 'Cargo.toml': '' })).map((s) => s.kind)).toEqual(['build', 'test']);
    expect(detectSteps(project({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) }))[0]!.command).toEqual(['composer', 'test']);
  });
});

describe('VerificationEngine', () => {
  it('passes when required steps pass and fails with a remediation summary otherwise', async () => {
    const dir = project({ 'ok.js': 'process.exit(0)', 'bad.js': 'console.error("expected 2 got 3 token=sk-ant-api03-LEAKLEAKLEAKLEAK"); process.exit(1)' });
    const engine = new VerificationEngine(dir);
    const ok = await engine.run([{ kind: 'test', name: 'ok', command: [process.execPath, 'ok.js'], required: true, timeoutMs: 10_000 }], 1);
    expect(ok.status).toBe('passed');
    const bad = await engine.run(
      [
        { kind: 'test', name: 'ok', command: [process.execPath, 'ok.js'], required: true, timeoutMs: 10_000 },
        { kind: 'lint', name: 'bad', command: [process.execPath, 'bad.js'], required: true, timeoutMs: 10_000 },
        { kind: 'custom', name: 'optional-bad', command: [process.execPath, 'bad.js'], required: false, timeoutMs: 10_000 },
      ],
      2,
    );
    expect(bad.status).toBe('failed');
    const summary = failureSummary(bad);
    expect(summary).toContain('bad');
    expect(summary).toContain('expected 2 got 3');
    expect(summary).not.toContain('optional-bad');
    expect(summary).not.toContain('LEAKLEAK');
  });

  it('non-required failures do not fail the run; timeouts do', async () => {
    const dir = project({ 'slow.js': 'setTimeout(()=>{}, 10000)' });
    const r = await new VerificationEngine(dir).run([{ kind: 'test', name: 'slow', command: [process.execPath, 'slow.js'], required: true, timeoutMs: 300 }], 1);
    expect(r.status).toBe('failed');
    expect(r.steps[0]!.outputTail).toContain('timed out');
  });

  it('warns when nothing substantive can be verified', async () => {
    const r = await new VerificationEngine(project({ 'README.md': '' })).run([], 1);
    expect(r.warnings[0]).toMatch(/No automated tests/);
  });

  it('smoke step checks HTTP status; browser step fails honestly without Playwright', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/broken' ? 500 : 200);
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const engine = new VerificationEngine(project({ 'package.json': '{}' }));
    expect((await engine.runStep({ kind: 'smoke', url, required: true, timeoutMs: 5000 })).status).toBe('passed');
    expect((await engine.runStep({ kind: 'smoke', url: url + '/broken', required: true, timeoutMs: 5000 })).status).toBe('failed');
    const b = await engine.runStep({ kind: 'browser', url, required: true, timeoutMs: 5000 });
    expect(b.status).toBe('failed');
    expect(b.reason).toMatch(/Playwright is not installed/);
    server.close();
  });
});
