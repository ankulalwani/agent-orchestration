# Backup and restore

| What | Why | How |
|---|---|---|
| MongoDB | Source of truth: users, organizations, projects, tasks, events, audit, capabilities, secrets (encrypted) | `mongodump` / `mongorestore` |
| `ENCRYPTION_KEY` | Decrypts organization secrets **and users' two-factor secrets** | Store it in your secrets manager, separately from the database backup. Without it, a restored database has unreadable secrets and two-factor users cannot sign in. After a key rotation, keep the old key for as long as you keep backups made before it |
| `JWT_SECRET` | Signs access tokens | If lost, users simply sign in again |
| Redis | Dispatch signals and live-update fan-out only | **Not required.** After a restore the scheduler rebuilds its queue from MongoDB (decision D-003). |
| Artifacts | Screenshots and reports from verification | `ARTIFACT_DIR` (filesystem driver) or your S3 bucket (`S3_BUCKET`): back it up with your usual file or bucket backup |
| Worker data | Per-machine config, event buffer, credentials | Usually not backed up: re-pair a worker instead. Credentials are in the OS store. |

`mongodump` and `mongorestore` are part of the
[MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools), a separate download from
the MongoDB server (no installation needed; unzip and run).

## MongoDB

```bash
# Docker Compose
docker compose exec -T mongo mongodump --archive --gzip --db agent_orchestrator > backup-$(date +%F).archive.gz
# restore
docker compose exec -T mongo mongorestore --archive --gzip --drop < backup-2026-09-27.archive.gz
```

Without Docker, run the same tools against `MONGODB_URI`:

```bash
mongodump    --uri "$MONGODB_URI" --db agent_orchestrator --archive=backup.archive.gz --gzip
mongorestore --uri "$MONGODB_URI" --archive=backup.archive.gz --gzip --drop
```

### Check a backup before you need it

Restore it into a **separate database** on the same server and look at it; this touches nothing in use:

```bash
mongorestore --uri "$MONGODB_URI" --archive=backup.archive.gz --gzip \
  --nsFrom='agent_orchestrator.*' --nsTo='agent_orchestrator_restore_check.*'
# …inspect, then drop agent_orchestrator_restore_check
```

### Verification

The procedure above (without Docker) is exercised by an automated drill,
`tests/integration/backup-restore.test.ts`, with MongoDB Database Tools 100.19.0 and MongoDB 8.3: realistic
data is backed up, checked through a separate-database restore, the database is dropped, restored with
`--drop`, and the control plane is restarted on it. After the restore, password and two-factor sign-in
work, organization secrets decrypt, unique indexes are enforced, task timelines and project data are
intact, counts of users, tasks, events and audit entries match, a task that was running during the
backup is recovered from its checkpoint by lease expiry, and new tasks can be created. The Docker Compose
form of the commands has not been run (Docker was not available).

## After a restore

- Restart the control plane with the **same `ENCRYPTION_KEY`**. Indexes and data migrations are applied
  automatically at start-up.
- Tasks that were running when the backup was taken are recovered by lease expiry. They are requeued from their last checkpoint, or marked `RECOVERY_REQUIRED` depending on policy.
- Workers reconnect by themselves. A worker paired after the backup was taken is unknown to the restored
  database; pair it again.
- Audit entries are immutable through the application. Restoring an older backup removes entries created after it, so keep audit exports if you need a continuous record.
