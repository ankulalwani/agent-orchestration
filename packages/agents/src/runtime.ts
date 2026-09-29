import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import pidusage from 'pidusage';
import { TERMINAL_AGENT_STATES, killTree, safeSpawn, type AgentState } from '@ao/core';
import type { AgentAdapter, AgentEvent, AgentInstallation, AgentStartRequest, ParseContext } from './types.js';

/**
 * Shared agent process runtime (spec §7, §31). Spawns the adapter's invocation without a shell,
 * splits output into lines, feeds them through the adapter parser, and emits normalized events.
 *
 * Hang detection (spec §31): a session is *suspected* hung only when, for `hangTimeoutMs`, there has
 * been no output, no project file change, and ~0% CPU in the agent's process. Suspicion is reported
 * as an event with evidence; termination is the recovery engine's decision, not the runtime's.
 */
export interface AgentSession {
  id: string;
  adapterId: string;
  taskId: string;
  pid: number | undefined;
  startedAt: number;
  state: AgentState;
  agentSessionId: string | null;
  events: AsyncIterable<AgentEvent>;
  sendInput(text: string): Promise<void>;
  stop(reason?: string): Promise<void>;
  /** Resolves with the final exit event. */
  done: Promise<Extract<AgentEvent, { type: 'exit' }>>;
  /** Mark time as paused (e.g. while waiting for input) so hang detection doesn't fire. */
  setIdleExpected(expected: boolean): void;
}

export interface RuntimeOptions {
  hangTimeoutMs?: number;
  /** Also watch these paths for modifications as a sign of progress. */
  watchDir?: string;
  sampleIntervalMs?: number;
  onHangSuspected?: (evidence: HangEvidence) => void;
}

export interface HangEvidence {
  silentForMs: number;
  lastOutput: string[];
  cpuPercent: number | null;
  memoryMb: number | null;
  repeatedLine: string | null;
  lastFileChangeMsAgo: number | null;
}

const MAX_LINE = 64 * 1024;

export function startAgentSession(
  adapter: AgentAdapter,
  installation: AgentInstallation,
  req: AgentStartRequest,
  invocation: Awaited<ReturnType<AgentAdapter['buildInvocation']>>,
  opts: RuntimeOptions = {},
): AgentSession {
  const startedAt = Date.now();
  const emitter = new EventEmitter();
  const buffer: AgentEvent[] = [];
  let finished = false;
  let stoppedByUser = false;
  const ctx: ParseContext = { sessionId: req.resumeSessionId ?? null, lastState: null, retryAt: null, detail: null, resultSeen: false, resultIsError: false, recentText: [] };

  const child: ChildProcess = safeSpawn(invocation.command, invocation.args, {
    cwd: req.cwd,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32', // own process group so killTree can signal children
  });

  const session: AgentSession = {
    id: req.sessionId,
    adapterId: adapter.id,
    taskId: req.taskId,
    pid: child.pid,
    startedAt,
    state: 'STARTING',
    agentSessionId: ctx.sessionId,
    events: {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<AgentEvent>>((resolve) => {
              if (buffer.length) return resolve({ value: buffer.shift()!, done: false });
              if (finished) return resolve({ value: undefined, done: true });
              emitter.once('event', () => resolve(buffer.length ? { value: buffer.shift()!, done: false } : { value: undefined, done: true }));
            }),
        };
      },
    },
    async sendInput(text: string) {
      if (!adapter.capabilities(installation).interactiveInput || !child.stdin || child.stdin.destroyed) {
        throw new Error(`${adapter.name} does not accept input while running; the task will resume in a new session with the input`);
      }
      child.stdin.write(adapter.formatInput ? adapter.formatInput(text) : text + '\n');
      idleExpected = false;
    },
    async stop() {
      stoppedByUser = true;
      killTree(child);
    },
    done: new Promise((resolve) => emitter.once('exit', resolve)),
    setIdleExpected(expected: boolean) {
      idleExpected = expected;
      lastActivity = Date.now();
    },
  };

  const push = (e: AgentEvent) => {
    if (e.type === 'session') {
      ctx.sessionId = e.sessionId;
      session.agentSessionId = e.sessionId;
    }
    if (e.type === 'state') {
      session.state = e.state;
      ctx.lastState = e.state;
      if (e.retryAt) ctx.retryAt = e.retryAt;
      if (e.detail) ctx.detail = e.detail;
      if (e.state === 'WAITING_FOR_INPUT') idleExpected = true;
    }
    if (e.type === 'input_request') idleExpected = true;
    buffer.push(e);
    emitter.emit('event');
  };

  // ── Output handling ──────────────────────────────────────────────────────
  let lastActivity = Date.now();
  let idleExpected = false;
  const recent: string[] = [];
  let repeatCount = 0;
  let lastLine = '';
  const lineSplitter = (stream: 'stdout' | 'stderr') => {
    let partial = '';
    return (chunk: Buffer) => {
      lastActivity = Date.now();
      partial += chunk.toString('utf8');
      let idx: number;
      while ((idx = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, idx).replace(/\r$/, '');
        partial = partial.slice(idx + 1);
        handleLine(line, stream);
      }
      if (partial.length > MAX_LINE) {
        handleLine(partial, stream);
        partial = '';
      }
    };
  };
  const handleLine = (rawLine: string, stream: 'stdout' | 'stderr') => {
    const line = rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine;
    if (!line.trim()) return;
    if (line === lastLine) repeatCount++;
    else repeatCount = 0;
    lastLine = line;
    recent.push(line);
    if (recent.length > 50) recent.shift();
    ctx.recentText.push(line);
    if (ctx.recentText.length > 50) ctx.recentText.shift();
    if (session.state === 'STARTING') push({ type: 'state', state: 'RUNNING' });
    for (const e of adapter.parseLine(line, stream, ctx)) push(e);
  };
  child.stdout?.on('data', lineSplitter('stdout'));
  child.stderr?.on('data', lineSplitter('stderr'));

  if (invocation.stdin !== undefined) {
    child.stdin?.write(invocation.stdin);
    if (!invocation.keepStdinOpen) child.stdin?.end();
  } else if (!invocation.keepStdinOpen) {
    child.stdin?.end();
  }
  child.stdin?.on('error', () => undefined); // EPIPE if the agent exits early

  // ── Hang detection ───────────────────────────────────────────────────────
  let lastFileChange: number | null = null;
  let watcher: fs.FSWatcher | null = null;
  if (opts.watchDir) {
    try {
      watcher = fs.watch(opts.watchDir, { recursive: true }, (_ev, file) => {
        if (file && !String(file).split(path.sep).includes('.git')) lastFileChange = Date.now();
      });
      watcher.on('error', () => undefined);
    } catch {
      watcher = null; // recursive watch unsupported on some Linux kernels/filesystems
    }
  }
  let hangReported = false;
  const hangTimeout = opts.hangTimeoutMs ?? 0;
  const sampler =
    hangTimeout > 0
      ? setInterval(async () => {
          if (finished || idleExpected) return;
          const since = Date.now() - Math.max(lastActivity, lastFileChange ?? 0);
          if (since < hangTimeout) {
            hangReported = false;
            return;
          }
          if (hangReported) return;
          let cpu: number | null = null;
          let mem: number | null = null;
          try {
            if (child.pid) {
              const st = await pidusage(child.pid);
              cpu = st.cpu;
              mem = Math.round(st.memory / 1024 / 1024);
            }
          } catch {
            /* process may have exited */
          }
          // A busy CPU means it's thinking/working (e.g. long compile), not hung.
          if (cpu !== null && cpu > 5) return;
          hangReported = true;
          const evidence: HangEvidence = {
            silentForMs: since,
            lastOutput: recent.slice(-10),
            cpuPercent: cpu,
            memoryMb: mem,
            repeatedLine: repeatCount >= 5 ? lastLine : null,
            lastFileChangeMsAgo: lastFileChange ? Date.now() - lastFileChange : null,
          };
          opts.onHangSuspected?.(evidence);
        }, opts.sampleIntervalMs ?? Math.min(15_000, Math.max(250, hangTimeout / 4)))
      : null;

  // ── Exit ─────────────────────────────────────────────────────────────────
  const finish = (code: number | null, signal: string | null, spawnError?: Error) => {
    if (finished) return;
    if (sampler) clearInterval(sampler);
    watcher?.close();
    let verdict: { state: AgentState; detail?: string; retryAt?: number | null };
    if (spawnError) verdict = { state: 'INSTALLATION_NOT_FOUND', detail: spawnError.message };
    else if (stoppedByUser) verdict = { state: 'STOPPED' };
    else verdict = adapter.classifyExit(code, signal, ctx);
    if (!TERMINAL_AGENT_STATES.includes(verdict.state)) verdict = { state: 'FAILED', detail: verdict.detail };
    session.state = verdict.state;
    const exit: Extract<AgentEvent, { type: 'exit' }> = {
      type: 'exit',
      code,
      signal,
      state: verdict.state,
      detail: verdict.detail,
      retryAt: verdict.retryAt ?? null,
      durationMs: Date.now() - startedAt,
    };
    buffer.push(exit);
    finished = true;
    emitter.emit('event');
    emitter.emit('exit', exit);
  };
  child.on('error', (e) => finish(null, null, e));
  child.on('close', (code, signal) => finish(code, signal));

  return session;
}
