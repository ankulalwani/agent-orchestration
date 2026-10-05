# Known Limitations

Actual, current limitations. Updated as the implementation changes. Last updated: 2026-10-05.

## Own logins and add-on models (added 2026-09-28)
- **Add-on providers were not called for real.** The gateway was tested with each real harness against a
  fake OpenAI-compatible model; OpenRouter, NVIDIA NIM, Groq, DeepSeek, OpenAI, Gemini, Ollama and LM Studio
  themselves were not used. Models that don't support tool calls can't drive a harness.
- **Codex through the gateway** uses the Responses API (`wire_api = "chat"` is no longer supported by
  Codex). In the test on Windows its own sandbox refused shell commands ("blocked by policy"); the request,
  the tool call and the tool result all went through the gateway.
- **Gemini CLI 0.61** rejects its "gateway" auth type in headless runs, so gateway sessions give it a
  settings home of its own (`GEMINI_CLI_HOME`) that selects API-key authentication. Settings from the user's
  own Gemini home (e.g. its MCP servers) are not loaded in those sessions.
- **What is lost on add-on models:** thinking blocks, prompt caching and hosted server tools (web search).
- **Limits without a reset time** on a harness's own login are retried after 15 minutes.
- **Aider's venv launcher** in this repository's `.tools` folder points at the folder it was created in
  (`E:\new-project`); run it as `python -m aider` or recreate the venv.

## Budgets, schedules, chat, CI and provisioning (added 2026-10-05)
- **Nothing here was run against the real services.** Slack, Microsoft Teams, Jira, Linear, GitHub checks
  and reviews, GitLab job statuses, an embeddings API, Okta and Microsoft Entra ID were each played by a
  local fake that follows their documentation. Security keys were tested with Chromium's virtual
  authenticator, not a physical key.
- **Budgets act between agent sessions.** Spend is reported when a session ends, so a single session can
  overshoot a limit. Agents that report no cost are covered by token limits only.
- **Several agents on one task** need a worker per attempt to run at the same time (attempts share a
  worker's checkout), and a project limit of at least the number of attempts.
- **CI checks** are read for the primary repository only. Full logs are not fetched: the agent gets the
  last 6,000 characters of a failed job's log (GitHub Actions, GitLab CI) or the check's annotations.
- **Follow-ups on review feedback** exist for GitHub only.
- **Microsoft Teams** channels receive notifications; approving from Teams is not built (it needs a bot
  registered with Microsoft).
- **SCIM** covers users, not groups. A suspended member's live dashboard connection ends at its next
  reconnect; API access ends at once.
- **Semantic suggestions** compare the 5,000 most used public packages in memory unless Atlas vector
  search is used; the Atlas path has not been run.
- **Scheduled tasks** start within one sweep interval of their time, and runs missed while the server was
  down are made up once, not one by one.

## Projects, repositories and GitHub (added 2026-09-28)
- **GitHub App against real GitHub.** The manifest flow, installations, sync, webhooks, member authorization,
  repository creation and scoped tokens are tested against a local fake of GitHub's web and REST API, not
  against github.com. Cloning and pushing with an app token (the `http.extraheader` Git environment) were
  not run against GitHub; cloning was tested from a local bare repository.
- **Multi-repository tasks need Claude Code** (`--add-dir`, listed in `claude --help` 2.1.281; the full
  multi-repository flow was tested with the mock agent). Codex, Gemini CLI, OpenCode and Aider don't declare
  the capability, so workers with only those agents don't get tasks of projects with several repositories.
- **Review and plan tasks** of multi-repository projects look at the primary repository only.
- **Discovery on macOS and Linux** scans `/` minus system folders and was only tested on Windows (and on a
  temporary folder tree in the test suite). A first scan of large drives can take minutes.
- **Clone requests** for an offline worker are queued for 7 days and sent once when it connects; after that
  they are dropped.

## Not verified in this environment
- **Docker** was verified with Docker Desktop on Windows (WSL 2), not on a Linux Docker host. The production
  Compose file was run with `DOMAIN=localhost` (Caddy's local certificate), not with a public domain and
  Let's Encrypt.
- **Redis** was tested with a Windows build of Redis 8.10 (redis-windows), not on Linux or a managed
  Redis service. Correctness does not depend on the queue (MongoDB is authoritative, D-003).
- **Claude Code rate-limit fields.** Only `status` and `resetsAt` from `rate_limit_event` drive behaviour. The `utilization` value was observed once and its exact meaning is undocumented, so it is shown only as "reported utilization". The `rejected` status value used to detect a hard limit is assumed, not observed.
- **Only Claude Code has completed a real coding task** (2.1.281 with Haiku 4.5, through the whole
  system). Codex 0.157.1, Gemini CLI 0.61.0, OpenCode 1.18.32 and Aider 0.86.2 were run for real (flags,
  output formats, failure handling), but a successful task needs accounts for them. Success-path events of Codex, Gemini
  CLI and OpenCode follow their documentation. Resume is verified for Claude Code and Codex only.
- **Live provider APIs.** Providers were tested against a local HTTP fake, not the real services.
- **macOS and Linux.** Their installers were only syntax-checked. The Windows installer ran for real
  (scheduled task, restarts, uninstall), but starting at sign-in was not exercised.
- **Playwright browser verification inside tasks** (the `browser` verification step) has been tested
  against a local test page in real Chromium, not against a real project's application.
- **Expo push** has not been tested against the real service. It needs an EAS project id: run `eas init` in
  `apps/mobile`, which writes it to `expo.extra.eas.projectId` in `app.json`. Don't add that key without a real
  id: a `null` value makes Expo Go fail to load the app. SMTP email is tested
  against a local SMTP server, not a hosted mail provider.
- **Mobile app.** Typechecked and bundled for Android and iOS with Metro; not run on a device or emulator.
- **S3 artifact storage** is tested against SeaweedFS (S3-compatible), not against AWS S3 itself.
- **Helm chart and Terraform** were installed on Docker Desktop's single-node Kubernetes, not on a managed
  cloud cluster (EKS/GKE/AKS), and not with an ingress controller or a real Prometheus.
- **Bedrock / Vertex** health checks are verified against signature-checking fakes, not live AWS or Google
  Cloud. They can't check SSO/instance-role (AWS) credentials themselves, and Vertex models are declared manually.
- **Pull requests** (Git policy `PULL_REQUEST`) through the REST API were tested against a fake GitHub and
  GitLab and a real bare remote, not github.com or gitlab.com. The `gh` fallback has not been run.

## Not implemented yet
- **Sign-in for the CLI and mobile app with Google, GitHub or SSO** goes through the web app (device code).
  The mobile flow is bundled but has not run on a phone. Provider sign-in for *model access* exists for OpenRouter (the only one offering OAuth for API keys);
  it was tested against a fake, not openrouter.ai. Two-factor authentication uses
  authenticator-app codes (TOTP) and security keys (WebAuthn); there is no SMS.
- **Worker releases** are hosted by your control plane. Press **Update workers** to fetch the project's signed
  release from GitHub; this needs the server to reach github.com and a release published by the upstream
  release workflow. Air-gapped servers and forks use the custom upload with their own key.
- **Server settings in the dashboard** cover registration, sessions, CORS, rate limits, email, sign-in
  providers and error tracking. Database, Redis, encryption keys, storage, ports, `PUBLIC_URL` and
  intervals are environment-only and need a restart.
- **Plugin isolation** uses the Node.js permission model plus an in-process network block (Node.js 22 has
  no network permission). It is not an OS-level sandbox: a plugin granted `process.execute` or `shell` can
  start unrestricted processes. Plugins need Node.js 22.13+ on the worker. Tested on Windows only.
- **Terraform** deploys onto an existing Kubernetes cluster; it does not create EKS/GKE/AKS clusters.
- **Operating an installation** (on-call, capacity planning, restore drills) is operations work outside this
  repository; the Helm chart provides the backups, autoscaling and alerts it builds on.
- **IDE entry points:** a VS Code extension (built and packaged, not published to the Marketplace). There is no
  JetBrains plugin; JetBrains IDEs can use `agentctl` with an API token.
- **Plans and reviews** have been run with the deterministic mock agent only. How well a real agent
  plans or reviews depends on the agent and model.
- **Integrations** were tested against fakes of the GitHub and GitLab APIs, not the real services.
- **QA route discovery** follows links and file-based routes only. It does not fill in forms or sign in.

## Behavioural limitations
- **Concurrency.** Project, organization, agent and provider limits are enforced atomically. Agent and
  provider slots are taken when a task starts on a target (D-015), so a task can be claimed and prepared
  before it finds out its preferred agent or provider is full; it then uses another compatible target or
  goes back to the queue. Worker capacity is enforced by the worker itself.
- **Priority aging with BullMQ** is applied as of enqueue time, since BullMQ priorities are fixed once a
  job is added. The in-memory queue re-evaluates aging on every dispatch.
- **The OS sandbox for agents (policy `sandbox`) is off by default** and has not been run on Linux or macOS:
  the bubblewrap and Seatbelt invocations are unit-tested, and a task was run end to end through a
  stand-in for bubblewrap on Windows. Windows has no sandbox. Real agents may need extra writable folders
  (`sandbox.writable`) that are not in the built-in list. Without the sandbox, isolation relies on
  project-path mapping, the environment allowlist, the agent's own permission mode (Claude Code defaults
  to `acceptEdits`) and capability permissions.
- **Claude Code in `-p` mode cannot ask interactive questions.** Input requests are therefore mainly
  relevant for agents and scenarios that surface them. Interactive `sendInput` is unsupported for all
  current adapters; input is delivered by starting or resuming a session.
- **Pause** stops the agent process and resumes it later from the checkpoint or session. It does not
  freeze the process.
- **Several API instances need Redis.** Without `REDIS_URL`, dispatch and live updates stay inside one
  instance. With Redis, a new instance learns about connected workers at once; a crashed instance's
  workers are forgotten after about 30 seconds, during which offers to them can go unanswered (the sweeper
  re-offers them).
