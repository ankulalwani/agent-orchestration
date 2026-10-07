# Release process

## Core release

1. `main` is green in CI (boundary + secret scan, typecheck, tests, build, Docker image + Compose smoke).
2. Decide the version from [CORE_VERSIONING.md](CORE_VERSIONING.md); list extension-point changes and
   migrations in the release notes.
3. Bump the version in the root `package.json` and in every `apps/*/package.json` and
   `packages/*/package.json` (they share it), and `image.tag` in `deployment/helm/agent-orchestration/values.yaml`
   and the Terraform default.
4. Commit `release: vX.Y.Z`, tag `vX.Y.Z` (annotated), push the tag. CI runs again on the tag.
5. Artifacts from the tag:
   - control-plane image: `docker build -f deployment/docker/control-plane.Dockerfile -t <registry>/agent-orchestration:X.Y.Z .`
   - worker package: built, signed with the project release key and attached to the GitHub Release by
     `.github/workflows/release-worker.yml` (secret `WORKER_RELEASE_SIGNING_KEY`; its public half is in
     `packages/core/src/release-keys.ts`). Self-hosted servers fetch it with **Server → Worker releases →
     Update workers**; nothing is uploaded by hand.
   - desktop app: installers and `latest.json`, attached by `.github/workflows/release-desktop.yml`. The
     release is a draft until this workflow has attached them and then publishes it (over 10 minutes after
     the tag), so `releases/latest/download/<installer>` never points at a release without installers.
   - VS Code extension: `pnpm --filter agent-orchestration-vscode package`.

## Downstream: distributions built on the core

```
core vX.Y.Z tagged
      ↓
distribution moves its pinned core to vX.Y.Z  (one reviewed change)
      ↓
compatibility check (declared range) + the core's extension-contract tests
      ↓
the distribution's own tests
      ↓
its deployment
```

A core release never waits for a distribution, and nothing in the core refers to one.
