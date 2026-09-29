# Projects, repositories and GitHub

A project is one or more Git repositories. Projects come from three places:

- **GitHub:** the organization's GitHub App syncs every repository it can see into projects.
- **Workers:** workers find Git repositories on their disks. A clone of a repository that is already in a
  project is mapped automatically; any other repository is suggested in the dashboard.
- **By hand:** **Projects → New project**, with a repository URL or a new GitHub repository.

## Projects with several repositories

A project can hold several repositories, for example an API and a web app. One of them is the **primary**
repository: it holds the task state (`.agent-orchestrator/`), and the project's `repositoryUrl` and
`defaultBranch` are its values (kept for older clients).

- Manage them on the project page (**Repositories**): add one by URL, move one in from another project,
  rename, make primary, or move one out into a project of its own. A project left without repositories is
  archived; its tasks and history stay.
- A repository belongs to at most one project. It is identified by a **key** that is the same wherever it is
  cloned: `<host>/<owner>/<name>` from any https, ssh or `git@host:owner/repo` URL, or
  `local:<root commit>` for repositories without a remote.
- **Tasks see all of them.** The agent's working directory is the primary repository; the others are given
  to it as extra directories and listed in its prompt with their paths. Each repository gets the same task
  branch. Verification runs in the primary repository (the policy's steps) and in each other repository the
  task changed (automatically detected checks). The Git policy (commit, push, pull request) is applied in
  each changed repository; the task's Git result lists them all.
- **Which workers can run them:** only workers with a checkout of **every** repository of the project, and
  an agent that can work in several directories (Claude Code). The dashboard's project page shows what each
  worker is missing.
- Review and plan tasks look at the primary repository only.

## The GitHub App

**Settings → GitHub → Create GitHub App** (administrators) creates the organization's own GitHub App with
GitHub's app-manifest flow: you confirm on GitHub, and GitHub hands the app's credentials back to this
server. They are stored encrypted with `ENCRYPTION_KEY` (and re-encrypted by `reencrypt-secrets`).

- **Owner:** enter a GitHub organization to create the app there; leave it empty for your personal account.
- **Installable on any account** (default): the app can also be installed on other accounts, such as
  personal accounts and other organizations. Installations are only accepted when started from
  **Install on an account** on this page (a single-use link), so someone else installing the app never brings
  their repositories into your organization.
- **Permissions:** repository contents, pull requests and issues (write), metadata (read), and
  administration (write, to create repositories in organizations).
- `GITHUB_URL` and `GITHUB_API_URL` point it at GitHub Enterprise Server.

### Sync

Every repository an installation can see becomes a project named after it (`name (owner)` if the name is
taken), unless it is already in a project: then that repository is updated (URL, default branch, access).
Archived GitHub repositories are not imported. A repository the app can no longer see is marked
*no access* in its project, never removed.

- **Webhooks:** when `PUBLIC_URL` is reachable from GitHub, the app receives `repository`, `installation`
  and `installation_repositories` events at `<PUBLIC_URL>/api/v1/github/webhook` and syncs right away.
- **Polling:** every installation is also synced every 10 minutes. On a private `PUBLIC_URL` (such as
  `http://localhost:4000`) the app is created without a webhook and relies on this. **Sync now** syncs at
  once.

### New repositories

**New project → New GitHub repository** creates the repository (with a first commit, so it can be cloned)
and a project for it. A repository can also be added to an existing project.

- **In an organization:** through the app's installation there.
- **In your personal account:** the app must be installed on it, and you connect your GitHub account once
  (**Settings → GitHub → Connect your GitHub account**), because GitHub only lets you create repositories in
  a personal account as yourself. If the installation has only selected repositories, the new one is added
  to it.
- **Clone it to:** workers with a projects folder clone it right away (see below).

### Pushes and pull requests

For repositories from the GitHub App, a worker that has no token of its own for github.com asks the control
plane for a short-lived installation token, limited to the task's repositories, to push the task branch
and open the pull request. A token configured on the worker (**Settings → Git hosting**) is still used first.

## Workers: finding and cloning repositories

In the worker's local UI → **Projects**:

- **Repositories on this computer:** the worker scans every fixed drive (or the folders you list) every
  6 hours, and on **Scan now**. It skips system, program, package-manager and build folders (for example
  `Windows`, `Program Files`, `AppData`, `node_modules`, `.venv`, `dist`), links and junctions, and folders
  inside a repository. Only folder paths, names, branches, remote URLs and root commits are sent, never file
  contents. `AO_DISCOVERY_AUTOSTART=0` turns off the automatic scans.
- **Projects folder:** where repositories are cloned from the dashboard (the project page's **Clone to a
  worker**, or a new GitHub repository). Each goes into its own folder named after the repository
  (`name-2`, … when a different folder already has that name). Clones use a token limited to that
  repository, passed to Git as a header and not stored in the clone.

The control plane can only map folders the worker found or cloned itself, never an arbitrary path.

## API

| Method and path | Purpose |
|---|---|
| `POST /orgs/:orgId/projects/:id/repositories` | Add a repository (`{url}`) or move one in (`{fromProjectId, repositoryId}`) |
| `PATCH /orgs/:orgId/projects/:id/repositories/:repositoryId` | Rename, change branch, make primary |
| `POST …/repositories/:repositoryId/split` | Move it into a project of its own |
| `POST …/repositories/:repositoryId/clone` | Clone it to workers (`{workerIds}`) |
| `GET /orgs/:orgId/github` | App, installations, your GitHub connection |
| `POST /orgs/:orgId/github/app/manifest`, `/installations`, `/user`, `/sync` | Create the app, install it, connect your account, sync |
| `POST /orgs/:orgId/github/repositories` | Create a GitHub repository (and project) |
| `GET /orgs/:orgId/discovered`, `POST …/discovered/accept`, `…/dismiss` | Repositories found on workers |
