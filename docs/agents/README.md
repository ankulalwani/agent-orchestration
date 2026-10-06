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
| Cursor Agent | `cursor` | **Verified** against 2026.10.01: `cursor-agent -p --output-format stream-json --force --trust` | No | Yes: Claude-style stream JSON |
| GitHub Copilot CLI | `copilot` | **Verified** against 1.0.92: `--allow-all-tools --no-ask-user --no-auto-update --output-format json -p`; run through the gateway | No | Yes: JSONL `assistant.message`, `tool.execution_start`, `result` |
| Kiro CLI | `kiro` | **Documentation only** (no Windows build to run): `kiro-cli chat --no-interactive --trust-all-tools` | No | Text |
| Qwen Code | `qwen` | **Verified** against 0.25.0: `--yolo --output-format stream-json --session-id <uuid>`; run through the gateway | No | Yes: Claude-style stream JSON |
| Kimi Code | `kimi` | **Verified** against 2.1.1: `--output-format stream-json -p` | No | Yes: JSON lines with a role |
| Grok CLI | `grok` | **Verified** against 1.0.46: `--prompt-file <file> --output-format streaming-json --always-approve --session-id <uuid>` | No | Yes: one ACP session update per line |
| Trae Agent | `trae` | **Verified** against 0.1.0: `trae-cli run --file <file> --config-file <yaml> --console-type simple`; run through the gateway | No | Text: its summary table |
| Amp | `amp` | **Verified** against the 2026-10-06 build: `--stream-json -x`, with `amp.dangerouslyAllowAll` in a settings file | No | Yes: Claude-style stream JSON |
| Factory Droid | `droid` | **Verified** against 0.233.0: `droid exec --output-format stream-json --auto medium -f <file>` | No | Yes: `system`, `message`, `tool_call`, `completion`, `error` |
| Auggie | `auggie` | **Verified** against 0.36.0: `--print --output-format json --instruction-file <file>` | No | One JSON result |
| Crush | `crush` | **Verified** against 0.97.1: `crush run --quiet`; run through the gateway | No | Text |
| Cline | `cline` | **Verified** against 3.0.68: `--json --auto-approve true` | No | Yes: `agent_event`, `run_result` (usage and cost) |
| Kilo Code | `kilo` | **Verified** against 7.8.3: `kilo run --format json --auto` (OpenCode's command line and events); run through the gateway | No | Yes: as OpenCode |
| Pi | `pi` | **Verified** against 0.73.1: `pi -p --mode json`; run through the gateway | No | Yes: `session`, `tool_execution_start`, `message_end` (usage and cost) |
| Continue CLI | `continue` | **Verified** against 1.5.47: `cn -p --auto --format json` | No | One JSON result |
| Qoder CLI | `qoder` | **Verified** against 1.1.65: `qodercli -p --output-format stream-json --dangerously-skip-permissions --session-id <uuid>` | No | Yes: Claude-style stream JSON |
| CodeBuddy Code | `codebuddy` | **Verified** against 2.161.4: `codebuddy -p --output-format stream-json -y --session-id <uuid>` | No | Yes: Claude-style stream JSON |
| Mistral Vibe | `vibe` | **Verified** against 2.2.1: `vibe --output streaming -p` | No | Yes: one JSON message per line |
| Mock | `mock` | In-tree test agent; enable per worker for testing | Yes | Yes |

"Verified" means checked against the installed binary (the first five on 2026-09-27, the rest on
2026-10-06): its `--help`, and real runs without valid credentials through the worker's session runtime
(`tests/e2e/agent-clis.test.ts`, opt-in with `AO_TEST_AGENT_CLIS=1`; captured output in
`packages/agents/src/adapters/fixtures/`). A successful coding task needs your account, so success-path
events follow each tool's documentation and are parsed defensively; the agents marked "run through the
gateway" also completed a task against a fake model (`tests/e2e/gateway-agents.test.ts`), which shows
their real success-path events. Resume is claimed only where the resume command was verified; elsewhere
recovery starts a fresh session from the checkpoint.

### Which models each agent can use

| Agent | Its own login | Add-on models through the gateway | Providers it uses directly |
|---|---|---|---|
| Claude Code | Yes | Yes | Anthropic, Bedrock, Vertex |
| Codex | Yes | Yes | OpenAI, Azure OpenAI, OpenAI-compatible, Ollama, OpenRouter |
| Gemini CLI | Yes | Yes | Google, Vertex |
| OpenCode, Kilo Code | Yes | Yes | Anthropic, OpenAI, Google, OpenRouter, Ollama, OpenAI-compatible, Azure OpenAI, Bedrock |
| Aider | Yes | Yes | The same as OpenCode |
| GitHub Copilot CLI | Yes (GitHub) | Yes | OpenAI, OpenAI-compatible, Ollama, Anthropic, Azure OpenAI (its custom-provider variables) |
| Qwen Code | Yes (its settings) | Yes | OpenAI, OpenAI-compatible |
| Trae Agent | No: it always needs a provider | Yes | OpenAI, OpenAI-compatible, Anthropic, Google, OpenRouter, Ollama |
| Crush | Yes (its configuration or provider keys) | Yes | Anthropic, OpenAI, Google, OpenRouter |
| Pi | Yes | Yes | Anthropic, OpenAI, Google, OpenRouter, Bedrock |
| Cursor Agent, Kiro CLI, Kimi Code, Grok CLI, Amp, Factory Droid, Auggie, Cline, Continue CLI, Qoder CLI, CodeBuddy Code, Mistral Vibe | Yes: only this | No | None |

The agents in the last row only talk to their vendor's service (or, for Cline, Continue and Mistral
Vibe, to what their own configuration names). Sign in on the worker once, or put the vendor's key in the
task's environment profile (the worker's own environment is not passed to agents): `CURSOR_API_KEY`, `KIRO_API_KEY`, `XAI_API_KEY`, `AMP_API_KEY`,
`FACTORY_API_KEY`, `AUGMENT_SESSION_AUTH`, `MISTRAL_API_KEY`. When such an agent reaches its limit, the
task moves to another agent rather than to an add-on model.

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
- **Cursor Agent** needs `--force` (run commands without asking) and `--trust` (skip the workspace trust
  prompt), or a headless run waits. Its installer also names the program `agent`; the worker looks for
  `cursor-agent` only.
- **Copilot CLI** needs `--allow-all-tools` ("required for non-interactive mode") and `--no-ask-user`.
  With `COPILOT_PROVIDER_BASE_URL` set it uses that endpoint and needs no GitHub login, which is how it
  reaches add-on models.
- **Qwen Code** has no default login in headless runs ("No auth type is selected"): the worker passes
  `--auth-type openai` only when it gives Qwen an OpenAI-compatible endpoint, and otherwise leaves the
  choice to Qwen's own settings.
- **Kimi Code** replaces the Python `kimi-cli`, which now only prints that it is no longer maintained.
  Its prompt mode refuses `--yolo` and `--auto`.
- **Trae Agent** has no login and needs a configuration file for every run; the worker writes one into
  the state directory, without the key (that goes in the provider's `<PROVIDER>_API_KEY` variable). It
  exits with code 0 whatever happened, so its summary table decides. Its `openai` provider speaks the
  Responses API without streaming; OpenAI-compatible endpoints and the gateway use its `openrouter`
  provider, which is plain chat completions with a base URL.
- **Amp** has no flag to switch command confirmations off: the worker passes a settings file with
  `amp.dangerouslyAllowAll`. Without a login it starts a browser login and waits; the worker reports
  that as "sign-in required" as soon as the line appears.
- **Factory Droid** is read-only without `--auto`. The worker uses `medium` (edits, builds, local Git,
  no push); change it per worker with the adapter setting `autonomy` (`low`, `medium`, `high`).
- **CodeBuddy Code** and **Mistral Vibe** exit with code 0 when nobody is signed in (Vibe after opening
  its setup screen): the output decides, not the exit code.
- **Continue CLI** takes its model from its own configuration (`--model` wants a hub slug), and
  **Amp** and **Mistral Vibe** have no model flag either, so tasks cannot choose a model for them.

## How an agent is chosen

For each task the worker computes compatible **(agent, provider, model)** targets:
- the agent is installed, enabled and not unauthenticated;
- by default the agent's own login is used (provider `native:<agent>`, model `default`); add-on models are used when it reaches its limit, directly when the agent supports the provider, otherwise through the worker's model gateway (see [AI models](../providers/README.md));
- the agent can drive that provider (for example Claude Code with Anthropic or Bedrock);
- the target satisfies the task's required agent capabilities;
- for a project with several repositories, the agent can work in several directories (`additionalDirectories`; Claude Code, Cursor Agent, Copilot CLI, Qwen Code, Kimi Code, Qoder CLI and CodeBuddy Code through `--add-dir`, Auggie through `--add-workspace`). See [Projects, repositories and GitHub](../github/README.md);
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
