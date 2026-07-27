# 8. Operations & Deployment

## Hosting (Render)

| Component | Render resource |
|-----------|-----------------|
| Backend API | Web service `esat-backend` (`node server.js`) |
| Database | Managed PostgreSQL `esat_db` |
| Frontend | Separate static deployment (built React SPA) |

Both repos auto-deploy from `main` on push.

## Environment variables

Set on the **`esat-backend`** service → Environment (never committed; `.env` is
git-ignored locally):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs/verifies auth tokens — **required**, the server refuses to boot without it |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Image/document uploads |
| `RESEND_API_KEY` | Email |
| `NODE_ENV` | `production` on Render |
| `PORT` | Provided by Render; the server binds to it |

Rotating any of these: see [`../SECURITY.md`](../SECURITY.md) — and note
`JWT_SECRET` rotation requires re-minting the sync token
([Integrations & Sync](07-integrations-and-sync.md)).

## Deploy flow

1. Push to `main` (backend → `Maged254/esat`, frontend → `Maged254/esat-frontend`).
2. Render builds and redeploys automatically.
3. On backend boot, `setupDB()` applies schema/migrations idempotently
   (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) — no
   separate migration step.
4. **All non-sync sessions are invalidated** on deploy (tokens older than boot
   time are rejected), so users re-log in. The sync account is exempt.

### Frontend build

- `npm run build` (Create React App). A `prebuild` step stamps `src/version.js`
  from the latest git commit (date + short hash) so the running build is
  identifiable in the UI.
- ⚠️ The API base URL is set in `src/utils/api.js` (points at the deployed
  backend). If the backend host changes, update it there.

## Local development

| Component | Command | Notes |
|-----------|---------|-------|
| Backend | `node server.js` | Needs a local `.env` (at least `DATABASE_URL`, `JWT_SECRET`) |
| Frontend | `npm start` | CRA dev server on port 3000 |

> Note: `src/utils/api.js` currently targets the **deployed** API, so local
> frontend work talks to the live backend unless you point it at a local server.

## Scheduled jobs

- `scheduleDailyDigest()` runs on server start and sends the **SCM** and **PM**
  daily digests via Resend (pending/ordered summaries to the relevant owners).

## Logging & observability

- **`request_logs`** table records API calls: `endpoint`, `status_code`,
  `duration_ms`, and `error_detail`, indexed by time and user — useful for
  debugging errors and slow endpoints.
- **`sync_log`** records each sync run (see Integrations).
- Render's own service logs capture stdout/stderr (`console.error`, digest
  results, boot messages).

## Security & accounts

- Default seeded admin `admin@egypro.com` — change its password on first use.
- Login lockout: 5 failed attempts → 15-minute lock.
- Secret handling and the full rotation runbook: [`../SECURITY.md`](../SECURITY.md).

## Operational checklist

- [ ] Confirm Render **automatic backups** are enabled on `esat_db`.
- [ ] Keep both repositories **private** if possible (currently public).
- [ ] After any deploy, expect a one-time re-login for all users.
- [ ] After `JWT_SECRET` rotation, re-mint and update the Power Automate sync token.
