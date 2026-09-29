# Development

From a fresh clone to a running system and a green test suite, without any credentials. Details on
suites, test tools and conventions: [development/README.md](development/README.md).

## 1. Prerequisites

- Node.js 20+ (22 recommended) and Git
- pnpm: `npm install -g pnpm` (pnpm switches to the version pinned in `package.json`)
- MongoDB: not needed for tests (they start their own `mongod` through `mongodb-memory-server`); for the dev
  server, a local `mongod` or a container (below)
- Optional: Redis (a local `redis-server` or a container, below), Docker for the self-hosted image

## 2. Install and test

```bash
git clone https://github.com/ankulalwani/agent-orchestration.git && cd agent-orchestration
pnpm install
pnpm typecheck
pnpm test                          # unit, integration, e2e, chaos, browser (browser tests need step 3)
node scripts/check-boundary.mjs    # the CI boundary check
```

Suites that need extra tools (Redis, Helm, kubeconform, hadolint, MongoDB Database Tools, SeaweedFS) are
**skipped** when the tool is missing. Point `AO_TEST_REDIS`, `AO_TEST_HELM`, `AO_TEST_KUBECONFORM`,
`AO_TEST_HADOLINT`, `AO_TEST_MONGO_TOOLS`, `AO_TEST_SEAWEED` at them, or put them in `.tools/` (ignored by
Git), to run those too.

## 3. Run it

```bash
docker run -d --name ao-mongo -p 27017:27017 mongo:7      # or your own mongod
docker run -d --name ao-redis -p 6379:6379 redis:7-alpine  # optional; or your own redis-server
export MONGODB_URI=mongodb://127.0.0.1:27017/agent_orchestration REDIS_URL=redis://127.0.0.1:6379
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
pnpm dev:api        # http://127.0.0.1:4000 (migrations run on start)
pnpm dev:web        # http://localhost:5173
pnpm dev:worker     # prints the worker's local UI link
```

In the dashboard: create an account (the first one administers the installation) → **Getting started** →
pair the worker → map a project to a local checkout → create a task. With no agent installed, the mock
agent can run tasks end to end; with Claude Code, Codex, Gemini CLI, OpenCode or Aider installed and signed
in, the worker detects them.

## 4. Before opening a pull request

- `pnpm typecheck && pnpm test && node scripts/check-boundary.mjs`
- New behaviour has tests; `docs/IMPLEMENTATION_STATUS.md` stays accurate.
- Extension points (see [PUBLIC_PRIVATE_BOUNDARY.md](PUBLIC_PRIVATE_BOUNDARY.md)) keep their contract, or
  the change is marked breaking ([CORE_VERSIONING.md](CORE_VERSIONING.md)).
