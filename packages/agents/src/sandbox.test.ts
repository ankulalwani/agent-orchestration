import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectSandbox, seatbeltProfile, wrapInvocation } from './sandbox.js';

function tree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sb-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const tmp = path.join(base, 'tmp');
  for (const d of [path.join(home, '.ssh'), path.join(home, '.claude'), path.join(home, '.cache'), project, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.netrc'), 'machine x password y');
  return { home, project, tmp };
}
const inv = { command: '/usr/bin/claude', args: ['-p', '--verbose'], env: { A: '1' }, stdin: 'prompt' };

describe('agent sandbox (SEC-014)', () => {
  it('detects what the platform offers; overrides for non-standard installs', () => {
    expect(detectSandbox('win32', {})).toMatchObject({ backend: null, reason: expect.stringContaining('win32') });
    expect(detectSandbox('linux', { PATH: '' })).toMatchObject({ backend: null, reason: expect.stringContaining('bubblewrap') });
    expect(detectSandbox('win32', { AO_SANDBOX_BACKEND: 'bubblewrap', AO_SANDBOX_EXECUTABLE: '/opt/bwrap' })).toEqual({ backend: 'bubblewrap', executable: '/opt/bwrap', reason: null });
  });

  it('bubblewrap: read-only root, writable project/temp/agent state, credential folders hidden, optional network cut', () => {
    const { home, project, tmp } = tree();
    const out = wrapInvocation(inv, { backend: 'bubblewrap', executable: '/usr/bin/bwrap', reason: null }, 'claude-code', { projectDir: project, writable: [], hidden: [path.join(home, 'nope')], network: false }, home, tmp);
    expect(out.command).toBe('/usr/bin/bwrap');
    expect(out.stdin).toBe('prompt');
    expect(out.env).toEqual({ A: '1' });
    const a = out.args.join(' ');
    expect(a).toContain('--ro-bind / /');
    expect(a).toContain(`--bind ${project} ${project}`);
    expect(a).toContain(`--bind ${tmp} ${tmp}`);
    expect(a).toContain(`--bind ${path.join(home, '.claude')} ${path.join(home, '.claude')}`);
    expect(a).toContain(`--tmpfs ${path.join(home, '.ssh')}`);
    expect(a).toContain(`--ro-bind /dev/null ${path.join(home, '.netrc')}`);
    expect(a).not.toContain('nope'); // only existing paths
    expect(out.args).toContain('--unshare-net');
    expect(out.args.slice(out.args.indexOf('--'))).toEqual(['--', '/usr/bin/claude', '-p', '--verbose']);
    // Another agent does not get Claude's state folder.
    const codex = wrapInvocation(inv, { backend: 'bubblewrap', executable: 'bwrap', reason: null }, 'codex', { projectDir: project, writable: [], hidden: [], network: true }, home, tmp);
    expect(codex.args.join(' ')).not.toContain('.claude');
    expect(codex.args).not.toContain('--unshare-net');
  });

  it('sandbox-exec: Seatbelt profile denies writes outside allowed paths and reads of hidden ones', () => {
    const { home, project, tmp } = tree();
    const out = wrapInvocation(inv, { backend: 'sandbox-exec', executable: '/usr/bin/sandbox-exec', reason: null }, 'claude-code', { projectDir: project, writable: [], hidden: [], network: false }, home, tmp);
    expect(out.args[0]).toBe('-p');
    expect(out.args.slice(2)).toEqual(['/usr/bin/claude', '-p', '--verbose']);
    const profile = out.args[1]!;
    expect(profile).toMatch(/^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)/);
    expect(profile).toContain(`(subpath ${JSON.stringify(project)})`);
    expect(profile).toMatch(new RegExp(`\\(deny file-read\\* .*${JSON.stringify(path.join(home, '.ssh')).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    expect(profile).toContain('(deny network*)');
    expect(seatbeltProfile(['/p'], [], true)).not.toContain('network');
  });
});
