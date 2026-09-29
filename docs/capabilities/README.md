# Capabilities: skills, MCP servers, plugins, integrations

Four distinct types share one manifest format (`packages/core/src/capabilities.ts`):

| Type | What it is | Runtime effect today |
|---|---|---|
| `skill` | Instructions or knowledge for agents | Injected into the execution prompt for compatible agents |
| `mcp` | External tool/data server (stdio, http, sse) | Passed to agents that support MCP (Claude Code via `--mcp-config`) |
| `plugin` | Extension of the orchestration platform itself | Code run by workers at task hooks, in a restricted process (see [Plugins](#plugins)). Off unless the `plugins.execution` feature flag is on. |
| `integration` | Connection to an external service | Registry only |

## No mandatory marketplace

Every control-plane installation owns its registry. Self-hosted organizations register their own private capabilities, and nothing is fetched from, or sent to, vendor infrastructure. On the hosted service the operator curates platform-level capabilities. The architecture is identical in both.

## Manifest

```json
{
  "id": "shopify-development",
  "name": "Shopify Development",
  "version": "1.2.0",
  "type": "skill",
  "compatibleAgents": ["claude-code", "codex"],
  "requires": ["node"],
  "permissions": ["filesystem.project.read", "filesystem.project.write", "network.outbound"],
  "platforms": ["windows", "macos", "linux"],
  "skill": { "instructions": "…" }
}
```

Other fields: `publisher`, `trust`, `dependencies`, `recommendedMcp`, `triggers` (files, dependencies, keywords), `configuration` (with `secret: true` entries that must be given as `secret:NAME` references), `install`, `uninstall`, `healthCheck`. Versions are immutable: publish a new version to update.

## Scopes and policy

- **Scopes:** organization, project and task installations are merged, and a more specific scope overrides (or disables) a broader one.
- **Install policy:** `ASK` (approval required), `AUTO` (trusted and low-risk installs go straight through), or `RESTRICTED` (only pre-approved trust levels; anything else is blocked).
- **Trust:** `OFFICIAL`, `VERIFIED`, `COMMUNITY`, `UNVERIFIED`, `LOCAL`. Only platform administrators can assign `OFFICIAL`/`VERIFIED`.
- **Permissions:** policies can block permissions or require approval for them. `shell`, `secrets.read`, `process.execute`, `browser.control` and `git.write` require approval by default. Plugins always require approval.

## Plugins

A plugin is one self-contained ES module (bundle its dependencies) in the manifest's `plugin.source`,
exporting a function per hook it lists in `plugin.hooks`:

| Hook | Export | When | May return |
|---|---|---|---|
| `task.prepare` | `prepare(ctx)` | Before the agent starts | `{ instructions }`, added to the agent's prompt |
| `task.verify` | `verify(ctx)` | With the other verification checks | `{ checks: [{ name, passed, summary }] }`. A failed check is a required step: the agent is sent back to fix it. |
| `task.completed` | `completed(ctx)` | After the task completed | Nothing (notifications, bookkeeping) |

`ctx` holds `task` (id, title, prompt, project, environment), `projectDir`, `config` (the installation's
configuration), hook data (`verification` and `changedFiles` for verify, `report` for completed) and
`log(...)`, whose lines appear in the task timeline.

```json
{
  "id": "house-style", "name": "House style", "version": "1.0.0", "type": "plugin",
  "permissions": ["filesystem.project.read"],
  "plugin": {
    "hooks": ["task.verify"],
    "source": "export function verify(ctx) { return { checks: [{ name: 'no TODO', passed: true, summary: '' }] }; }",
    "timeoutMs": 30000, "memoryMb": 256
  }
}
```

**Where it runs.** Only when all of these hold: a platform administrator turned on the
`plugins.execution` feature flag for the organization (off by default), an administrator approved the
installation (plugins always need approval), and the worker's owner has not unticked *Run approved
plugin code on this machine* in the worker UI. Otherwise the timeline records why the plugin was skipped.
Workers need Node.js 22.13 or later.

**Isolation.** Each hook runs in a new Node.js process under the permission model:

| Permission | Grants |
|---|---|
| (none) | Read its own code; read and write its own data folder on the worker |
| `filesystem.project.read` / `.write` | Read / read and write the project folder |
| `filesystem.read` / `filesystem.write` | Read / write anywhere the worker's user can |
| `network.outbound` | Network access. Without it, sockets, HTTP, `fetch`, WebSocket, DNS, UDP and listening are blocked. |
| `process.execute`, `shell` | Child processes and threads. **These run without restrictions**, so this is effectively full access. |
| `secrets.read` | `secret:NAME` configuration values are resolved to the secret's value (each delivery is audited). Without it, plugins see only the references. |

Plugins never get the worker's environment variables or credentials; native addons, WASI and
`process.binding` are unavailable. Each hook has a time limit (`timeoutMs`, default 30 s) and a memory
limit (`memoryMb`, default 256 MB). A plugin that crashes, times out or returns an invalid result is
recorded (`PluginHookFailed`) and never fails the task by itself. The control plane stores the SHA-256
of the code when the manifest is registered, and workers refuse code that doesn't match it.

## Worker-local MCP servers

MCP servers installed on a worker are listed in the worker UI and advertised as `mcp:<id>` tool tags, so tasks that require them are only scheduled on workers that have them.

## MCP health checks

The worker checks MCP servers with the real protocol handshake (`initialize`, then `tools/list`) over
stdio, Streamable HTTP or legacy SSE, with a 10-second limit:
- **Worker-local servers** are checked when saved, at start-up and every 10 minutes. Only healthy ones
  are advertised as `mcp:<id>`, so tasks are never routed to a worker whose server doesn't work. The
  worker UI shows each server's state (tool count, or the error) and has a **Check now** button.
- **MCP capabilities installed from the registry** are checked before an agent receives them (results
  are cached for 5 minutes). A failing server is left out, the task continues without it, and the
  task timeline records which server was skipped and why.
