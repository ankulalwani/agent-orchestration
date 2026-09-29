# Troubleshooting

Start with `agentctl doctor` on the worker machine. Every failing check includes a suggested fix.

| Symptom | Likely cause | Fix |
|---|---|---|
| Task stays `QUEUED` with "Waiting for an eligible worker — …" | No connected worker meets the requirements. The reason lists what each worker is missing (project path, OS, tools, a compatible agent/provider/model, capacity). | Map the project on a worker, add a provider, or install the agent |
| Task stays `QUEUED`: "Waiting for another task in this project" | Default concurrency is 1 active task per project | Wait, or raise `concurrency.perProject` in the project policy |
| Task stays `QUEUED`: "Organization concurrency limit reached", "Agent/provider below concurrency limit" or "Waiting for a free agent/provider slot" | `concurrency.perOrganization`, `perAgent` or `perProvider` is reached across the organization | Wait (a freed slot re-dispatches waiting tasks), or raise the limit in the organization or project policy |
| `WAITING_FOR_LIMIT` for a long time | The provider limit has no known reset time, so the worker polls with growing intervals (up to `fallback.limitPollMaxMs`) | Add a fallback step (`FALLBACK_AGENT` / `FALLBACK_PROVIDER`) or press **Resume** after the limit resets |
| `RECOVERY_REQUIRED` "failed the same way 3 times" | Deterministic failure (for example an agent that exits immediately) | Read **Recovery** and **Logs** on the task, fix the cause, then **Retry** (continues from the checkpoint) or **Restart fresh** |
| `RECOVERY_REQUIRED` "needs authentication" | Agent not logged in, or the provider key is invalid | Sign the agent in on the worker, or update the key in the worker UI |
| Verification keeps failing | The project's checks fail, or a check needs a service or environment the worker doesn't have | See the Verification tab; set explicit `verification.steps` in the project policy |
| Browser verification fails: "Playwright is not installed" | Browser checks run Playwright from the project's own dependencies | `npm i -D playwright && npx playwright install chromium` in the project |
| Worker shows `unauthorized` | Worker credential revoked | `agentctl worker disconnect`, then pair again |
| Worker local UI says "Open the worker UI from the worker" | The page needs the tokenized link | `node dist/main.js --print-ui-url` (or re-run the installer) |
| `/readyz` shows `queue: false` | Redis unreachable | Check `REDIS_URL`. Tasks are not lost: the scheduler rebuilds dispatch from MongoDB |
| Git step "Push failed" / "No origin remote" | Push credentials or remote missing on the worker | Configure Git credentials for the worker user. The commit is kept locally. |
| Pull request not created | GitHub CLI missing or not authenticated | Install `gh` and run `gh auth login` as the worker user |
