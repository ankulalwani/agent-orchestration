# Core and extension boundary

This repository is the complete, self-hostable product. Distributions built on it, including the
maintainers' own hosted service, live in other repositories and **consume** this one; this one never
depends on them.

```
   this repository (core)          ◄── consumes a tagged release ──   a distribution
   everything needed to self-host                                     its own routes, hooks, collections,
                                                                      deployment and operations
```

## What belongs here

Anything a self-hosted installation needs or could reasonably use:

- the control plane, web dashboard, worker and worker UI, CLI, VS Code extension, mobile app;
- agents and agent adapters, model providers and the add-on model gateway, fallback and recovery;
- tasks, scheduling, dependencies, verification, Git, capabilities, skills, MCP, plugins, integrations;
- organizations, users, teams, RBAC, audit, notifications, instance administration (server settings,
  feature flags, signed worker releases);
- database models and migrations, Docker Compose, the Helm chart and Terraform module, installers;
- documentation and tests for all of it.

Removing any of these would stop someone from self-hosting, so they stay here.

## What does not belong here

Code whose only purpose is to operate a particular commercial service:

- payment processing, pricing, plans, subscriptions, invoices and their data;
- provisioning and lifecycle of a vendor's own cloud resources, and its infrastructure definitions;
- a vendor's internal support, staff and incident tooling;
- credentials, internal hostnames, account ids, or configuration of any real deployment.

Self-hosted installations have **no usage limits** (tasks, workers, members, projects). Limits, if any, are
a distribution's business and are added through the extension points below. This is tested in
`tests/integration/extension-contract.test.ts`.

## Extension points

| Point | Use it to |
|---|---|
| `ControlPlaneExtension` passed as `extend` to `buildApp` or `startControlPlane` (`@ao/api`, `@ao/api/server`) | add routes, add `preHandler` hooks that run before core routes (and may answer instead of them), start background work with the core `services` |
| `services.tasks.addCreateGuard(fn)` (`@ao/server`) | refuse task creation by its own rules (a plan limit), whatever creates the task: a person, a schedule, an integration delivery, a template, a plan. A `preHandler` hook only sees requests; the guard also covers tasks no request creates. A guard refuses by throwing an `AppError`; the core registers none |
| `createServices()` and the exported services (`@ao/server`) | authenticate callers (`auth.verifyAccess`), resolve roles (`orgs.resolveActor`), write audit entries (`audit`) |
| Exported models (`@ao/database`) | read core data; keep extension data in the extension's own collections, keyed by `organizationId` |
| RBAC permissions (`@ao/core`) | check generic permissions such as `billing.manage` (owners) |
| `WebExtension` passed to `renderWebApp` (`@ao/web/app`, `@ao/web/extension`) | add dashboard pages, navigation items (organization or server section) and a banner above every page; reuse `@ao/web/lib/api`, `@ao/web/lib/session`, `@ao/web/layout` and `@ao/ui` |
| `notifications.notify({ type: 'organization.notice', email: true, roles })` (`@ao/server`) | tell an organization's members something in-app and by email |
| `controlPlaneCommands`, `runCommandFromArgv` (`@ao/api/server`) | offer the core's one-off commands (`platform-admin`, `reencrypt-secrets`, `seed-demo`) from another entry point |
| `DEPLOYMENT_MODE=cloud` | mark a shared, multi-tenant installation (stricter defaults such as `REQUIRE_PUBLIC_CALLBACK_URLS`) |
| `FIRST_USER_IS_PLATFORM_ADMIN=false` | where the public can sign up first; grant administrators with `platform-admin <email>` |
| `EXPO_PUBLIC_HOSTED_URL` | preset a default server in a mobile build |

The contract of these points is tested here, so changes that would break a distribution fail this
repository's CI first. Changing an extension point is a breaking change (see `CORE_VERSIONING.md`).

## Rules

1. No import, `require`, workspace dependency, Git/file dependency or environment variable that refers to
   code outside this repository.
2. Organization is the tenant. An extension may attach its own records to an organization, never change
   core schemas.
3. Behaviour that a shared installation needs (for example SSRF protection) is a **setting** here, not a
   check for "is this the vendor's service".
4. Examples and defaults use reserved names only (`example.com`, `.example`, `.test`, `.invalid`).

`scripts/check-boundary.mjs` enforces rule 1 and blocks payment-provider identifiers; it runs in CI together
with a gitleaks scan of the full history. A distribution runs the same script against the core it pins,
adding its own identifiers with `BOUNDARY_EXTRA_PATTERNS`, so its names never need to be listed here.
