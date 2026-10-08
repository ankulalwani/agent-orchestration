#!/usr/bin/env node
// Deterministic mock coding agent used by tests and demos. Reads the prompt on stdin, performs a
// scripted scenario in the current directory, and prints JSON lines understood by MockAgentAdapter.
import fs from 'node:fs';
import path from 'node:path';

const scenario = process.env.AO_MOCK_SCENARIO ?? 'success';
const session = process.env.AO_MOCK_SESSION ?? 'mock-session';
const taskId = process.env.AO_MOCK_TASK ?? 'task';
const stateDir = process.env.AO_MOCK_STATE_DIR ?? '.agent-orchestration';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', run);

function progress(extra) {
  const file = path.join(stateDir, 'progress', `${taskId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { completedSteps: [], remainingSteps: ['implement', 'test'], changedFiles: [], testsRun: [], knownIssues: [] };
  const next = { ...prev, ...extra };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

function implement() {
  const counterFile = path.join(process.cwd(), 'mock-output.txt');
  const n = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8').split('\n')[0]) || 0 : 0;
  fs.writeFileSync(counterFile, `${n + 1}\nprompt-has-resume:${prompt.includes('Resume from checkpoint')}\nprompt-has-failures:${prompt.includes('Verification failed')}\nmcp-servers:${process.env.AO_MOCK_MCP_SERVERS ?? ''}\nprompt-markers:${(prompt.match(/\bMARKER-[\w-]+/g) ?? []).join(',')}\n`);
  // Like real CLIs (e.g. Aider's repo-map cache), leave a cache in the project that must not be committed.
  fs.mkdirSync(path.join(process.cwd(), '.mock-cache'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.mock-cache', 'index.json'), '{}');
  // Multi-repository projects: change every other repository the agent was given.
  for (const dir of (process.env.AO_MOCK_EXTRA_DIRS ?? '').split(path.delimiter).filter(Boolean)) {
    fs.writeFileSync(path.join(dir, 'mock-output.txt'), `changed by task ${taskId}\nprompt-lists-repo:${prompt.includes(dir)}\n`);
  }
  return 'mock-output.txt';
}

function finish(text = 'Done') {
  fs.writeFileSync(path.join(stateDir, 'progress', `${taskId}.report.md`), `# Summary\n${text}\n\n# Remaining work\nNone\n`);
  out({ t: 'usage', in: 1000, out: 200, cost: 0.01 });
  out({ t: 'result', text });
  process.exit(0);
}

/** Through the model gateway: one OpenAI chat request; a limit from it ends the session as a limit. */
async function askGateway() {
  const res = await fetch(`${process.env.AO_MOCK_GATEWAY_URL}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AO_MOCK_GATEWAY_KEY}` },
    body: JSON.stringify({ model: process.env.AO_MOCK_GATEWAY_MODEL, messages: [{ role: 'user', content: 'Say hello' }] }),
  });
  const body = await res.json();
  if (res.status === 429) {
    out({ t: 'limit', retryAt: null });
    process.exit(1);
  }
  if (!res.ok) {
    process.stderr.write(`gateway error ${res.status}: ${JSON.stringify(body)}\n`);
    process.exit(1);
  }
  const text = body.choices?.[0]?.message?.content ?? '';
  out({ t: 'say', text: `gateway said: ${text}` });
  fs.writeFileSync(path.join(stateDir, 'gateway-reply.txt'), text);
}

function run() {
  if (process.env.AO_MOCK_GATEWAY_URL && !globalThis.__gatewayAsked) {
    globalThis.__gatewayAsked = true;
    askGateway().then(run, (e) => {
      process.stderr.write(`gateway unreachable: ${e.message}\n`);
      process.exit(1);
    });
    return;
  }
  out({ t: 'session', id: session });
  out({ t: 'say', text: `Working on scenario ${scenario}` });
  // Tests: report environment variables the agent received (names listed in AO_MOCK_ECHO_ENV).
  for (const name of (process.env.AO_MOCK_ECHO_ENV ?? '').split(',').filter(Boolean)) out({ t: 'say', text: `env ${name}=${process.env[name] ?? ''}` });
  progress({ phase: 'implement', nextAction: 'implement' });
  const resumed = prompt.includes('Resume from checkpoint');
  switch (scenario) {
    case 'plan':
    case 'plan_cycle': {
      // Plans: `plan_cycle` first writes tasks that depend on each other in a cycle.
      const cycle = scenario === 'plan_cycle' && !prompt.includes('Verification failed');
      const tasks = [
        { key: 'schema', title: 'Add the orders table', prompt: 'Add an orders table with a migration and tests.', dependsOn: cycle ? ['ui'] : [] },
        { key: 'api', title: 'Orders API', prompt: 'Add GET/POST /orders using the new table, with tests.', dependsOn: ['schema'], priority: 'HIGH' },
        { key: 'ui', title: 'Orders page', prompt: 'Add an orders page that lists orders from the API.', dependsOn: ['api'] },
      ];
      fs.writeFileSync(path.join(stateDir, 'progress', `${taskId}.plan.json`), JSON.stringify({ summary: `Three steps. MARKER-${prompt.includes('## Planning rules') ? 'PLANNING' : 'NO-RULES'}`, tasks }));
      return finish('Plan written');
    }
    case 'review':
    case 'review_dirty': {
      // Reviews: write the review JSON; `review_dirty` first changes a file (not allowed) and only
      // writes a valid review once sent back.
      if (scenario === 'review_dirty' && !prompt.includes('Verification failed')) {
        fs.writeFileSync(path.join(process.cwd(), 'reviewer-was-here.txt'), 'x');
        return finish('Reviewed (and edited a file)');
      }
      const reviewed = prompt.match(/## Changes to review: (\S+)/)?.[1] ?? '?';
      fs.writeFileSync(
        path.join(stateDir, 'progress', `${taskId}.review.json`),
        JSON.stringify({
          summary: `Reviewed ${reviewed}. MARKER-${prompt.includes('+feature line') ? 'DIFF-SEEN' : 'NO-DIFF'}`,
          verdict: 'request_changes',
          comments: [{ path: 'feature.txt', line: 1, severity: 'major', body: 'Needs a test.' }, { path: 'feature.txt', severity: 'nit', body: 'Typo.' }],
        }),
      );
      return finish('Review written');
    }
    case 'resolve': {
      // Merge conflicts: the first session leaves the markers in; once sent back, it keeps both sides.
      implement();
      if (prompt.includes('Verification failed')) {
        for (const f of fs.readdirSync(process.cwd())) {
          const p = path.join(process.cwd(), f);
          if (!fs.statSync(p).isFile()) continue;
          const text = fs.readFileSync(p, 'utf8');
          if (/^<{7} /m.test(text)) fs.writeFileSync(p, text.replace(/^(?:<{7}|>{7}) .*\r?\n|^={7}\r?\n/gm, ''));
        }
      }
      return finish(`Resolved. MARKER-${prompt.includes('produced conflicts in:') ? 'CONFLICTS-LISTED' : 'NO-CONFLICTS'}`);
    }
    case 'success': {
      const f = implement();
      out({ t: 'tool', name: 'Edit', summary: f });
      progress({ phase: 'done', completedSteps: ['implement', 'test'], remainingSteps: [], changedFiles: [f], nextAction: '' });
      return finish('Implemented the change');
    }
    case 'slow':
      implement();
      return setTimeout(() => finish('Slow success'), Number(process.env.AO_MOCK_DELAY_MS ?? 1500));
    case 'rate_limit':
    case 'limit_once': {
      // limit_once: hit a limit on the first session only (resumed prompts succeed).
      if (scenario === 'limit_once' && resumed) {
        implement();
        return finish('Completed after limit');
      }
      progress({ completedSteps: ['analysis'], nextAction: 'implement' });
      out({ t: 'limit', retryAt: process.env.AO_MOCK_RETRY_AT ? Number(process.env.AO_MOCK_RETRY_AT) : null });
      return process.exit(1);
    }
    case 'context':
    case 'context_once':
      if (scenario === 'context_once' && resumed) {
        implement();
        return finish('Completed after context reset');
      }
      progress({ completedSteps: ['analysis', 'half of implement'], nextAction: 'finish implement' });
      out({ t: 'context' });
      return process.exit(1);
    case 'auth':
      out({ t: 'auth' });
      return process.exit(1);
    case 'key_expires': {
      // Credentials that stop working mid-task: real progress first, then the provider rejects the key.
      // With a valid key (anything not starting with "expired") the task completes.
      if (!(process.env.AO_MOCK_API_KEY ?? '').startsWith('expired')) {
        const f = implement();
        progress({ phase: 'done', completedSteps: ['analysis', 'part 1', 'part 2'], remainingSteps: [], changedFiles: [f], nextAction: '' });
        return finish('Completed with a valid key');
      }
      fs.writeFileSync(path.join(process.cwd(), 'mock-partial.txt'), 'part 1 done\n');
      progress({ completedSteps: ['analysis', 'part 1'], remainingSteps: ['part 2'], changedFiles: ['mock-partial.txt'], nextAction: 'part 2' });
      out({ t: 'auth' });
      return process.exit(1);
    }
    case 'crash':
      process.stderr.write('Segmentation fault (simulated)\n');
      return process.exit(139);
    case 'flaky': {
      const marker = path.join(stateDir, `flaky-${taskId}`);
      if (!fs.existsSync(marker)) {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(marker, '1');
        process.stderr.write('Unexpected crash (simulated)\n');
        return process.exit(3);
      }
      implement();
      return finish('Recovered after crash');
    }
    case 'hang':
      out({ t: 'say', text: 'about to hang' });
      return setInterval(() => {}, 1 << 30);
    case 'input':
      if (prompt.includes('Response from user')) {
        implement();
        return finish('Used the user response');
      }
      out({ t: 'ask', question: 'Which payment currency should be the default?' });
      return process.exit(0);
    case 'fail':
      out({ t: 'result', error: true, text: 'Could not complete' });
      return process.exit(1);
    default:
      process.stderr.write(`unknown scenario ${scenario}\n`);
      process.exit(2);
  }
}
