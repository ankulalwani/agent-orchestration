# Integrations: tasks from GitHub, GitLab and other systems

An integration is a webhook address of your organization. Deliveries to it become tasks in one project.
Set them up in **Settings → Integrations** (administrators; permission `settings.manage`), or through
`/orgs/:orgId/integrations` in the API.

When you create an integration you get a **webhook URL** (`<PUBLIC_URL>/api/v1/hooks/<id>`) and a
**secret**. The secret is shown once; **Rotate secret** replaces it. Tasks are created on behalf of the
member who created the integration. If that person leaves the organization, deliveries are refused until
someone recreates the integration.

## GitHub

Repository **Settings → Webhooks → Add webhook**: the payload URL, content type `application/json`, the
secret, and the events *Issues* and *Issue comments* (and *Pull requests* for [reviews](#reviews)). Deliveries must carry a valid `X-Hub-Signature-256`.

- **Issues** become tasks when they are opened with the configured label (default `agent`), or when that
  label is added later. With an empty label, every new issue becomes a task.
- **Comments** starting with the command (default `/agent`) create a task from the rest of the comment,
  with the issue or pull request as context. Comments by bots are ignored.
- **Replies (optional):** set *Token secret for replies* to the name of an organization secret that holds
  a GitHub token with permission to comment. The issue then gets a comment with the task link when the
  task is created, and another when it completes, fails or needs attention. For GitHub Enterprise, set
  the API base URL (for example `https://github.example.com/api/v3`).

## GitLab

Project **Settings → Webhooks**: the URL, the secret as *Secret token*, and the triggers *Issues events*
and *Comments*. The `X-Gitlab-Token` header must match the secret. Issues and `/agent` comments work as
on GitHub. Replies are notes, posted with a token (`PRIVATE-TOKEN`) from the named secret. For
self-managed GitLab, set the API base URL (for example `https://gitlab.example.com`).

## Reviews

With **Review pull/merge requests** set to *When opened* (or *When opened and on every push*), pull
requests (GitHub event *Pull requests*) and merge requests (GitLab *Merge request events*) become
[review tasks](../agents/README.md#review-tasks). Drafts are skipped. Each head commit is reviewed once.
The worker's project folder must be a clone whose `origin` is that repository, so the worker can fetch
the pull or merge request.

When the review is done, and a reply token is configured:
- **GitHub:** a pull request review is posted, with line comments where the agent gave a line. It is
  always posted as a *comment*, never as an approval or a change request, so it can't satisfy or block
  branch protection. The verdict is written in the text. If GitHub refuses line comments (lines outside
  the diff), the review is posted again with all comments in its text.
- **GitLab:** one merge request note with the verdict, summary and comments.

## Any other system

`POST` JSON to the webhook URL with these headers:

- `X-AO-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>`;
- `X-AO-Delivery: <unique id>` (optional). Retries with the same id create one task. Without it, an
  identical body counts as the same delivery.

The title and prompt come from templates, where `{{path.to.value}}` is replaced with values from the
JSON, for example `[{{ticket.key}}] {{ticket.summary}}`. With a **callback URL**, the outcome is
POSTed there when the task completes, fails or needs attention:
`{ taskId, status, title, summary, url, ref }`, signed the same way in `X-AO-Signature`. With
`REQUIRE_PUBLIC_CALLBACK_URLS=true` (the default when `DEPLOYMENT_MODE=cloud`), callback URLs must be public
`https` addresses, so tenants of a shared installation cannot reach its private network.

## Behaviour

- One external item is one task. Redeliveries, and an issue that is opened with the label and then
  labeled again, return the existing task (`{"status":"duplicate"}`).
- Answers: `201 {"status":"created","taskId"}`, `200 {"status":"duplicate"|"ignored"|"pong"}`, `401`
  for a bad signature. An integration that is turned off acknowledges deliveries and ignores them.
- The task shows where it came from (with a link), and the integration list shows the last delivery and
  its result. Creating a task is recorded in the audit log.
