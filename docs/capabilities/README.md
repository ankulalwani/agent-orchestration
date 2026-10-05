# Capabilities: skills, MCP servers, plugins, integrations

Four distinct types share one manifest format (`packages/core/src/capabilities.ts`):

| Type | What it is | Runtime effect today |
|---|---|---|
| `skill` | Instructions or knowledge for agents | Injected into the execution prompt for compatible agents |
| `mcp` | External tool/data server (stdio, http, sse) | Passed to agents that support MCP (Claude Code via `--mcp-config`) |
| `plugin` | Extension of the orchestration platform itself | Code run by workers at task hooks, in a restricted process (see [Plugins](#plugins)). Off unless the `plugins.execution` feature flag is on. |
| `integration` | Connection to an external service | Registry only |

## Registry and marketplace

Every control-plane installation owns its registry. Self-hosted organizations register their own private capabilities, and nothing is fetched from, or sent to, vendor infrastructure unless a platform administrator imports from a public registry. On the hosted service the operator curates the marketplace. The architecture is identical in both.

**Packages and namespaces.** A package is identified by `@namespace/name` and holds immutable versions. Each organization and each person gets a namespace on first use (from the organization slug or the email name); `@platform` belongs to platform administrators. A bare name (`react-review`) still works when installing: the organization's own package is tried first, then the platform's, then the person's.

**Owners and visibility.**

| Owner | Starts as | Who can install it |
|---|---|---|
| Organization (`capability.manage`) | `ORGANIZATION` | Members of the organization, at any scope |
| Person (`capability.personal`, developers and up) | `PRIVATE` | Only its owner, at USER or TASK scope, in any of their organizations |
| Platform | `PUBLIC` | Everyone |

**Publishing.** The owner asks for a package to be published (`listed`: shown in the marketplace, or unlisted: installable by reference). Automated checks run first and refuse secrets in manifests, instructions that tell agents to ignore their rules, send credentials away or hide actions, `curl … | sh`, and plugins without code; they warn about high-risk permissions, permissions added since the previous version, and thin descriptions. A platform administrator then approves (granting `COMMUNITY`, `VERIFIED` or `OFFICIAL` trust) or rejects with notes. New versions of a published package must pass the automated checks; its trust carries over.

**Curation.** Platform administrators mark public packages *curated*, with an optional rank. Every listing (dashboard, public catalog) shows curated packages first. The dashboard's marketplace shows curated packages only, and when none match the search it shows all packages with a note to check trust and permissions.

**Versions.** Installations pin an exact version and its digest and keep a range (default `^<version>`). *Upgrade* moves to the newest version in the range; if the new version adds permissions, a non-administrator's upgrade goes back to pending approval. Publishers can deprecate or yank versions; yanked versions cannot be installed and are not delivered to agents.

**Federation.** Platform administrators can mirror the [official MCP Registry](https://registry.modelcontextprotocol.io) (or a compatible one): `POST /api/v1/admin/registry/import/mcp-registry`, or *Server → Marketplace* in the dashboard. Only metadata is stored; servers run from their npm, PyPI or OCI package or remote URL. Mirrored packages are `UNVERIFIED` and never replace a package or namespace claimed on this server. Settings a server declares (environment variables) become installation configuration, passed to the server as environment variables; secret ones are not delivered to workers.

**Categories and technologies.** Every package is categorized automatically, so the marketplace can be filtered without relying on publishers to tag things well. The classifier (`@ao/core` `taxonomy.ts`) reads the name, description, readme, skill instructions, trigger keywords and dependencies, MCP command and environment variable names, and configuration. It assigns up to three of 21 fixed categories (Frontend & UI, Testing & QA, Databases, DevOps & CI/CD, …, or Other) and the technologies it recognizes from a vocabulary of about 100 (React, PostgreSQL, Playwright, Slack, AWS, …). Mentions in the name count most, then the description, then long text. Publishers may choose up to three categories when registering; the classifier treats them as a strong hint, not the final word. Platform administrators can pin a package's categories (`POST /admin/registry/packages/:namespace/:name/categories`, or the Category column in *Server → Marketplace*). Classification is recomputed when a version is registered, the listing changes, or a package is mirrored. When the rules change (`CLASSIFIER_VERSION`), the API reclassifies outdated packages in the background at startup; administrators can also run it (`POST /admin/registry/reclassify`). Search takes `category` and `technology` filters, and `GET …/registry/facets` (or `/catalog/facets`) returns both lists with package counts.

**Suggestions.** `POST /api/v1/orgs/:orgId/registry/suggest` takes any mix of `text` (a prompt or description), `projectId` and `taskId`. It returns packages that fit the work, each with its reasons ("Works with Playwright", "Matches “checkout”", "Testing & QA") and whether it is already installed for that task, project, person or organization. A project adds its name, description, knowledge and the stack its last readiness check found (languages and dependencies). A task adds its title, prompt and background. The text is read into the same technologies and categories as packages. Shared technologies weigh most, then the package's own keywords, then categories. A shared category alone is never enough. Curation, trust and installs only order equally relevant packages. Curated packages come first, as everywhere else. Candidates come from a few bounded, index-backed queries (by technology, keyword, category and text), so the cost does not grow with the catalog. The dashboard shows suggestions in *Capabilities → Suggested* and as you write a new task, where installed ones can be requested for the task and others installed just for you in one click. Package pages list related packages (`…/packages/:namespace/:name/related`). Per-task skill selection uses the same vocabulary: a skill about a technology the task mentions ranks higher when not all skills fit.

**Search.** MongoDB text search by default. Set `REGISTRY_SEARCH=atlas` on MongoDB Atlas with an Atlas Search index named `capability_packages` on the `capabilitypackages` collection (fields `displayName`, `name`, `tags`, `description`, `namespace`) for fuzzy, relevance-ranked search.

**Public catalog.** `GET /api/v1/catalog/packages`, `/catalog/packages/:namespace/:name`, `…/related`, `/catalog/facets`, `/catalog/suggest?q=` and `/catalog/sitemap` answer without sign-in when `PUBLIC_CATALOG=true` (default on only with `DEPLOYMENT_MODE=cloud`). They return public packages only and are cacheable; the marketing site builds a page per package from them. Each package has `indexable`: curated packages, packages with installs, and packages with a real description or readme. Thin mirrored entries are served with `noindex` and left out of the sitemap.

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

- **Scopes:** organization, user (*Just me*: that person's tasks), project and task installations are merged in that order, and a more specific scope overrides (or disables) a broader one. Project beats user so a repository behaves the same for the whole team.
- **Per-task selection:** when a task's skills exceed 12 or about 24,000 tokens of instructions, the most relevant ones are delivered (manifest `triggers` and name matched against the task's title and prompt; ties go to the more specific scope). Skills installed for the task or named in the task's `capabilityIds` always go. MCP servers, plugins and integrations are always delivered.
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

## Stacks

A stack is a set of packages that belong together, such as a framework's skills and MCP servers,
installed in one step from **Capabilities → Stacks**.

- **Platform stacks** are made by server administrators (**Server → Marketplace → Stacks**) from public
  packages only, and are offered to every organization. With the public catalog on, they are also at
  `/api/v1/catalog/stacks` for a marketing site.
- **An organization's own stacks** are made by its administrators (permission `capability.manage`) and
  may hold anything the organization can see, including its private packages. One with the same address
  as a platform stack is shown to its members instead.
- **Install all** installs every package at one scope (organization, a project, or just you). Each
  package goes through the usual installation, so trust, permission and approval rules apply to each:
  the result lists what was installed, what waits for approval and what policy refused, with the reason.

Paid listings are not part of the marketplace.

## Semantic suggestions

Suggestions use built-in rules by default: technologies, keywords and categories found in the text. No
text leaves the server.

With an embeddings API configured, packages close in *meaning* to the description are suggested too,
even when they share no words with it:

```bash
EMBEDDINGS_URL=https://api.openai.com/v1      # any OpenAI-compatible API, for example Ollama: http://localhost:11434/v1
EMBEDDINGS_API_KEY=…                          # when the API needs one
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDINGS_MIN_SIMILARITY=0.4                 # depends on the model
```

- Package listings (name, description, tags, the start of the readme) are embedded in the background at
  startup and when a listing changes; **Server → Marketplace** can start a full run
  (`POST /admin/registry/embed`). A new model embeds everything again.
- The text someone asks suggestions for (a prompt, a task, a project description) is sent to that API.
  Turn this on only when that is acceptable for your data.
- Closeness in meaning adds to the rules' score; curated packages still come first. When the API fails,
  suggestions fall back to the rules.
- Without Atlas, the 5,000 most used public packages are compared in memory. With
  `REGISTRY_SEARCH=atlas`, create a vector index named `capability_embeddings` on `embedding.vector`.
