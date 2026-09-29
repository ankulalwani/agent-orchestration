# Release process

## Core release

1. `main` is green in CI (boundary + secret scan, typecheck, tests, build, Docker image + Compose smoke).
2. Decide the version from [CORE_VERSIONING.md](CORE_VERSIONING.md); list extension-point changes and
   migrations in the release notes.
3. Bump the version in the root `package.json` and in every `apps/*/package.json` and
   `packages/*/package.json` (they share it), and `image.tag` in `deployment/helm/agent-orchestrator/values.yaml`
   and the Terraform default.
4. Commit `release: vX.Y.Z`, tag `vX.Y.Z` (annotated), push the tag. CI runs again on the tag.
5. Artifacts from the tag:
   - control-plane image: `docker build -f deployment/docker/control-plane.Dockerfile -t <registry>/agent-orchestrator:X.Y.Z .`
   - worker package: `node scripts/package-worker.mjs`, signed with your release key:
     `node scripts/sign-release.mjs sign <key>.private.pem <keyId> <worker.tgz> X.Y.Z <packageUrl>`
     (keep the private key offline; workers trust the public key), then published in
     **Server → Worker releases**.
   - VS Code extension: `pnpm --filter agent-orchestrator-vscode package`.

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
