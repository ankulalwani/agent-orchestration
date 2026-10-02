import { AppError } from '@ao/core';
import type { ServerConfig } from './config.js';
import { audit } from './audit.js';
import type { PlatformActor } from './context.js';

/**
 * Product updates for the control plane itself, driven by an administrator (nothing runs in the background,
 * so a self-hosted server makes no outbound call until someone presses "Check for updates").
 *
 * The check compares this build's version (AO_VERSION, set in the image) with the newest `vX.Y.Z` tag of
 * UPDATE_CHECK_REPO. "Update now" calls UPDATE_WEBHOOK_URL, the deployment platform's redeploy hook, which
 * pulls the newest image and restarts the server. A server cannot replace its own container, so without a
 * hook the page shows the manual steps.
 */
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const parse = (v: string) => (v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const newer = (a: string, b: string) => {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  releaseUrl: string | null;
  repo: string;
  /** Update now is possible (a redeploy hook is configured). */
  canApply: boolean;
}

export class UpdateService {
  private last: { latest: string | null; checkedAt: string } | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly version: string,
  ) {}

  status(): UpdateStatus {
    const latest = this.last?.latest ?? null;
    return {
      current: this.version,
      latest,
      updateAvailable: Boolean(latest) && newer(latest!, this.version),
      checkedAt: this.last?.checkedAt ?? null,
      releaseUrl: latest ? `https://github.com/${this.config.UPDATE_CHECK_REPO}/releases/tag/v${latest}` : null,
      repo: this.config.UPDATE_CHECK_REPO,
      canApply: Boolean(this.config.UPDATE_WEBHOOK_URL),
    };
  }

  async check(): Promise<UpdateStatus> {
    let res: Response;
    try {
      res = await fetch(`https://api.github.com/repos/${this.config.UPDATE_CHECK_REPO}/tags?per_page=100`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-orchestration-update-check' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new AppError('INTERNAL', `Could not reach GitHub: ${(e as Error).message}`);
    }
    if (!res.ok) throw new AppError('INTERNAL', `GitHub answered ${res.status} for ${this.config.UPDATE_CHECK_REPO}`);
    const tags = ((await res.json()) as Array<{ name: string }>).map((t) => t.name).filter((n) => TAG.test(n));
    const latest = tags.reduce<string | null>((best, t) => (!best || newer(t, best) ? t : best), null);
    this.last = { latest: latest ? latest.slice(1) : null, checkedAt: new Date().toISOString() };
    return this.status();
  }

  /** Asks the deployment platform to redeploy. The server restarts shortly after, so the answer only says it was asked. */
  async apply(actor: PlatformActor): Promise<{ requested: true }> {
    const url = this.config.UPDATE_WEBHOOK_URL;
    if (!url) throw new AppError('VALIDATION_FAILED', 'No redeploy hook is configured (UPDATE_WEBHOOK_URL)');
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new AppError('INTERNAL', `The redeploy hook did not answer: ${(e as Error).message}`);
    }
    if (!res.ok) throw new AppError('INTERNAL', `The redeploy hook answered ${res.status}`);
    await audit(actor, 'server.update.apply', null, { from: this.version, to: this.last?.latest ?? null });
    return { requested: true };
  }
}
