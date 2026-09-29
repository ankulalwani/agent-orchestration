# Verification

A task is never complete because the agent says so. After the agent finishes, the worker runs the
verification steps in the project. Every *required* step must pass. If one fails, its output goes back
to the agent to fix (up to the policy's `maxRemediationAttempts`), and then the task needs a person
(`RECOVERY_REQUIRED`).

## Steps

Steps come from the `verification` policy (organization, project, worker or task level). Without
configured steps, they are detected from project files (`autoDetect`, on by default):

| Project | Detected steps |
|---|---|
| `package.json` | `typecheck`, `lint`, `build`, `test` scripts, run with the package manager in use |
| Composer | `composer test`, or `vendor/bin/phpunit` |
| Python | `pytest` when there are tests |
| Go, Rust | build and test |

Each step is `{ kind, name, command, required, timeoutMs }`. Commands are argument lists, never shell
strings. Kinds: `git_status`, `install`, `typecheck`, `lint`, `build`, `test`, `custom`, and the two
below. [Plugins](../capabilities/README.md#plugins) can add checks of their own.

## `smoke` and `browser`

- `smoke`: `GET url` must answer below 400.
- `browser`: Chromium (Playwright, installed in the project) opens `url`. Console errors, uncaught page
  errors, failed requests and HTTP errors fail the step. A screenshot is stored as a task artifact.

Both can start the app themselves and stop it afterwards:

```json
{
  "kind": "browser",
  "name": "QA",
  "url": "http://127.0.0.1:3000/",
  "start": { "command": ["npm", "run", "dev"], "readyTimeoutMs": 120000, "env": { "PORT": "3000" } },
  "discover": { "maxPages": 25, "maxDepth": 3, "paths": ["/checkout"], "exclude": ["/logout", "/admin"] }
}
```

The step waits until `url` answers. If the app exits first, or does not answer in time, the step fails
with the app's output.

### QA route discovery

With `discover`, the step checks the whole app, not one page. It visits:

1. `url`, then same-origin links found on each page, up to `maxDepth` links deep;
2. `paths` you list;
3. routes from file-based routers in the project: Next.js (`app/**/page.*`, `pages/`), Nuxt (`pages/`),
   SvelteKit (`src/routes/**/+page.svelte`), Remix / React Router flat routes (`app/routes/`), Astro
   (`src/pages/`). Dynamic routes (`[id]`, `$id`) are only visited when a link leads to them.

Paths starting with an `exclude` prefix are never opened (by default `/logout`, `/signout`, `/sign-out`),
and at most `maxPages` pages are opened within the step's `timeoutMs`. The report lists every page with
its status and where it was found, with the problems under each broken page. Screenshots are stored for
the start page and for up to 9 broken pages.

Discovery only follows links and file routes. It does not fill in forms or sign in; a page behind a
login is checked as whatever it shows to a visitor who is not signed in.
