/**
 * Shared by the gateway harness tests (and runnable by hand: `npx tsx tests/e2e/gateway-harness.ts <agent>`):
 * runs a real harness CLI through the worker's model gateway against a fake model that asks the harness to
 * create `hello.txt` with its own file tool, then finishes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand } from '@ao/core';
import { AiderAdapter, ClaudeCodeAdapter, CodexAdapter, CopilotAdapter, CrushAdapter, GeminiAdapter, KiloAdapter, OpenCodeAdapter, PiAdapter, QwenAdapter, TraeAdapter, GATEWAY_KIND, type AgentAdapter } from '../../packages/agents/src/index.js';
import { ModelGateway } from '../../apps/worker/src/gateway/server.js';
import { FakeLlm, type FakeRequest } from '../fake-llm.js';

export const CONTENT = 'hello from the add-on model';
const venv = (name: string) => path.resolve(process.platform === 'win32' ? `.tools/${name}/Scripts` : `.tools/${name}/bin`);
const BIN_DIRS = [path.resolve('.tools/agents/node_modules/.bin'), venv('aider-venv'), venv('py-agents-venv')];

export const ADAPTERS: Record<string, AgentAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter(), gemini: new GeminiAdapter(), opencode: new OpenCodeAdapter(), aider: new AiderAdapter(), copilot: new CopilotAdapter(), qwen: new QwenAdapter(), kilo: new KiloAdapter(), pi: new PiAdapter(), crush: new CrushAdapter(), trae: new TraeAdapter() };

/** Finds the harness executable (tools folder first, then PATH). */
export function findExecutable(agent: AgentAdapter): string | null {
  const names = process.platform === 'win32' ? agent.executables.flatMap((e) => [`${e}.cmd`, `${e}.exe`, e]) : agent.executables;
  for (const dir of [...BIN_DIRS, ...(process.env.PATH ?? '').split(path.delimiter)]) for (const n of names) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  return null;
}

/** The fake model: create the file with whichever file tool the harness offers, then say it's done. */
export function scriptedModel(dir: string) {
  return (r: FakeRequest) => {
    const tools = (r.tools ?? []).map((t: any) => t.function?.name as string);
    // Once a tool result came back (harnesses may add text after it), the work is done.
    if (r.messages.some((m) => m.role === 'tool')) {
      // Trae Agent only stops when its `task_done` tool is called.
      if (tools.includes('task_done') && r.messages.filter((m) => m.role === 'tool').length === 1) return { toolCalls: [{ name: 'task_done', arguments: {} }] };
      return { text: 'Created hello.txt. Done.' };
    }
    const file = path.join(dir, 'hello.txt');
    if (tools.includes('Write')) return { text: 'Writing the file.', toolCalls: [{ name: 'Write', arguments: { file_path: file, content: CONTENT } }] };
    if (tools.includes('write_file')) return { toolCalls: [{ name: 'write_file', arguments: { file_path: file, content: CONTENT } }] };
    if (tools.includes('str_replace_based_edit_tool')) return { toolCalls: [{ name: 'str_replace_based_edit_tool', arguments: { command: 'create', path: file, file_text: CONTENT } }] };
    // Copilot CLI's file tool.
    if (tools.includes('create')) return { toolCalls: [{ name: 'create', arguments: { path: file, file_text: CONTENT } }] };
    if (tools.includes('write')) {
      // OpenCode and Kilo Code name the path `filePath`, Crush `file_path`, Pi `path`.
      const props = Object.keys((r.tools ?? []).find((t: any) => t.function?.name === 'write')?.function?.parameters?.properties ?? {});
      const key = ['filePath', 'file_path', 'path'].find((k) => props.includes(k)) ?? 'filePath';
      return { toolCalls: [{ name: 'write', arguments: { [key]: file, content: CONTENT } }] };
    }
    // Codex with a model it has no metadata for: its command tool (the one-liner works in PowerShell, cmd and sh).
    if (tools.includes('exec_command')) return { toolCalls: [{ name: 'exec_command', arguments: { cmd: `node -e "require('fs').writeFileSync('hello.txt','${CONTENT}')"`, workdir: dir } }] };
    if (tools.includes('apply_patch')) return { toolCalls: [{ name: 'apply_patch', arguments: { input: `*** Begin Patch\n*** Add File: hello.txt\n+${CONTENT}\n*** End Patch\n` } }] };
    if (tools.length) return { text: `No known file tool among: ${tools.join(', ')}` };
    // No tools (Aider): its "whole file" edit format.
    return { text: `hello.txt\n\`\`\`\n${CONTENT}\n\`\`\`\n` };
  };
}

export async function runThroughGateway(agentId: string, opts: { timeoutMs?: number; keepDir?: boolean } = {}) {
  const agent = ADAPTERS[agentId]!;
  const exe = findExecutable(agent);
  if (!exe) return { skipped: `${agentId} is not installed` } as const;
  const llm = await new FakeLlm().start();
  const gateway = new ModelGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ao-gw-${agentId}-`));
  const stateDir = path.join(dir, '.agent-orchestration');
  fs.mkdirSync(stateDir, { recursive: true });
  await runCommand('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  llm.handler = scriptedModel(dir);
  const session = await gateway.open({ chain: [{ providerId: 'fake', name: 'Fake', baseUrl: llm.url, apiKey: 'upstream-key', model: 'fake-model', kind: 'openai-compatible' }] });
  try {
    const inv = await agent.buildInvocation(
      { taskId: 't1', cwd: dir, prompt: 'Create hello.txt in the current directory.', provider: { providerId: 'fake', kind: GATEWAY_KIND, modelId: session.alias, apiKey: session.token, baseUrl: session.baseUrl }, sessionId: randomUUID(), stateDir, settings: agentId === 'claude-code' ? { permissionMode: 'acceptEdits' } : {} },
      { installed: true, path: exe, version: null, authenticated: null, notes: [] },
    );
    // Isolated home for harnesses that keep settings there, so the run uses only the gateway.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `ao-gw-home-${agentId}-`));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const env = { ...process.env, ...inv.env, ...(agentId === 'claude-code' ? {} : { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), CODEX_HOME: path.join(home, '.codex') }) };
    // Aider's venv launcher (aider.exe) keeps the path of the folder the venv was created in; running the
    // module with the venv's Python works wherever the folder is now.
    const venvPython = path.join(path.dirname(exe), process.platform === 'win32' ? 'python.exe' : 'python');
    const [command, args] = agentId === 'aider' && fs.existsSync(venvPython) ? [venvPython, ['-m', 'aider', ...inv.args]] : [inv.command, inv.args];
    const r = await runCommand(command, args, { cwd: dir, env, input: inv.stdin ?? '', timeoutMs: opts.timeoutMs ?? 180_000 });
    const file = path.join(dir, 'hello.txt');
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, created: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, requests: llm.requests, dir };
  } finally {
    session.close();
    await gateway.stop();
    llm.close();
    if (!opts.keepDir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('gateway-harness.ts')) {
  const agentId = process.argv[2] ?? 'claude-code';
  runThroughGateway(agentId, { keepDir: true }).then((r) => {
    if ('skipped' in r) return console.log(r.skipped);
    console.log(JSON.stringify({ exitCode: r.exitCode, created: r.created, requests: r.requests.map((q) => ({ model: q.model, tools: (q.tools ?? []).map((t: any) => t.function?.name), last: q.messages.at(-1)?.role })), dir: r.dir }, null, 1));
    console.log('--- stdout tail ---\n' + r.stdout.slice(-1500) + '\n--- stderr tail ---\n' + r.stderr.slice(-1500));
    // What the adapter makes of that output.
    const ctx = { sessionId: null, lastState: null, retryAt: null, detail: null, resultSeen: false, resultIsError: false, recentText: [] as string[] };
    const parse = (text: string, stream: 'stdout' | 'stderr') => text.split(/\r?\n/).filter((l) => l.trim()).flatMap((l) => (ctx.recentText.push(l), ADAPTERS[agentId]!.parseLine(l, stream, ctx)));
    const events = [...parse(r.stdout, 'stdout'), ...parse(r.stderr, 'stderr')];
    console.log('--- events ---\n' + events.filter((e) => e.type !== 'output').map((e) => JSON.stringify(e).slice(0, 200)).join('\n'));
    console.log('--- exit ---\n' + JSON.stringify(ADAPTERS[agentId]!.classifyExit(r.exitCode, null, ctx)));
    if (process.env.AO_HARNESS_SAVE) fs.writeFileSync(process.env.AO_HARNESS_SAVE, r.stdout);
  });
}
