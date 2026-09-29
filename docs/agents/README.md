# Agents

The platform is agent-neutral. The scheduler, task engine, database and UI contain no agent-specific logic. Each agent is an **adapter** in `packages/agents/src/adapters/`.

## Supported adapters

| Agent | Adapter | Contract source | Resume | Structured output / limits |
|---|---|---|---|---|
| Claude Code | `claude-code` | **Verified** against Claude Code 2.1.281 (`--help`, and a real `-p --output-format stream-json --verbose` run) | Yes (`--resume`, `--session-id`) | Yes: `system/init`, `assistant`, `rate_limit_event` (with `resetsAt`), result with cost/usage |
| OpenAI Codex | `codex` | **Verified** against codex-cli 0.157.1: `exec --json --sandbox workspace-write --skip-git-repo-check` | Yes (`exec resume <thread_id>`) | Yes: JSONL `thread.started`, `turn.failed`, `turn.completed` (usage), items |
| Gemini CLI | `gemini` | **Verified** against 0.61.0: `--yolo --skip-trust -o stream-json --session-id <uuid> -p` | No (not verifiable without an account) | Yes: `init`, `message`, `result` |
| OpenCode | `opencode` | **Verified** against 1.18.32: `run --format json --auto -m <provider>/<model>` | No (not verified) | Yes: JSON events with `sessionID` and the provider's HTTP status |
| Aider | `aider` | **Verified** against 0.86.2 (see below) | No | Text: `litellm.<Name>Error` lines |
| Mock | `mock` | In-tree test agent; enable per worker for testing | Yes | Yes |

"Verified" means checked on 2026-09-27 against the installed binary: its `--help`, and real runs with
invalid credentials through the worker's session runtime (`tests/e2e/agent-clis.test.ts`, opt-in with
`AO_TEST_AGENT_CLIS=1`; captured output in `packages/agents/src/adapters/fixtures/`). A successful coding
task needs your account, so success-path events follow each tool's documentation and are parsed
defensively. Resume is claimed only where the resume command was verified; elsewhere recovery starts a
fresh session from the checkpoint.

What the real binaries showed, and what the adapters do about it:
- **Codex** no longer accepts `--full-auto` (the previous adapter failed every task). It also reads more
  input from a piped stdin, so the runtime closes stdin.
- **Gemini CLI** silently downgrades `--yolo` to asking for approval in a folder it doesn't trust yet,
  which stalls a headless run; `--skip-trust` prevents that.
- **OpenCode** needs `--auto` so permission prompts don't block, and names some providers differently
  (`amazon-bedrock`, `azure`, `google-vertex`).
- **Aider** exits with code 0 even when the provider rejects the request; the adapter decides from its
  `litellm.<Name>Error` lines instead. By default it also edits the project's `.gitignore`, writes chat
  history into the project and checks for updates: the adapter passes `--no-gitignore`, moves history
  into the state directory and passes `--analytics-disable --no-check-update`. Its repo-map cache
  (`.aider.tags.cache.v4/`) is hidden from Git through `.git/info/exclude` (the adapter's `gitExcludes`).

## How an agent is chosen

For each task the worker computes compatible **(agent, provider, model)** targets:
- the agent is installed, enabled and not unauthenticated;
- by default the agent's own login is used (provider `native:<agent>`, model `default`); add-on models are used when it reaches its limit, directly when the agent supports the provider, otherwise through the worker's model gateway (see [AI models](../providers/README.md));
- the agent can drive that provider (for example Claude Code with Anthropic or Bedrock);
- the target satisfies the task's required agent capabilities;
- for a project with several repositories, the agent can work in several directories (`additionalDirectories`; Claude Code, through `--add-dir`). See [Projects, repositories and GitHub](../github/README.md);
- organization, project, worker and task policies allow it (allowed, blocked, preferred, cost tier).

Targets are ranked by preference, not by a hard-coded "best agent" list.

## Execution wrapper

Every agent receives the same agent-neutral instructions (`packages/core/src/execution-prompt.ts`). These tell it to:
- inspect before changing anything;
- keep progress in `.agent-orchestration/progress/<task>.json`;
- write and run tests;
- never run destructive Git commands;
- stay inside the project;
- write a completion report.

Below the task, a **Knowledge** section carries background at three levels, in this order, each
left out when empty: organization knowledge (**Settings → General**), project knowledge (project page)
and the task's own background (**New task → Background for the agent**, or `agentctl task create
--knowledge-file`). Never put secrets there; agents get secrets through secret references.

### Review tasks

A task of type **Review** (`kind: "review"` with `review: { base, head }`, **New task → Review changes**,
or `agentctl task create --review-head <branch>`) asks the agent to review the changes on `head` since it
diverged from `base`, instead of changing code. The worker:

1. resolves both refs, fetching them from `origin` when there is one (for pull and merge requests it
   fetches `pull/<n>/head` or `refs/merge-requests/<n>/head`);
2. checks the head out into a **separate Git worktree** under `.agent-orchestration/worktrees/`, so your
   own checkout and branch are never touched, and runs the agent there with the diff in its prompt;
3. accepts the review only if the agent changed no files and wrote a valid
   `.agent-orchestration/progress/<task>.review.json` (`summary`, `verdict`: approve / comment /
   request_changes, `comments` with `path`, optional `line`, `severity` and `body`). Otherwise the
   agent's changes are discarded and it is sent back with the reason;
4. completes the task with the review in the report (no commit, no branch), and removes the worktree.

### Plan tasks (AI project manager)

A task of type **Plan** (`kind: "plan"`, **New task → Plan**, or `agentctl task create --plan`) asks the
agent to act as project manager: study the repository and break the goal into up to 30 tasks, each
self-contained and verifiable, with dependencies where one needs another first. Like a review, it runs
in a worktree of the current commit and must not change files. The plan is accepted only if
`.agent-orchestration/progress/<task>.plan.json` is valid: unique keys, known dependencies, no cycles.
Otherwise the agent is sent back.

Nothing is created until someone with permission to create tasks clicks **Create N tasks** on the
plan's report (or `POST /orgs/:orgId/tasks/:id/apply-plan`, or `agentctl task apply-plan <id>`). The
tasks are created in dependency order, with the plan's summary as their background, and wait for their
dependencies as usual. Applying again returns the same tasks.

Reviews of pull and merge requests can start by themselves and be posted back to the pull or merge
request: see [Integrations](../integrations/README.md#reviews).

Prompts reach agents through stdin or a file, never through a shell command line.

## Recovery

| Agent outcome | What the worker does |
|---|---|
| Rate or capacity limit | Records the limit (with a reset time only if the agent reported one) and applies the fallback policy: switch to a compatible agent/provider/model, wait (`WAITING_FOR_LIMIT`, with backoff when the reset time is unknown), ask the user, or fail. A limit never fails a task by itself. |
| Context exhausted | Checkpoints and starts a **fresh** session from the checkpoint (resuming would bring back the same full context). |
| Crash / failed | Restarts with backoff, resuming the session if supported. Three identical failures in a row, or reaching `maxRestarts` (default 5), leads to `RECOVERY_REQUIRED`. |
| Hang | Suspected only after no output, no file changes and near-zero CPU for `hangTimeoutMs`. Evidence is recorded before the session is stopped. Time spent waiting for limits does not count. |
| Asks a question | `WAITING_FOR_INPUT`. The answer from the dashboard, CLI or API is passed to the next session. |
| Auth required / not installed | Tries another compatible target, otherwise `RECOVERY_REQUIRED` with instructions. |

All of these paths are covered by end-to-end tests using the mock agent (`tests/e2e/worker-flow.test.ts`).

## Adding an adapter

Implement `AgentAdapter` (`packages/agents/src/types.ts`):
- `detect()`
- `capabilities()`
- `buildInvocation()`, which returns an argv array, env and stdin, never a shell string
- `parseLine()`, which maps output to normalized events
- `classifyExit()`
- optionally `capabilities().gitExcludes`: paths the CLI leaves in the project (caches, histories) that
  must never be committed; the worker adds them to `.git/info/exclude`

Register it in `defaultAgentManager()`. The shared runtime handles process lifecycle, streaming, hang detection and termination.
