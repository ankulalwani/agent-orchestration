# Desktop app for the worker

A [Tauri](https://tauri.app) shell that runs the worker on a developer's computer and shows the worker's
own local UI in a window. It ships Node.js and the worker package, so users install nothing else.
What users see is in [docs/workers/README.md](../../docs/workers/README.md#install); why it is built this
way is decision D-021 in [docs/DECISIONS.md](../../docs/DECISIONS.md).

```
Shell (Rust, src-tauri/)
 ├─ ao-node                       official Node.js, pinned by checksum (scripts/fetch-node.mjs)
 ├─ worker.tgz + WORKER_VERSION   the worker package (scripts/package-worker.mjs --tarball)
 ├─ ui/                           the app's own pages: start screen, log viewer
 └─ window → http://127.0.0.1:<port>/#token=…   the worker's local UI (apps/worker-ui)
      └─ starts: ao-node launcher.js → ao-node app/<version>/dist/main.js
```

| File | What it does |
|---|---|
| `src-tauri/src/main.rs` | Window, plugins, the commands pages may call, quitting |
| `src-tauri/src/worker.rs` | Installs the bundled worker if needed, starts and stops it, shows its UI |
| `src-tauri/src/seed.rs` | The versioned install layout (D-017) and when the bundled worker is installed |
| `src-tauri/src/takeover.rs` | Replaces a worker installed from the command line |
| `src-tauri/src/tray.rs`, `monitor.rs` | Tray menu and status line; notifications |
| `src-tauri/src/updates.rs` | Updates of the app itself |
| `src-tauri/src/logfile.rs` | The worker's output in one small rotated file |
| `src-tauri/capabilities/` | Which page may call which command |
| `scripts/release-assets.mjs` | Release file names and `latest.json` for the updater |

## Build it

You need the repository's usual tools (Node.js, pnpm), plus [Rust](https://rustup.rs) and Tauri's
[system packages](https://tauri.app/start/prerequisites/): the Visual Studio C++ build tools on Windows,
Xcode command line tools on macOS, `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
libxdo-dev patchelf` on Debian/Ubuntu.

```bash
pnpm install
pnpm --filter @ao/desktop desktop:dev       # packages the worker once, then runs the app from source
pnpm --filter @ao/desktop desktop:prepare   # package the worker again after changing it
pnpm --filter @ao/desktop desktop:bundle    # installers in src-tauri/target/release/bundle
(cd apps/desktop/src-tauri && cargo test)   # the shell's unit tests
```

On Windows without the Visual Studio build tools, Rust's GNU toolchain works for local builds: install
`stable-x86_64-pc-windows-gnu`, put a MinGW-w64 GCC on `PATH`, and run the scripts with
`RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu` and `prepare.mjs --target x86_64-pc-windows-gnu`. The
release installers are built with MSVC.

`desktop:bundle` signs the update files and needs `TAURI_SIGNING_PRIVATE_KEY`. Without the key, build
installers only: `pnpm --filter @ao/desktop tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

The app uses the same worker data folder as `pnpm dev:worker` and an installed worker. To try it without
touching yours, set `AO_WORKER_HOME` to an empty folder before starting it.

While developing, a rebuilt worker with an unchanged version number is **not** installed again (the app
only installs a newer one). Delete `worker-app` in the app's data folder (`io.agent-orchestration.worker`
under the user's local application data) to get the rebuilt worker.

## Rules that keep it safe

- The worker UI is a page from `127.0.0.1`, which Tauri treats as remote. It may call only the commands
  the capability `worker-ui` lists. A new command must be added to `build.rs` **and** to a capability, or
  no page can call it; never grant the worker UI more than it needs.
- The window opens only the app's own pages and `http://127.0.0.1`. Other links go to the browser.
- The bundled Node.js must match the checksum in `scripts/fetch-node.mjs`. To change the version, copy the
  new checksums from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`.
- The app never moves a worker back to an older version: it installs its bundled worker only when that is
  newer than the installed one.

## Releases

`.github/workflows/release-desktop.yml` builds the installers for each version tag and attaches them to
the GitHub Release, under names without a version. It needs the repository secret
`DESKTOP_UPDATER_PRIVATE_KEY` to publish updates for installed apps; its public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. A fork that wants its own updates generates a
key pair (`pnpm --filter @ao/desktop tauri signer generate`), replaces the public key and the endpoint
there, and sets the secret.
