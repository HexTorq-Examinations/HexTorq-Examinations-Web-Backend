# HexTorq Examinations Backend

## Durable deadline worker

Every started attempt creates an `AttemptDeadlineJob` row in PostgreSQL. Workers
claim due jobs with row locking, so multiple worker instances are safe and a job
survives API restarts or student/browser shutdowns.

For a single persistent API process, the worker runs embedded by default:

```powershell
npm start
```

For production multi-instance or serverless API deployments, disable the embedded
worker on API instances and run a separate persistent worker service:

```powershell
$env:DEADLINE_WORKER_MODE='external'
npm start
```

```powershell
npm run worker:deadlines
```

Optional worker settings:

- `DEADLINE_POLL_INTERVAL_MS` (default `2000`)
- `DEADLINE_BATCH_SIZE` (default `25`)

Apply database changes before deploying either process:

```powershell
npx prisma migrate deploy
npx prisma generate
```

## Operations

Create a PostgreSQL custom-format backup:

```powershell
npm run db:backup
```

Restore the latest backup into an isolated temporary database, verify Prisma
migration history, and automatically remove the temporary database:

```powershell
npm run db:test-restore
```

Set `PG_BIN` when PostgreSQL command-line tools are not on `PATH`. Set
`BACKUP_DIR` to store dumps outside the checkout. Production backups should be
copied to encrypted off-site storage with retention rules.

Operational APIs for organization admins and super admins:

- `GET /api/system/health` — worker heartbeat, deadline queue, error and delivery health
- `GET /api/system/errors` — aggregated unresolved application errors
- `GET /api/system/deliveries` — email, SMS, push, and in-app delivery status
- `GET /api/audit-logs` — administrative action history

Set `ALERT_WEBHOOK_URL` to receive JSON alerts for HTTP 5xx errors and
`LOG_LEVEL` to control structured JSON logging verbosity.
