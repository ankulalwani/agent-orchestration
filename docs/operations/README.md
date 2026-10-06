# Operating tasks: budgets, schedules, chat and insights

What helps a team run agents day to day:

- [Spend budgets](#spend-budgets): limits on what agents spend, per task, project and organization.
- [Scheduled tasks](#scheduled-tasks): tasks that are created again on a schedule.
- [Chat channels](#chat-channels): notifications in Slack or Microsoft Teams, and approvals from Slack.
- [Insights](#insights): analytics of finished tasks, spend, workers, failures and times, and a weekly digest.
- [Task templates](#task-templates): task text you reuse, with variables.
- [Several agents on one task](#several-agents-on-one-task): the first attempt that passes verification wins.
- [CI checks as verification](#ci-checks-as-verification): failed CI goes back to the agent.
- [Follow-ups](#follow-ups): more work on a finished task's branch and pull request.

Related: [Jira, Linear and review feedback](../integrations/README.md), [security keys and
provisioning](../security/README.md).

## Spend budgets

Budgets are part of the [execution policy](../ARCHITECTURE.md). Set them in **Settings → Execution
policy → Spend budget**, or in the policy JSON:

```json
{ "budget": { "organizationMonthlyUsd": 500, "projectMonthlyUsd": 100, "taskUsd": 5, "taskTokens": 2000000, "warnAt": 0.8 } }
```

| Limit | Covers |
|---|---|
| `taskUsd`, `taskTokens` | One task over its whole life (tokens: input plus output) |
| `projectMonthlyUsd` | Each project, calendar month (UTC) |
| `organizationMonthlyUsd` | All projects together, calendar month (UTC) |

`null` (or an empty field) means no limit, which is the default.

**What happens at a limit**

- A running task stops before its next agent session and goes to **Recovery required**, with the limit
  and the spend as the reason. Raise the limit, then press **Retry**: the task continues from its
  checkpoint.
- A task that is being verified is not stopped. Verification costs nothing and may complete the task. If
  verification fails, the task stops instead of starting a fix.
- Queued tasks do not start. Their status shows why. They start by themselves when the limit is raised or
  the month ends.
- Owners and administrators get one notice per month when a monthly limit passes `warnAt` (80 % by
  default) and one when it is reached (in the app, by email, and in chat channels that take budget notices).

**Which layer sets which limit**

- The organization limit is read from the platform and organization policy only. A project or task
  cannot raise it.
- The project limit is read from the platform, organization and project policy.
- The task limits can be set at any layer. A task's own policy can lower them, never raise them.

**Limits of the limits**

- Spend is what the agent or provider reports when a session ends. One session can therefore overshoot a
  limit; the task stops before the next one. Agents that report no cost (some report tokens only) are not
  covered by a dollar limit; use `taskTokens` for them.
- When a project or organization limit is reached, other running tasks stop when they next report spend
  or ask for another session, not at the same instant.

API: `GET /orgs/:orgId/budget` returns this month's spend against the limits. Each task carries its own
spend in `usage`.

## Scheduled tasks

A schedule creates the same task again and again: nightly dependency updates, a weekly review, a
flaky-test sweep. Manage them on the **Schedules** page (managers and above; permission
`project.update`), or through `/orgs/:orgId/schedules`.

- **When:** a five-field cron expression (`minute hour day-of-month month day-of-week`) read in an IANA
  time zone, for example `0 2 * * *` in `Europe/Berlin`. Lists (`1,15`), ranges (`mon-fri`), steps
  (`*/15`), names and `@hourly`, `@daily`, `@weekly`, `@monthly` work. As in cron, when both day fields
  are restricted, a day matches if either does. A schedule can run every 5 minutes at most.
- **What:** a task title and prompt, kind (code or plan), priority and policy. `{date}` in the title and
  prompt becomes the day of the run (`YYYY-MM-DD`).
- **Overlap:** by default a run is skipped while the task of the previous run is unfinished. A task
  waiting for manual recovery does not hold later runs back. Choose *Create another task anyway* to allow
  overlap.
- **Run now** creates the task at once, as you, without moving the next run.

Tasks are created on behalf of the member who made the schedule (or last changed what it runs), with
that member's current role. If the member leaves the organization, the schedule turns itself off and
says so; save it again to take it over.

A run missed while the server was down runs once when the server is back. Earlier missed runs are not
made up. With several server instances, each run still creates one task. Runs start within one sweep
interval (`SWEEP_INTERVAL_MS`, 10 seconds by default) of their time.

## Chat channels

Set up in **Settings → Chat** (administrators; permission `settings.manage`), or through
`/orgs/:orgId/chat-channels`. A channel has an incoming webhook URL, the notices it takes, and
optionally the projects it is limited to. The webhook URL is a credential: it is stored encrypted and
never shown again. **Send test** posts a test message and shows what the service answered.

### Slack

1. Create a Slack app at api.slack.com/apps, turn on **Incoming Webhooks**, add one for the channel and
   paste its URL.
2. For buttons and commands, also paste the app's **Signing Secret** (Basic Information). After saving,
   the channel shows a **request URL**. Set it as the app's **Interactivity** request URL and as the
   request URL of a **slash command** (for example `/agent`).
3. Each member links their Slack account in **Settings → Your account → Slack** with their Slack member
   ID (Slack: profile → ⋮ → Copy member ID).

Then:

- Approval requests arrive with **Approve** and **Deny** buttons, recovery notices with **Retry**.
- The slash command takes `status`, `approve <task>`, `deny <task> [reason]`, `answer <task> <text>`,
  `retry <task>`, `cancel <task>` and `help`. `<task>` is a task ID or its last 6 characters.

Every request from Slack is checked against Slack's signature (and refused when older than 5 minutes).
An action runs as the organization member whose Slack member ID sent it, with that member's role, and is
audited as that member. Someone who is not linked is told how to link. A Slack member ID can belong to
one member per organization.

### Microsoft Teams

In the Teams channel, add the workflow *Post to a channel when a webhook request is received* (or an
Incoming Webhook connector) and paste its URL. Teams channels get notifications as cards with an **Open
task** link. Approving from Teams is not supported; that needs a bot registered with Microsoft.

On a shared installation (`DEPLOYMENT_MODE=cloud` or `REQUIRE_PUBLIC_CALLBACK_URLS=true`) webhook URLs
must be public `https` URLs.

## Insights

The **Insights** page has five views over the last 7, 30, 90 or 365 days (whole days, UTC), for the
organization or one project. Figures are compared with the period of the same length before.

| View | API | Shows |
|---|---|---|
| Overview | `GET /orgs/:orgId/analytics` | Success rate (completed, of completed and failed; cancelled tasks are left out), first-pass rate, fixes per task, cost, agent time, created to completed; by agent, model and project; tasks finished per day |
| Cost | `…/analytics/cost` | Spend per day (by the day an agent session ended), by project, model and agent, the ten most expensive tasks, and each budget with a month-end forecast (the month's spend so far, continued at the same rate) |
| Workers | `…/analytics/workers` | Per worker: finished tasks, success, agent time, time online, utilization (agent time against time online, for as many tasks as the worker runs at once), cost, stopped tasks |
| Reliability | `…/analytics/reliability` | Why tasks stopped (failed or needed recovery), how many are still stopped or recovered, provider limits, fallbacks, context resets, restarts and fix rounds by agent, and the failure rate and duration of every verification step |
| Flow | `…/analytics/flow` | Median, 90th percentile and average of waiting to start, agent time and created to completed; outcomes by creator, source, kind and priority |

Every view takes `days` (1 to 365) and `projectId`, and `format=csv&table=<name>` returns one of its
tables as a CSV file (the **CSV** button on each table). `agentctl insights [view]` prints the same.

A task counts for the agent and model it finished on. Cost is what agents and providers report; for an
agent that reports none, it is zero. A task waiting for recovery is neither completed nor failed: it is
in the Reliability view, not in the success rate.

Why a task stops is recorded when it stops (`failureCategory` on the task: `verification`,
`agent_error`, `provider_limit`, `budget`, `worker_lost`, `worker_error`, `setup`, `timeout`, `other`),
by the code path that stops it. Time online is added up from worker heartbeats, per UTC day. Both exist
from the release that added them on: earlier stops are not counted, and earlier days show no time online.

### Weekly digest

**Settings → Chat and digest → Weekly digest** (permission `settings.manage`) sends a summary of the
last seven full days once a week, on a weekday and hour in UTC, to email addresses (needs SMTP) and to
chat channels. **Email it to me now** sends it to the caller only. A digest is sent up to 24 hours
after its time; if the server was down for longer, that week is skipped. Several server instances send
one digest. API: `GET`/`PUT /orgs/:orgId/analytics/digest`, `POST …/analytics/digest/send`.

## Task templates

A template is task text with `{{variable}}` placeholders in its title, prompt and background. Keep them
on the **Templates** page (managers and above; permission `project.update`). A template is offered for
every project, or for one.

In the **New task** dialog, choose a template, fill in what it asks for and press **Fill in the task**.
The title and prompt are filled in and can still be changed before you create the task. A variable can
have a label, a default and can be optional; variables used in the text but not described are required.

API: `/orgs/:orgId/task-templates`, and `POST …/task-templates/:id/use` with `projectId` and `values`
creates the task as the caller.

## Several agents on one task

A task that changes code can be tried by 2 to 4 agents at once. In the **New task** dialog, tick the
agents under **Try with several agents**; in the API, send `attempts`:

```json
{ "attempts": [{ "agentId": "claude-code" }, { "agentId": "codex", "providerId": "openai", "modelId": "gpt-5" }] }
```

- Each attempt is a task of its own, pinned to its agent (and model), on its own branch. The task page
  lists the attempts.
- The first attempt that passes verification wins. The attempts still under way are cancelled, and their
  workers are told to stop. A failed attempt does not end the others.
- Attempts work in the project's checkout, so a worker runs one attempt of a task at a time. For attempts
  to run at the same moment you need a worker per attempt, and a project limit
  (`concurrency.perProject`) of at least the number of attempts. With less, they run one after another,
  which still gives you the first agent that succeeds.
- Each attempt spends. [Budgets](#spend-budgets) apply to each.
- Tasks that depend on an attempt depend on that attempt, not on the group.

## CI checks as verification

Local verification runs before a commit. With `verification.ci`, the worker also waits for the CI checks
of the commit it pushed:

```json
{ "git": { "policy": "PULL_REQUEST" }, "verification": { "ci": { "enabled": true, "timeoutMs": 1800000, "required": false } } }
```

- Needs a Git policy that pushes (`COMMIT_AND_PUSH` or `PULL_REQUEST`) and access to the host's API: a
  Git hosting token on the worker, or the GitHub App. GitHub check runs and commit statuses, and GitLab
  pipeline jobs and statuses, are read.
- **Checks fail:** the agent gets the failed checks with their summary and the end of their log (GitHub
  Actions and GitLab CI) or their annotations, fixes the cause, and the fix is committed and pushed to
  the same branch and pull request. This counts as a remediation attempt (`maxRemediationAttempts`).
- **Checks pass:** the task completes; the result lists the checks.
- **Cannot be decided** (no checks reported within `startGraceMs`, no access, not finished within
  `timeoutMs`): a warning on the task when `required` is false (the default), or the task stops for a
  person when it is true.
- A fix that changes nothing after failed checks stops the task for a person.

The checks of the primary repository are awaited; other repositories of a multi-repository project are
not.

## Follow-ups

A follow-up is a new task that continues a finished one: it works on that task's branch (fetching what
others pushed to it since, when that fast-forwards) and adds to its pull request instead of opening a
second one. Press **Follow up** on a completed task, or send `continuesTaskId` when creating a task.
Review feedback on GitHub can create follow-ups by itself: see
[Integrations](../integrations/README.md#follow-ups-on-review-feedback).
