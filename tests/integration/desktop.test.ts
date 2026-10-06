/**
 * Desktop app (apps/desktop): the parts that are not Rust. The Node.js download it ships is checked against a
 * pinned checksum, and the worker gives the app a way to stop it. The shell itself is tested with `cargo test`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { buildLocalApi } from '../../apps/worker/src/local-api.js';
// @ts-expect-error a plain script without type declarations
import { NODE_BUILDS, NODE_VERSION, fetchNode, hostTarget, verifyChecksum } from '../../apps/desktop/scripts/fetch-node.mjs';
// @ts-expect-error a plain script without type declarations
import { collect, latestJson } from '../../apps/desktop/scripts/release-assets.mjs';

process.env.AO_CREDENTIAL_BACKEND = 'file';

describe('desktop app: bundled Node.js', () => {
  it('pins one build per supported system, by checksum', () => {
    expect(Object.keys(NODE_BUILDS).sort()).toEqual(['aarch64-apple-darwin', 'aarch64-pc-windows-msvc', 'aarch64-unknown-linux-gnu', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']);
    for (const build of Object.values(NODE_BUILDS) as Array<{ file: string; sha256: string }>) {
      expect(build.sha256).toMatch(/^[a-f0-9]{64}$/);
      if (!build.file.endsWith('node.exe')) expect(build.file).toContain(`v${NODE_VERSION}`);
    }
    expect(new Set(Object.values(NODE_BUILDS).map((b) => (b as { sha256: string }).sha256)).size).toBe(6);
  });

  it('maps this machine to a target, and refuses one without a pinned build', () => {
    expect(hostTarget('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(hostTarget('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(hostTarget('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(() => hostTarget('linux', 'riscv64')).toThrow(/No Node.js build is pinned/);
    expect(() => hostTarget('freebsd', 'x64')).toThrow(/No Node.js build is pinned/);
  });

  it('writes nothing when the download does not match the pinned checksum', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-node-'));
    const changed = (async () => new Response(Buffer.from('not the Node.js that was pinned'))) as unknown as typeof fetch;
    for (const target of ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
      await expect(fetchNode({ target, outDir, fetchImpl: changed })).rejects.toThrow(/does not match its pinned checksum/);
    }
    expect(fs.readdirSync(outDir)).toEqual([]);
    await expect(fetchNode({ target: 'x86_64-pc-windows-msvc', outDir, fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch })).rejects.toThrow(/HTTP 404/);
    await expect(fetchNode({ target: 'mips-unknown-linux-gnu', outDir })).rejects.toThrow(/No Node.js build is pinned/);
    // The GNU toolchain on Windows gets the same binary under its own name, and the same check.
    await expect(fetchNode({ target: 'x86_64-pc-windows-gnu', outDir, fetchImpl: changed })).rejects.toThrow(/win-x64\/node\.exe does not match its pinned checksum/);
    expect(fs.readdirSync(outDir)).toEqual([]);
    expect(() => verifyChecksum(Buffer.from('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc')).not.toThrow();
  });
});

describe('desktop app: release files', () => {
  /** What `tauri build` leaves in `bundle/` for one target. */
  function bundle(files: Record<string, string[]>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bundle-'));
    for (const [folder, names] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      for (const name of names) fs.writeFileSync(path.join(dir, folder, name), name.endsWith('.sig') ? `signature of ${name.slice(0, -4)}\n` : 'binary');
    }
    return dir;
  }

  it('gives the installers names without a version and lists the signed ones for the updater', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-assets-'));
    const windows = bundle({ nsis: ['Agent Orchestration Worker_0.3.0_x64-setup.exe', 'Agent Orchestration Worker_0.3.0_x64-setup.exe.sig'] });
    const mac = bundle({ dmg: ['Agent Orchestration Worker_0.3.0_aarch64.dmg'], macos: ['Agent Orchestration Worker.app.tar.gz', 'Agent Orchestration Worker.app.tar.gz.sig'] });
    const linux = bundle({ appimage: ['Agent Orchestration Worker_0.3.0_amd64.AppImage'], deb: ['Agent Orchestration Worker_0.3.0_amd64.deb'] }); // built without the key
    expect(collect(windows, 'x86_64-pc-windows-msvc', out)).toEqual(['agent-orchestration-worker-windows-x64-setup.exe', 'agent-orchestration-worker-windows-x64-setup.exe.sig']);
    expect(collect(mac, 'aarch64-apple-darwin', out)).toEqual(['agent-orchestration-worker-macos-arm64.dmg', 'agent-orchestration-worker-macos-arm64.app.tar.gz', 'agent-orchestration-worker-macos-arm64.app.tar.gz.sig']);
    expect(collect(linux, 'x86_64-unknown-linux-gnu', out)).toEqual(['agent-orchestration-worker-linux-x64.AppImage', 'agent-orchestration-worker-linux-x64.deb']);

    const latest = latestJson(out, '0.3.0', 'https://github.com/o/r/releases/download/v0.3.0/', new Date('2026-10-06T00:00:00Z'));
    expect(latest).toEqual({
      version: '0.3.0',
      notes: 'Agent Orchestration Worker 0.3.0',
      pub_date: '2026-10-06T00:00:00.000Z',
      platforms: {
        'windows-x86_64': { signature: 'signature of Agent Orchestration Worker_0.3.0_x64-setup.exe', url: 'https://github.com/o/r/releases/download/v0.3.0/agent-orchestration-worker-windows-x64-setup.exe' },
        'darwin-aarch64': { signature: 'signature of Agent Orchestration Worker.app.tar.gz', url: 'https://github.com/o/r/releases/download/v0.3.0/agent-orchestration-worker-macos-arm64.app.tar.gz' },
        // No linux entry: an unsigned file is never offered as an update.
      },
    });
  });

  it('writes no update list when nothing is signed, and fails when a build left no installer', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-assets-'));
    collect(bundle({ deb: ['x_0.3.0_amd64.deb'], appimage: ['x_0.3.0_amd64.AppImage'] }), 'x86_64-unknown-linux-gnu', out);
    expect(latestJson(out, '0.3.0', 'https://example.com')).toBeNull();
    expect(() => collect(bundle({ nsis: [] }), 'x86_64-pc-windows-msvc', out)).toThrow(/No installer found/);
    expect(() => collect(bundle({ nsis: ['a-setup.exe', 'b-setup.exe'] }), 'x86_64-pc-windows-msvc', out)).toThrow(/More than one/);
    expect(() => collect(bundle({}), 'sparc-sun-solaris', out)).toThrow(/Unknown target/);
  });
});

describe('desktop app: stopping its worker', () => {
  it('the local API has a shutdown call only when the app started the worker, and it needs the local token', async () => {
    const rt = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-desk-')));
    await rt.init();
    const headers = { host: '127.0.0.1:47821', authorization: `Bearer ${await rt.localUiToken()}` };
    let stops = 0;
    const desktop = await buildLocalApi(rt, { onShutdown: () => void stops++ });
    const headless = await buildLocalApi(rt);
    try {
      expect((await desktop.inject({ method: 'POST', url: '/api/shutdown', headers: { host: headers.host } })).statusCode).toBe(401);
      expect(stops).toBe(0);
      const ok = await desktop.inject({ method: 'POST', url: '/api/shutdown', headers });
      expect(ok.statusCode).toBe(200);
      await expect.poll(() => stops).toBe(1); // after the answer was sent
      expect((await headless.inject({ method: 'POST', url: '/api/shutdown', headers })).statusCode).toBe(404);
    } finally {
      await desktop.close();
      await headless.close();
      await rt.stop();
    }
  });
});
