# Easypanel

One-click deployment of the control plane (API + web dashboard) with MongoDB and Redis on
[Easypanel](https://easypanel.io). Easypanel provides the domain and HTTPS.

The template pulls a prebuilt image, `ghcr.io/ankulalwani/agent-orchestration:<version>`, published by
[.github/workflows/docker-publish.yml](../../.github/workflows/docker-publish.yml) on every `v*` tag.
After the first publish, make the package public (GitHub → Packages → agent-orchestration → Package
settings → Change visibility), or Easypanel cannot pull it.

## What gets created

| Service | Image | Notes |
|---|---|---|
| `agent-orchestration` | `ghcr.io/ankulalwani/agent-orchestration:0.2.0` | Port 4000 behind the Easypanel domain. Volume `data` at `/app/data` holds task artifacts. |
| `agent-orchestration-mongo` | `mongo:7` | Source of truth. |
| `agent-orchestration-redis` | `redis:7-alpine` | BullMQ dispatch queue. |

`JWT_SECRET`, `ENCRYPTION_KEY` and the database passwords are generated at deploy time.
`PUBLIC_URL`, `WEB_URL` and `CORS_ORIGINS` use the service's primary domain.

## Option 1: Create from Schema (private, works today)

```bash
node deployment/easypanel/generate-schema.mjs > easypanel-schema.json
```

In Easypanel: create a project → **Templates** → **Create from Schema** → paste the file contents →
**Create**. Delete `easypanel-schema.json` afterwards: it contains the secrets.

Options: `--name <service-name>` and `--image <image:tag>`.

## Option 2: Official template (listed in Easypanel for everyone)

Submit [agent-orchestration/](agent-orchestration/) to
[easypanel-io/templates](https://github.com/easypanel-io/templates):

1. Fork the repository and copy this folder to `templates/agent-orchestration/`.
2. Add `logo.png` (square) and `screenshot.png` (the dashboard) to that folder.
3. Run `npm install`, `npm run dev` and test it in the playground.
4. Run `npm run build` and `npm run prettier`, then open a pull request.

Easypanel requires a pinned image version. Bump `appServiceImage` in `meta.yaml` and add a `changeLog`
entry for each release.

## After deploying

1. Open the domain and create the first account immediately. It becomes the platform administrator.
2. Close registration: dashboard → Server settings, or set `ALLOW_REGISTRATION=false` in the app's
   environment. Invite members from **Settings → Members**.
3. Copy `ENCRYPTION_KEY` from the app's environment to a safe place. Without it, stored secrets cannot be
   recovered.
4. Install a worker on each machine that runs agents and point it at the domain
   ([SELF_HOSTING.md](../../docs/SELF_HOSTING.md#2-worker-on-each-machine-that-runs-agents)).

Upgrade: change the app's image tag in Easypanel and deploy. Migrations run on start.
