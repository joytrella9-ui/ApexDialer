# Deployment

Do not expose this process to the public internet without TLS and an explicit decision.

## Vercel is not a host for this app

ApexDialer is a long-running **Node + Express + SQLite** process with session cookies, Twilio webhooks, and a native `better-sqlite3` module. Vercel’s serverless platform does not provide a writable persistent disk or a always-on Node process, so **do not deploy this repository to Vercel**. Connecting the GitHub repo to Vercel will not launch a working dialer.

Use GitHub as the source of truth, then deploy the same repo to **Render** (recommended) or another always-on host with the Dockerfile in the repo root.

## Render (supported hosted path)

Repo: `https://github.com/joytrella9-ui/ApexDialer`. Blueprint: `render.yaml`.

1. Open [Render Blueprints](https://dashboard.render.com/blueprints) and sign in.
2. **New Blueprint Instance** → connect the `joytrella9-ui/ApexDialer` GitHub repo.
3. Apply `render.yaml`. This creates a **Docker web service** plus a **1 GB disk** at `/data`.
4. Use a **Starter** (or higher) plan. A free web service has no persistent disk, so SQLite and accounts vanish on restart.
5. After the first deploy, set `APEX_PUBLIC_BASE_URL` to the service URL (`https://<name>.onrender.com`) if it is not already filled from `RENDER_EXTERNAL_URL`.
6. Optional: generate a 64-character hex key and set `APEX_SECRETS_KEY` so encrypted Twilio tokens survive even if the key file is missing:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
7. Open the Render URL, use **Create account**, password 12+ characters. The first user is admin.
8. Confirm `GET /api/health` returns `{ "ok": true }`.

Do not connect this repo to Vercel. Render’s HTTPS origin, `$PORT`, and the disk at `/data` are what make signup and SQLite work.

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
