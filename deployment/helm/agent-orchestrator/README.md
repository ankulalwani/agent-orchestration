# Helm chart (optional)

Kubernetes is not required; Docker Compose or plain Node.js are fully supported (see docs/self-hosting).

**Status: UNVERIFIED.** Helm and a cluster were not available on the build machine, so this chart has
not been rendered or installed.

```bash
kubectl create secret generic agent-orchestrator \
  --from-literal=JWT_SECRET=... --from-literal=ENCRYPTION_KEY=... \
  --from-literal=MONGODB_URI=mongodb://... --from-literal=REDIS_URL=redis://...
helm install ao deployment/helm/agent-orchestrator --set image.repository=<registry>/agent-orchestrator
```

Use MongoDB (self-managed or MongoDB Atlas) and Redis. Only real MongoDB (7/8) has been tested; "MongoDB-compatible"
services may lack features this platform uses (for example text indexes or `$expr` in updates), so test them
before relying on them. Run more than one replica only with `REDIS_URL`.

## Operations (off by default)

| Values | Adds |
|---|---|
| `autoscaling.enabled` (+ `minReplicas`, `maxReplicas`, `targetCPUUtilizationPercentage`) | HorizontalPodAutoscaler on CPU, and a PodDisruptionBudget. Needs `REDIS_URL` in the secret. |
| `backup.enabled` (+ `schedule`, `retentionDays`, `persistence.*`) | Nightly `mongodump --archive --gzip` CronJob, kept on a volume and pruned after `retentionDays` |
| `backup.s3.bucket` (+ `prefix`, `region`, `endpoint`) | Upload backups to S3 or S3-compatible storage instead (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` from the secret) |
| `monitoring.serviceMonitor.enabled` | Prometheus Operator scraping of `/metrics` |
| `monitoring.prometheusRule.enabled` | Alerts: API down, >5% server errors, queued work without workers, many failed tasks, expiring leases |

Restore a backup as described in [backup and restore](../../../docs/self-hosting/backup-restore.md). The
[Terraform module](../../terraform/kubernetes) installs the chart with these switches.
