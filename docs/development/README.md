# Development

## Layout
See [ARCHITECTURE.md](../ARCHITECTURE.md) §3. Workspace packages export TypeScript source directly (no per-package build). Vitest and tsx run it as-is, and tsup bundles it for production (decision D-012).

## Commands (all verified)

```bash
npm install -g pnpm && pnpm install         # pnpm switches to the version pinned in package.json
pnpm test                                   # all unit, integration, e2e, chaos and browser tests
npx vitest run packages/core                # one area
pnpm --filter @ao/web build                 # required before the browser tests (they skip otherwise)
pnpm --filter @ao/worker-ui build
npx playwright install chromium             # once, for browser tests
node scripts/package-worker.mjs             # packaged worker in .deploy/worker
npx tsx scripts/map-worker-project.ts <projectId> <absPath>   # map a project on the local worker
```

Type-check a package: `cd packages/<name> && npx tsc --noEmit`.

## Tests

| Suite | Path | Uses |
|---|---|---|
| Unit | `packages/*/src/*.test.ts`, `apps/*/src/*.test.ts` | — |
| Integration | `tests/integration` | Real MongoDB via `mongodb-memory-server` (uses an installed `mongod` if present) |
| End-to-end | `tests/e2e/worker-flow.test.ts` | Real API, worker, mock agent and Git repository |
| Browser | `tests/e2e/web.test.ts`, `worker-ui.test.ts` | Playwright Chromium |
| Chaos | `tests/chaos` | Control-plane outage, MongoDB outage, worker death and takeover |
| Deployment | `tests/deploy` | helm lint, kubeconform, hadolint, shellcheck (from `.tools/`; skipped when missing) |
| Redis | `tests/integration/bullmq.test.ts`, `tests/chaos/redis.test.ts` | Redis (`.tools/redis/*/redis-server.exe` or `AO_TEST_REDIS`; skipped when missing) |
| Claude Code, live | `tests/e2e/claude-code-live.test.ts` | A real coding task through control plane, worker and the installed `claude` with its login (opt-in: `AO_TEST_CLAUDE_LIVE=1`; uses your Claude usage, about US$0.06 with the default Haiku model; `AO_TEST_CLAUDE_MODEL` to change) |
| Agent CLIs | `tests/e2e/agent-clis.test.ts`, `gateway-agents.test.ts` | The agent CLIs from `.tools/` (opt-in: `AO_TEST_AGENT_CLIS=1`; makes rejected requests to the providers): npm packages in `.tools/agents`, Aider in `.tools/aider-venv`, Trae Agent and Mistral Vibe in `.tools/py-agents-venv`, Cursor Agent's package in `.tools/cursor-agent/dist-package`. CLIs that are missing are skipped |
| Backup drill | `tests/integration/backup-restore.test.ts` | MongoDB Database Tools (`.tools/mongotools/*/bin` or `AO_TEST_MONGO_TOOLS`; skipped when missing) |
| S3 | `tests/integration/s3.test.ts` | SeaweedFS (`.tools/seaweed/weed.exe` or `AO_TEST_SEAWEED`; skipped when missing) |

The mock agent (`packages/agents/src/mock/mock-agent.mjs`) runs deterministic scenarios (`success`, `rate_limit`, `limit_once`, `context_once`, `flaky`, `crash`, `hang`, `input`, `fail`, `slow`), so recovery can be tested without paid AI usage.

Test files run in up to 6 parallel processes (`VITEST_MAX_FORKS` to change it): many of them start real
processes, and running one per core made them starve each other and time out at random.

Each test file that needs MongoDB starts its own `mongod` (about 10 MB of disk each, in the system temp
directory), and files run in parallel. `mongod` refuses writes when its disk has less than 500 MB free, so
if tests fail with "available disk space … is less than required minimum", free space on the temp drive.
Test temp folders start with `ao-` or `mongo-mem-` and can be deleted when no test run is active.

## Conventions
- Anything that runs a process uses `safeSpawn`/`runCommand` from `@ao/core`, never `exec` or `shell: true`.
- Task status changes go through the state machine (`TASK_TRANSITIONS`). Server-side updates are atomic on the current status.
- New organization-owned models must include `organizationId`, and every query must be scoped by it.
- Keep `docs/IMPLEMENTATION_STATUS.md` accurate: COMPLETE requires evidence.
