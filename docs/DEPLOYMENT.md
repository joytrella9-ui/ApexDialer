# Deployment

Do not expose this process to the public internet without TLS and an explicit decision.

## Vercel is not a host for this app

ApexDialer is a long-running **Node + Express + SQLite** process with session cookies, Twilio webhooks, and a native `better-sqlite3` module. Vercel’s serverless platform does not provide a writable persistent disk or a always-on Node process, so **do not deploy this repository to Vercel**. Connecting the GitHub repo to Vercel will not launch a working dialer.

Use GitHub as the source of truth, then deploy the same repo to an always-on host (Render, Railway, Fly.io, or a VM) with the Dockerfile in the repo root.

## Local (supported)

`npm start` on the operator’s machine, bind `127.0.0.1`.

## Hosted (checklist, not performed)

1. SQLite on durable disk; set `APEX_DB_PATH`.
2. Reverse proxy with HTTPS.
3. `HOST` only as needed; `APEX_COOKIE_SECURE=true`.
4. `APEX_PUBLIC_BASE_URL=https://your-origin` (origin only, no path).
5. Secrets in the environment, never in the repo.
6. `npm run backup` on a schedule; test restore on a copy.
7. Rollback: keep previous `data/apexdialer.db` backup and the git revision of the app.

There is no production `liveEnabled` switch in config. Enabling real calls requires a code change plus credentials plus legal approval.

## Rollback

Restore `data/apexdialer.db` (and `-wal`/`-shm` if present) from a backup taken with `npm run backup`. Restart the process. See README backup section.
