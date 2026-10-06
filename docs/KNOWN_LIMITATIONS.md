# Known Limitations

Actual, current limitations. Updated as the implementation changes. Last updated: 2026-10-06.

## Desktop app (added 2026-10-06)
- **Not code-signed.** Windows SmartScreen and macOS Gatekeeper warn on the first start (how to continue:
  [workers](workers/README.md#install)). The app's own updates are signed with the project's updater key
  and refused when the signature does not match; that is independent of OS code signing.
- **macOS was not built or run.** No Mac was available. The window, tray icon, Keychain access, the
  `PATH` taken from the login shell, start at login and Gatekeeper behaviour are unverified until someone
  runs the `.dmg`. The release workflow has not run yet either, so the macOS and MSVC Windows builds in CI
  are untested.
- **Windows was verified with a locally built installer** (Rust GNU toolchain, because the Visual Studio
  build tools could not be installed here): install, start, connect to a control plane, takeover of a
  command-line worker, close to tray, `--quit`, a killed app leaving no worker, update 0.2.0 → 0.2.1 from a
  local server, a mismatching signature refused, uninstall. The tray menu itself and notifications were not
  operated by a test, and starting at sign-in was checked only as the registry entry it writes.
- **Linux was run in a container with a virtual display** (`.deb` and `.AppImage`, Ubuntu 22.04), not on a
  real desktop session: the tray icon and notifications were not seen. The tray needs an AppIndicator host.
  A `.deb` does not update itself. Stopping a command-line worker's systemd unit was not exercised.
- **x64 only for Windows and Linux.** No arm64 installers are built (the scripts know those targets).
- **One worker per user.** The app and a command-line worker use the same data folder and port, so they
  cannot run side by side; the app offers to replace the other one.
- **Uninstalling keeps data**: the worker's data folder and the app's folder with worker versions and log.
- **Every push to `main` builds installers for all systems** (through the automatic tag). If that is too
  much build time, start `release-desktop.yml` by hand instead of from `auto-tag.yml`.

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

## Insights and the weekly digest (added 2026-10-06)
- **Counted from the update on.** Why a task stopped and the time a worker was online are recorded from
  the release that added them. Tasks that stopped earlier are not in the Reliability view, and earlier
  days show no time online. Nothing is backfilled.
- **Workers that are not updated** stop tasks without naming a reason: those count as "checks still
  failing" when verification had failed, and as "other" otherwise.
- **Success rate leaves out tasks waiting for recovery** (they are neither completed nor failed). The
  Reliability view counts them as stopped.
- **Cost is zero for agents that report none**, in every view and in the budget forecast. The forecast
  is the month's spend so far continued at the same rate; in the first days of a month it rests on little.
- **Worker utilization** is agent session time against time online. Sessions are counted on the day they
  end, and a session ended by a provider limit is not counted, so a worker can look less busy than it was.
- **Worker-lost stops per worker** count tasks that went to manual recovery. A task that was requeued
  after its worker was lost is not attributed to that worker.
- **Time percentiles** are computed from the most recent 50,000 completed tasks of the period.
- **Analytics are aggregated on request** from tasks and usage records, with no precomputed rollups. This
  was run with a few hundred tasks, not with millions.
- **The weekly digest** was sent through the test mailer and a local fake of a chat webhook, not through a
  hosted mail provider, Slack or Teams. Times are UTC only. A digest missed by more than 24 hours is skipped.
- **The mobile Insights tab** is type-checked only, like the rest of the mobile app.

## Projects, repositories and GitHub (added 2026-09-28)
- **GitHub App against real GitHub.** The manifest flow, installations, sync, webhooks, member authorization,
  repository creation and scoped tokens are tested against a local fake of GitHub's web and REST API, not
  against github.com. Cloning and pushing with an app token (the `http.extraheader` Git environment) were
  not run against GitHub; cloning was tested from a local bare repository.
- **Multi-repository tasks need an agent with an extra-directory flag**: Claude Code, Cursor Agent, Copilot
  CLI, Qwen Code, Kimi Code, Qoder CLI, CodeBuddy Code (`--add-dir`) or Auggie (`--add-workspace`). The flags
  are listed in each tool's `--help`; the full multi-repository flow was tested with the mock agent only.
  The other agents don't declare the capability, so workers with only those don't get tasks of projects with
  several repositories.
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
- **The agents added on 2026-10-06** (Cursor Agent, Copilot CLI, Kiro CLI, Qwen Code, Kimi Code, Grok CLI,
  Trae Agent, Amp, Factory Droid, Auggie, Crush, Cline, Kilo Code, Pi, Continue CLI, Qoder CLI, CodeBuddy
  Code, Mistral Vibe) were run for real without credentials (flags accepted, sign-in failure recognised);
  Kiro CLI in a Linux container, because it has no Windows build. Copilot CLI, Qwen Code, Kilo Code, Pi,
  Crush and Trae Agent also completed a task against a fake model, through the gateway and through the
  providers they use directly. **None has run with its vendor's account**, so for the agents that only talk
  to their vendor's service a successful run has not been observed: their success-path events follow the
  vendors' documentation. None claims resume.
- **Direct providers that were not run:** Azure OpenAI, Bedrock and Vertex (they need an account), and
  Aider with a real Ollama. See [Agents](agents/README.md#which-models-each-agent-can-use).
- **Amp and Kiro CLI without a login** start a browser login and wait. The worker reports sign-in as
  required when that line appears, but the process itself ends only when the hang timeout stops it. Sign in
  on the worker first (`amp login`, `kiro-cli login`), or put `AMP_API_KEY` or `KIRO_API_KEY` in the task's
  environment profile.
- **Agents without a model flag** (Amp, Continue CLI, Mistral Vibe) run on the model their own
  configuration names; a task's model choice is not applied to them.
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
