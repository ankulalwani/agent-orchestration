# Workers

A worker is a native Node.js process on a machine with your code and AI agents. It:
- connects **outbound** to the control plane over HTTPS/WSS, so no inbound ports are needed;
- serves a local UI and API on `127.0.0.1:47821`, which is never exposed publicly by default;
- runs agents only inside project directories you map on that machine;
- keeps credentials in the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service), falling back to an encrypted file if none is available.

## Install

**Desktop app.** For a developer's own computer this is the shortest way: download the installer, start the app, connect it. Nothing else has to be installed; the app brings its own Node.js. The dashboard offers the same downloads on **Workers**, **Getting started** and the pairing page, with the server's address to paste into the app. A fork sets `UPDATE_CHECK_REPO` to link its own releases.

| OS | Download (always the newest release) | Verified |
|---|---|---|
| Windows 10/11, x64 | [`agent-orchestration-worker-windows-x64-setup.exe`](https://github.com/ankulalwani/agent-orchestration/releases/latest/download/agent-orchestration-worker-windows-x64-setup.exe) | Installed, connected to a control plane, taken over from a command-line worker, updated to a newer version and uninstalled on Windows 11, with an installer built locally (GNU toolchain; the release installer is built with MSVC) |
| macOS 11+, Apple silicon | [`agent-orchestration-worker-macos-arm64.dmg`](https://github.com/ankulalwani/agent-orchestration/releases/latest/download/agent-orchestration-worker-macos-arm64.dmg) | Not run on a Mac yet |
| macOS 11+, Intel | [`agent-orchestration-worker-macos-x64.dmg`](https://github.com/ankulalwani/agent-orchestration/releases/latest/download/agent-orchestration-worker-macos-x64.dmg) | Not run on a Mac yet |
| Linux x64 (glibc 2.35+) | [`.AppImage`](https://github.com/ankulalwani/agent-orchestration/releases/latest/download/agent-orchestration-worker-linux-x64.AppImage) or [`.deb`](https://github.com/ankulalwani/agent-orchestration/releases/latest/download/agent-orchestration-worker-linux-x64.deb) | Built, and both run in an Ubuntu 22.04 container with a virtual display (`.deb` installed, `.AppImage` unpacked); not on a real desktop session |

- The window shows the same local UI as the browser does, with a folder chooser next to path fields. Closing the window keeps the worker running; the tray icon shows its state and opens the window, the log and **Quit**. Quitting the app stops the worker.
- **Start at login** is in the tray menu and in **Settings**. The app then starts in the tray.
- The worker runs as you and uses the same data folder as a worker installed with the scripts below, so the pairing, settings and credentials carry over in both directions.
- If a worker installed from the command line already runs on the computer, the app says so and offers **Use the desktop app instead** (removes that worker's autostart entry and stops it, keeps its data) or **Keep it and open its UI**.
- The installers are **not code-signed yet**. Windows SmartScreen shows "Windows protected your PC": choose **More info**, then **Run anyway**. macOS refuses to open the app on the first start: open **System Settings → Privacy & Security** and choose **Open Anyway** (or run `xattr -dr com.apple.quarantine "/Applications/Agent Orchestration Worker.app"`). Compare the download with the checksum on the release page if you want to be sure of the file.
- Linux: the tray icon needs an AppIndicator host (on GNOME, the AppIndicator extension). Without one the app works, and the window is the only way to reach it. The `.AppImage` updates itself; a `.deb` is updated by installing the newer one.
- Updates: the worker inside the app updates as described under [Updating](#updating). The app itself (window, tray, bundled Node.js) changes rarely; **Check for updates…** in the tray menu (or **Updates → Check for app updates…**) installs a newer one, after asking.
- For scripts: start the app again with `--quit` to stop the running app and its worker cleanly.
- Uninstalling the app keeps the worker's data (pairing, settings, credentials) and the app's own folder with the installed worker versions and the log. Delete them by hand if you want nothing left: the worker data folder is the one `agentctl doctor` names, the app's folder is `io.agent-orchestration.worker` in the user's local application data.

For servers and machines without a desktop, use one of the two ways below.

**One click (from the dashboard).** Open **Workers** (or **Getting started**), copy the install command for your OS and run it on the machine that has your code and agents. It downloads the signed worker release from your control plane, verifies it, installs it for your user, starts it at login, and opens the approval page in your browser; click **Approve** and the worker connects. Requires Node.js 20+, and an administrator who has published a release and set `WORKER_RELEASE_TRUSTED_KEYS` ([setup](../self-hosting/README.md#one-click-worker-install)). Re-running the command on an installed worker updates it and keeps its pairing.

**From a repository checkout.** Build the package once from a repository checkout (Node 20+ required):

```bash
node scripts/package-worker.mjs      # creates .deploy/worker
```

Then run the installer for your OS (add `--pair-server <url>`, or `-PairServer <url>` on Windows, to also connect to your control plane and open the approval page). Each one validates dependencies, copies the worker, registers autostart, starts it, opens the local UI and runs diagnostics.

| OS | Command | Autostart | Verified |
|---|---|---|---|
| Windows | `powershell -ExecutionPolicy Bypass -File installers\windows\install-worker.ps1` | Per-user Scheduled Task at logon; started again within a minute if it stops | Installed, restarted and uninstalled for real on Windows 11 |
| macOS | `./installers/macos/install-worker.sh` | LaunchAgent (`KeepAlive`) | Syntax-checked only |
| Linux | `./installers/linux/install-worker.sh [--linger]` | systemd **user** service | Syntax-checked only |

The worker runs as **you**, not as a system account. Agent logins (for example a Claude subscription), Git credentials and your repositories all belong to your user account (decision D-011). The installers capture your `PATH` so that agent CLIs installed through npm, Homebrew or pipx are found.

Uninstall with the matching `uninstall-worker` script. Add `-RemoveData` / `--remove-data` to also delete configuration and stored credentials. Project directories are never touched.

## Connect to a control plane

1. The installer opens the local UI. For a manual start, run `node dist/main.js --print-ui-url`.
2. Enter your control plane URL (**My self-hosted server**). A distribution that ships its own worker package may also offer its hosted service here (`package-worker.mjs --hosted-url`, or `AO_HOSTED_URL`).
3. The worker shows a code such as `ABCD-1234`. Open the approval page in the dashboard, check the machine details, and approve it.
4. The worker receives a long-lived credential, stores it in the OS credential store, and connects.

If the organization requires worker approval (**Settings → Organization**), an admin must also approve the worker before it gets tasks.

## Configure

In the local UI:
- **Projects:** map each dashboard project ID to the absolute path of its checkout (for a project with several repositories, one row per repository with its repository ID). Agents cannot work outside these paths. Usually you don't need to: the worker finds repositories on its drives and maps clones of project repositories itself, and clones new ones into its **projects folder**. See [Projects, repositories and GitHub](../github/README.md#workers-finding-and-cloning-repositories).
- **AI Providers:** add providers and API keys. Keys go to the credential store and are only ever shown masked. Choose "use the agent's own login" for subscription-based agents.
- **Agents:** enable or disable detected agents.
- **MCP Servers:** list locally available MCP servers. They are advertised as `mcp:<id>` so tasks that need them are scheduled here.
- **Settings:** name, labels, concurrency, Git author, and a worker-level policy override.

Error tracking is off by default. To report worker crashes and unexpected task errors (redacted), set
`AO_ERROR_TRACKING_DSN` (Sentry-compatible) or `AO_ERROR_TRACKING_WEBHOOK_URL` in the worker's
environment, or `errorTracking.dsn` / `errorTracking.webhookUrl` in its `config.json`.

## What happens when…

| Situation | Behaviour |
|---|---|
| Control plane unreachable | Running tasks continue. Events are buffered on disk and state changes are retried with the same idempotency id, then synced on reconnect. (Chaos-tested.) |
| Worker machine dies | Its leases stop being renewed. After the lease expires (5 min by default), the task is requeued from its last checkpoint for another worker, or marked `RECOVERY_REQUIRED` by policy. A worker that returns later is fenced off (`LEASE_LOST`). (Chaos-tested.) |
| Worker restarts mid-task | On start it asks the control plane which of its tasks it still owns and continues them from the checkpoint. |
| Provider limit | See [agents](../agents/README.md#recovery). |

## Command line

`agentctl worker status`, `agentctl worker connect --server <url>`, `agentctl worker disconnect`, `agentctl doctor`.

## Updating

The installers set the worker up for self-updates: the autostart entry runs a small **launcher**, and each
version lives in its own folder (`app/<version>/`, with `state.json` saying which one is current).

- **Update source:** by default, the control plane the worker is connected to (it serves the project's signed
  releases: see [Updating workers](../self-hosting/README.md#updating-workers)). Set
  `updates.manifestUrl` to use another source.
- **Trust:** the worker installs only releases signed with a key it trusts: the project's release key (built
  into the worker) or one in `updates.trustedKeys`. For your own builds, add your public key in the worker UI
  (**Updates → Trusted release keys**). The control plane can
  deliver releases but can't add keys, so it can't make a worker run code that wasn't signed by the
  publisher. Nothing is installed unless the manifest signature and the package checksum both verify.
- **Manual:** the local UI's update section (or `POST /api/updates/apply` on the local API) downloads,
  verifies and installs the new version. **Automatic:** set `updates.policy` to `automatic`; the worker
  checks every 6 hours.
- **Switching:** the worker stops taking new tasks, lets running ones finish, then restarts into the new
  version. The new version confirms itself once it is up (connected, or 30 seconds without crashing).
- **Rollback:** if the new version crashes or hangs before confirming, the launcher goes back to the
  previous version and never retries that version automatically. Re-running the installer with that
  version clears the mark.
- The current and the previous version are kept; older ones are removed.

Credentials after an update: worker packages up to v0.2.14 carried the OS credential store's library for
Linux only, so a Windows or macOS worker installed or updated from one kept its credentials in the
encrypted file. Later packages carry it for every system; such a worker copies its credentials to the OS
store once, on its first start with the new version, and stays connected.

Without an update source, update by re-running the installer: it installs the new version next to the old
one and makes it current. Configuration and credentials are kept.

## Pull requests

When a task's Git policy is `PULL_REQUEST`, the worker commits the task's changes on its branch, pushes
it, and opens a pull request (GitHub) or merge request (GitLab) into the branch the task started from:

- **With a token for the host** (worker UI → **Settings → Git hosting**): the worker reads the host and
  repository from the `origin` URL (https, ssh or `git@host:owner/repo`) and uses GitHub's or GitLab's REST
  API. github.com and gitlab.com need only the token. For GitHub Enterprise or self-managed GitLab, also
  give the API URL. The token is kept in the credential store.
- **Otherwise** the GitHub CLI is used (`gh pr create`), if it is installed and signed in.

If the pull request can't be opened (no token or `gh`, or the host refuses it, for example because
one already exists), the commit and push still stand, and the reason is in the task's Git result.
