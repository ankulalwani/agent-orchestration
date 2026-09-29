# Core versioning

The repository has one version, in the root `package.json` (all workspace packages share it), released as
a Git tag `vMAJOR.MINOR.PATCH`. Distributions pin a tag, never a branch.

## Semantic versioning, applied to this codebase

While the version is `0.x`, the **minor** number is the breaking-change number:

| Change | Before 1.0 | From 1.0 |
|---|---|---|
| Breaking change to an extension point (see `PUBLIC_PRIVATE_BOUNDARY.md`): `ControlPlaneExtension`, `startControlPlane`, exported services or their method signatures, exported models' fields, RBAC permission names, `API_PREFIX`, settings that distributions set | 0.**x**.0 | **x**.0.0 |
| Breaking change to the public HTTP API (`/api/v1`) or the worker protocol | 0.**x**.0 (and the protocol version) | **x**.0.0 |
| Database migration that needs an action by the operator | 0.**x**.0 | **x**.0.0 |
| New feature, new setting with a backwards-compatible default, additive migration | 0.x.**y** | x.**y**.0 |
| Fix | 0.x.**y** | x.y.**z** |

The release notes list every change to an extension point, even compatible ones.

## Compatibility ranges for distributions

A distribution declares the core versions it supports as a range that excludes the next breaking version,
for example `>=0.1.0 <0.2.0`, and checks it in its CI against the tag it pins.

## How distributions consume the core

Workspace packages export TypeScript source (decision D-012) and are not published to a registry. A
distribution therefore includes a checkout of a tagged release (for example as a Git submodule) in its own
pnpm workspace, so `workspace:*` dependencies on `@ao/*` resolve to that checkout and its build bundles them
with tsup.

Publishing built packages (`@ao/core`, `@ao/contracts`, `@ao/server`, `@ao/api`, …) to a registry is the
planned next step once packages ship compiled output and type declarations; distributions would then pin
exact versions instead of a checkout, with the same ranges.
