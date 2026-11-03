# Database backup and restore runbook

Nexus Hub production database is PostgreSQL via `DATABASE_URL`. Backups contain personal and operational data, so handle them as sensitive production data.

## Safety rules

- Never run `prisma db push --accept-data-loss` against production.
- Always create a fresh backup before migrations, deploys, bulk fixes or restore attempts.
- Verify every backup by restoring it to a separate database, not directly to production.
- Prefer restoring to a new database and switching `DATABASE_URL` over in-place production restore.
- Store backups off-host or in encrypted storage. A backup on the same VM is not disaster recovery.

## Manual backup

From the backend server:

```bash
cd /root/nexus-backend
DATABASE_URL="$DATABASE_URL" BACKUP_DIR=/var/backups/nexus npm run db:backup
```

The script writes a custom-format `pg_dump` file and a checksum:

- `/var/backups/nexus/nexus_YYYYMMDDTHHMMSSZ.dump`
- `/var/backups/nexus/nexus_YYYYMMDDTHHMMSSZ.dump.sha256`

Backup files are created with owner-only permissions via `umask 077`.
Default retention is 14 days. Override it with:

```bash
RETENTION_DAYS=30 npm run db:backup
```

## Automated schedule

Example cron entry:

```cron
15 2 * * * cd /root/nexus-backend && DATABASE_URL='postgresql://...' BACKUP_DIR=/var/backups/nexus RETENTION_DAYS=30 npm run db:backup >> /var/log/nexus-db-backup.log 2>&1
```

Recommended retention:

- Daily backups: 14 to 30 days.
- Weekly backups: 8 to 12 weeks.
- Monthly backups: 6 to 12 months.

Copy at least one daily backup off the app server. On the current server this is
done by `scripts/odvez-zalohu.sh`, described below.

## What is actually configured on api.nexusstack.eu (3 Nov 2026)

The sections above describe the intended practice. This section records what is
installed and verified, so nobody has to guess.

| Where | What |
| --- | --- |
| `/root/nexus-zalohy/nocni-zaloha.sh` | Nightly backup. Runs `scripts/backup-postgres.sh`, then the encryption step. |
| `/root/nexus-zalohy/sifrovana-kopie.sh` | Encrypts the newest dump with GPG AES256 and test-decrypts it. |
| `/root/nexus-zalohy/kontrola-veku.sh` | Daily staleness check: fails if the newest dump is older than 36 h. |
| `/var/backups/nexus/` | Dumps, checksums and `*.dump.gpg`. Retention 14 days. Mode 700, root only. |
| `/var/log/nexus-zaloha.log` | Log of every run. |
| `/root/zaloha-heslo.txt` | GPG passphrase, mode 600. **A copy must exist outside the server or the encrypted archives are unopenable.** |

Root crontab:

```cron
17 3 * * * /root/nexus-zalohy/nocni-zaloha.sh
5 9 * * * /root/nexus-zalohy/kontrola-veku.sh
```

The staleness check runs during the day on purpose: a problem found at 09:05 gets
noticed, one logged at 03:17 does not.

### Why a wrapper instead of calling the script from cron directly

Cron mails the job's output to root on a non-zero exit, and this machine has no
mail configured. A failing backup would therefore be invisible — which is exactly
what cost the production data on 3 Nov 2026. The wrapper writes to the log and, on
failure, leaves a conspicuous `SELHALO-*.txt` in the backup directory, visible from
a plain `ls`. A successful run removes those markers. The staleness check behaves
the same way with `ZALOHA-ZASTARALA.txt` and `ZADNA-ZALOHA.txt`.

Both failure paths were tested by forcing them, not assumed: a broken
`DATABASE_URL` produced exit code 1 plus the marker, and back-dating the dumps by
three days produced the staleness marker.

### Taking a copy off the server

```bash
bash scripts/odvez-zalohu.sh
```

Pulls the newest `*.dump.gpg` to `~/Zalohy/nexus-hub`, keeps the last 7, and — if a
passphrase file is available — **decrypts it and compares the checksum against the
original on the server**. Without that step a transferred file is only a hope; the
three zips that could not be used on 3 Nov 2026 looked fine from the outside too.

The passphrase is read from `ZALOHA_HESLO_FILE` (default `~/.nexus-zaloha-heslo`).
With no passphrase file the script still transfers the archive but says clearly
that it did **not** verify it. A wrong passphrase and a corrupted archive are
reported differently, because during a restore that distinction tells you where to
look.

Verified on 3 Nov 2026: the copy on the laptop decrypts and matches the dump on the
server, checked without involving the server.

Three guarantees the script makes, because a backup tool must not lose data:

- **A finished copy is never replaced by an unverified one.** The download lands
  under its own staging name, is verified, and only then replaces the previous
  file. A failed candidate is kept as `VADNY-*`; one that could not be verified
  at all (no passphrase file, copy already present) is kept as `NEOVERENY-*`. The
  earlier verified copy stays untouched in both cases.
- **Two concurrent runs cannot interleave.** A `mkdir` lock (atomic on Linux and
  macOS) makes the second run exit with a clear message instead of writing into
  the first run's files.
- **Retention cannot delete what the run just fetched.** `ZALOHA_PONECHAT` must be
  an integer ≥ 1 — zero would have passed every archive, including the fresh one,
  to `rm` and still exited successfully. The published file is also excluded from
  cleanup by name, so a clock skew that makes another archive look newer cannot
  delete it either.

Each of these was tested by forcing the failure, not by reading the code.

### Still missing

- **Nobody is notified.** Markers and the log only help someone who looks. There is
  no mail or Telegram channel configured on this server, so a failed backup is
  found by checking, not by being told.
- **The off-server copy is manual.** `scripts/odvez-zalohu.sh` has to be run. An
  automated pull would put personal data on a laptop on a schedule, which is a data
  protection decision, not just a technical one — see
  `docs/zpracovani-osobnich-udaju.md`.
- **The CI job `Backup / Restore Readiness Audit` proves nothing about this server.**
  It runs `server/scripts/audit-backup-restore.js` on the GitHub runner, and without
  `STRICT_BACKUP_AUDIT=true` a missing backup is not even an error. It passed green
  on 3 Nov 2026 while the production server had zero backups.

## Pre-deploy backup

**CI does this on its own since the `deploy-backend` backup gate landed.** On a
push to `master` the job runs `prisma migrate status`; if migrations are
pending it takes a verified backup into `/var/backups/nexus-pred-migraci`
(90-day retention) and refuses to run `prisma migrate deploy` unless that
backup succeeded. If the migration state cannot be determined — diverged
history, a database Prisma does not manage, an unreachable database — the
deploy stops instead of migrating blind.

**The gate does not detect schema drift.** `prisma migrate status` reads the
`_prisma_migrations` table and compares it with `prisma/migrations`; it never
inspects the live table structure. A hand-run `ALTER TABLE` on production
leaves migration history intact, so the gate still reports "up to date" and
takes no backup. Use the `Schema Drift Check` job and `prisma migrate diff`
for that. The gate guarantees one thing only: a **migration** will not run
without a verified backup.

`migrate deploy` is **not** harmless: it applies migrations as written, and
`20261027000001_blacklist_reasons` drops columns. The gate exists because that
is irreversible and nothing in the chain used to back up first.

The steps below are for a **manual** deploy, or for a deploy run from anywhere
other than the pipeline:

```bash
cd /root/nexus-backend
npm run db:backup:audit
npm run db:backup
npx prisma migrate deploy
pm2 restart nexus-backend-final
```

If `npm run db:backup` fails, stop the deploy.

For a strict pre-pilot readiness check that also requires restore verification
inputs:

```bash
cd /root/nexus-backend
STRICT_BACKUP_AUDIT=true \
RESTORE_DATABASE_URL='postgresql://nexus:password@localhost:5432/nexus_restore_verify' \
BACKUP_FILE='/var/backups/nexus/nexus_YYYYMMDDTHHMMSSZ.dump' \
npm run db:backup:audit
```

The audit does not run `pg_dump` or `pg_restore`; it only checks required env,
PostgreSQL tooling, backup directory writability, retention settings and that
`RESTORE_DATABASE_URL` does not point to the same host/database as `DATABASE_URL`.

## Restore verification drill

Create an empty restore database first. Do not point `RESTORE_DATABASE_URL` to production.
The verification script refuses to run if `RESTORE_DATABASE_URL` equals `DATABASE_URL`.

```bash
createdb nexus_restore_verify
export RESTORE_DATABASE_URL='postgresql://nexus:password@localhost:5432/nexus_restore_verify'
export BACKUP_FILE='/var/backups/nexus/nexus_YYYYMMDDTHHMMSSZ.dump'
cd /root/nexus-backend
npm run db:restore:verify
```

Expected result:

- Checksum passes, if `.sha256` exists.
- `pg_restore` exits with code `0`.
- Row counts are printed for `Agency`, `User`, `Profile`, `Chat`, `Message`, `Subscription` and `DeviceBinding`.
- Optional staging backend can start against `RESTORE_DATABASE_URL`.

## Production restore

Use this only during an incident.

1. Announce maintenance window and stop user writes.
2. Stop backend workers and app processes.
3. Take an emergency backup of the current broken database.
4. Restore the selected backup into a new database.
5. Run `npm run db:restore:verify` against the new database.
6. Switch backend `DATABASE_URL` to the restored database.
7. Run `npx prisma migrate deploy`.
8. Restart backend.
9. Verify `/health` and `/api/admin/operational-health`.
10. Run an application smoke test: login, profiles, inbox, latest SMS, Stripe checkout status, Relay binding list.

In-place restore fallback:

```bash
pg_restore --clean --if-exists --no-owner --no-acl --dbname "$DATABASE_URL" "$BACKUP_FILE"
```

Only use in-place restore if switching to a new database is not possible.

## Restore acceptance checklist

- App Owner can log in.
- At least one agency, manager and profile are visible.
- Inbox loads recent chats and messages.
- Device bindings still map to correct profiles.
- Active subscriptions and agency plans are present.
- Stripe pending/active subscriptions are consistent with Stripe Dashboard.
- Relay phone can verify and send one inbound SMS.
- New outgoing SMS can move from `pending_relay` to `sent` or `failed`.
- `/health` returns `200`.
- `/api/admin/operational-health` is `ok` or has only understood non-blocking warnings.

## Backup failure alerting

If backups are scheduled through cron, send cron output to a monitored log or system mail. A silent failing backup job is equivalent to no backup.

Minimum operational practice:

- Check backup log daily.
- Perform restore verification weekly.
- Perform a full restore drill before pilot launch and after every database schema change.

## Encrypted archive before decommissioning

A rotating backup and a decommissioning archive are not the same thing. When the
service is being shut down or paused indefinitely, the production database must
not simply be left running: an unattended database holding location traces,
blacklist entries and message history, with no retention policy and nobody
watching it, is the worst possible position to be in.

Use `server/scripts/archive-encrypted.sh` on the backend server:

```bash
openssl rand -base64 48 > /root/nexus-archive-passphrase.txt
chmod 600 /root/nexus-archive-passphrase.txt

ARCHIVE_PASSPHRASE_FILE=/root/nexus-archive-passphrase.txt \
ARCHIVE_DIR=/var/backups/nexus-archive \
bash server/scripts/archive-encrypted.sh
```

The script dumps the database, bundles it with a row-count manifest, encrypts
the bundle with GPG symmetric AES-256, and then **decrypts it again and compares
the result byte for byte** before deleting the plaintext dump. If any step of
that chain fails it leaves the plaintext dump in place and says where, because
the alternative is deleting the only readable copy.

The passphrase is read from a file and never passed as an argument — arguments
are visible to every user on the box through `ps`.

Go/no-go before deleting production data:

- The archive and its `.sha256` are stored on two separate physical targets,
  neither of them the server being decommissioned.
- The passphrase is stored separately from the archive. There is no recovery
  without it.
- The archive has been opened from the copy you took away, not from the one
  still on the server.
