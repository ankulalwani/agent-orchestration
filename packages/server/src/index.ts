import { DEFAULT_POLICY, errorReporter } from '@ao/core';
import { createDispatchQueue, type DispatchQueue } from '@ao/queue';
import type { ServerConfig } from './config.js';
import { SecretBox } from './crypto.js';
import { LiveHub, attachRedisBridge } from './live.js';
import { createMetrics } from './metrics.js';
import { NotificationService, createMailer, type Mailer } from './notifications.js';
import { AuthService } from './auth.service.js';
import { OrgService } from './org.service.js';
import { InvitationService } from './invitation.service.js';
import { OAuthService } from './oauth.service.js';
import { ProjectService } from './project.service.js';
import { WorkerService } from './worker.service.js';
import { TaskService } from './task.service.js';
import { Scheduler } from './scheduler.js';
import { CapabilityService } from './capability.service.js';
import { RegistryService, manifestDigest, toPackageDto } from './registry.service.js';
import { QueryService } from './queries.service.js';
import { createArtifactStore } from './artifacts.js';
import { RuntimeSettings } from './runtime-settings.js';
import { FeatureFlags } from './feature-flags.js';
import { ApiTokenService } from './api-token.service.js';
import { IntegrationService } from './integration.service.js';
import { WorkerReleaseService } from './worker-releases.js';
import { DeviceLoginService } from './device-login.service.js';
import { GitHubService } from './github.service.js';
import { DiscoveryService } from './discovery.service.js';

export * from './config.js';
export * from './context.js';
export * from './crypto.js';
export * from './dto.js';
export * from './live.js';
export * from './metrics.js';
export * from './audit.js';
export * from './notifications.js';
export * from './retention.js';
export * from './artifacts.js';
export * from './key-rotation.js';
export * from './admin.service.js';
export * from './runtime-settings.js';
export * from './feature-flags.js';
export * from './api-token.service.js';
export * from './integration.service.js';
export * from './worker-releases.js';
export * from './seed.js';
export * from './device-login.service.js';
export * from './github.service.js';
export * from './discovery.service.js';
export { workerCheckouts, type RepositoryOrigin } from './project.service.js';
export { AuthService, OrgService, InvitationService, OAuthService, ProjectService, WorkerService, TaskService, Scheduler, CapabilityService, RegistryService, QueryService, manifestDigest, toPackageDto };

/**
 * Composition root for control-plane services. Both the self-hosted API and the cloud API call this
 * (spec §70), so there is a single implementation of the core behaviour.
 */
function configureErrorTracking(config: ServerConfig) {
  // Without a DSN or webhook this leaves no sender: reports are no longer sent anywhere.
  errorReporter.configure({
    service: config.ERROR_TRACKING_SERVICE,
    dsn: config.ERROR_TRACKING_DSN,
    webhookUrl: config.ERROR_TRACKING_WEBHOOK_URL,
    environment: config.ERROR_TRACKING_ENVIRONMENT ?? config.NODE_ENV,
    release: process.env.AO_VERSION ?? null,
  });
}

/** A mailer whose SMTP transport can be replaced while the server runs (settings changed in the web app). */
class SwitchableMailer implements Mailer {
  constructor(private current: Mailer & { configured: boolean }) {}
  get configured() {
    return this.current.configured;
  }
  replace(next: Mailer & { configured: boolean }) {
    this.current = next;
  }
  send(to: string, subject: string, text: string) {
    return this.current.send(to, subject, text);
  }
}

/**
 * Composition root for control-plane services. Both the self-hosted API and the cloud API call this
 * (spec §70), so there is a single implementation of the core behaviour.
 * `env` is the environment the configuration was read from: settings set there cannot be changed in the web app.
 */
export async function createServices(config: ServerConfig, overrides: { queue?: DispatchQueue; mailer?: Mailer; env?: NodeJS.ProcessEnv } = {}) {
  if (config.ERROR_TRACKING_DSN || config.ERROR_TRACKING_WEBHOOK_URL) configureErrorTracking(config);
  const live = new LiveHub();
  // Multi-instance: relay live updates and worker messages through Redis pub/sub.
  if (config.REDIS_URL && !overrides.queue) await attachRedisBridge(live, config.REDIS_URL);
  const metrics = createMetrics();
  const queue = overrides.queue ?? (await createDispatchQueue(config.REDIS_URL));
  const mailer: Mailer = overrides.mailer ?? new SwitchableMailer(await createMailer(config));
  const box = new SecretBox(config.ENCRYPTION_KEY, config.ENCRYPTION_KEYS_PREVIOUS);
  // Settings changed in the web app (SELFHOST-002) are written into `config`, which services read on
  // every use; the few things built from configuration up front are rebuilt here.
  const settings = new RuntimeSettings(config, overrides.env ?? process.env, box);
  settings.onChange((changed) => {
    if (changed.some((k) => k.startsWith('ERROR_TRACKING_'))) configureErrorTracking(config);
    if (changed.includes('SMTP_URL') && mailer instanceof SwitchableMailer) void createMailer(config).then((m) => mailer.replace(m));
  });
  const features = new FeatureFlags(config);
  const notifications = new NotificationService(config, live, mailer);
  const timing = { leaseMs: DEFAULT_POLICY.leaseMs, heartbeatMs: DEFAULT_POLICY.heartbeatMs, offlineThresholdMs: DEFAULT_POLICY.offlineThresholdMs };
  const auth = new AuthService(config, mailer, box);
  const oauth = new OAuthService(config, auth);
  const orgs = new OrgService();
  const invitations = new InvitationService(config, mailer, orgs);
  const projects = new ProjectService();
  const workers = new WorkerService(config, live, notifications, timing);
  const tasks = new TaskService(live, queue, metrics, notifications, features, box);
  const registry = new RegistryService(config);
  const capabilities = new CapabilityService(registry);
  const queries = new QueryService(box);
  const scheduler = new Scheduler(queue, live, tasks, workers, metrics, { sweepMs: config.SWEEP_INTERVAL_MS });
  workers.onCheckoutsAdded((organizationId, projectIds) => void tasks.redispatchProjects(organizationId, projectIds).catch(() => undefined));
  const artifacts = createArtifactStore(config);
  const apiTokens = new ApiTokenService();
  const integrations = new IntegrationService(config, box, tasks);
  const workerReleases = new WorkerReleaseService(config, artifacts);
  const deviceLogins = new DeviceLoginService(config, auth);
  const github = new GitHubService(config, box, projects);
  const discovery = new DiscoveryService(live, projects, github);
  github.cloneRequester = (actor, projectId, repositoryId, workerIds) => discovery.requestClone(actor, projectId, repositoryId, workerIds).then(() => undefined);
  // New repositories in projects (synced, created, added): map matching folders workers already found.
  const rematch = (organizationId: string) => void discovery.rematch(organizationId).catch(() => undefined);
  github.onRepositoriesChanged(rematch);
  projects.onRepositoriesChanged(rematch);
  return { github, discovery, apiTokens, integrations, workerReleases, deviceLogins, artifacts, config, settings, features, live, metrics, queue, mailer, box, notifications, auth, oauth, orgs, invitations, projects, workers, tasks, capabilities, registry, queries, scheduler, timing };
}
export type Services = Awaited<ReturnType<typeof createServices>>;
