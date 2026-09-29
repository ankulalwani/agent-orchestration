# Self-hosting: from clone to a verified task

The shortest complete path. Production settings (TLS, backups, upgrades, Kubernetes, SSO, SMTP, S3) are
in [self-hosting/README.md](self-hosting/README.md).

## 1. Control plane (Docker Compose)

```bash
git clone https://github.com/ankulalwani/agent-orchestrator.git && cd agent-orchestrator
cp .env.example .env
# Set the two required secrets:
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
docker compose up -d --build        # control plane + web, MongoDB, Redis
curl http://localhost:4000/healthz
```

Open http://localhost:4000 and create the first account: it becomes the installation's administrator.
Migrations run automatically on start. Nothing is sent to any vendor, and there are no limits on tasks,
workers, members or projects.

## 2. Worker (on each machine that runs agents)

Install Node.js 20+, then from a checkout of this repository:

```bash
pnpm install && node scripts/package-worker.mjs         # builds .deploy/worker
installers/linux/install-worker.sh    # or installers/macos/install-worker.sh,
                                      #    installers/windows/install-worker.ps1
```

The installer starts the worker as your user and opens its local UI (http://127.0.0.1:47821). Enter the
control-plane URL, approve the pairing code in the dashboard, and the worker appears under **Workers**.

## 3. Agents, models and capabilities

- **Agents:** install and sign in to any of Claude Code, Codex, Gemini CLI, OpenCode or Aider on the worker
  machine. The worker detects them; tasks use each agent's own login by default.
- **Add-on models (optional):** in the worker UI → AI models, add OpenRouter, OpenAI, Anthropic, Gemini,
  Groq, DeepSeek, NVIDIA NIM, Ollama, LM Studio or any OpenAI-compatible endpoint, used when an agent reaches
  its usage limit. Keys stay on the worker. See [providers/README.md](providers/README.md).
- **Capabilities, skills, MCP servers:** dashboard → Capabilities. Your installation owns its registry.
  See [capabilities/README.md](capabilities/README.md).

## 4. First task

1. Dashboard → Projects → create a project (or connect GitHub, [github/README.md](github/README.md)).
2. Map it to a local checkout on the worker (worker UI → Projects, or automatic discovery).
3. Tasks → New task: describe the change and the verification commands (tests, typecheck, build).
4. The task runs, is verified, and is committed on a task branch. The report separates verified results from
   the agent's own claims.

## 5. Mobile app and IDE

The mobile app asks for your server URL at sign-in. The VS Code extension signs in with an API token
(dashboard → Settings → API tokens).
