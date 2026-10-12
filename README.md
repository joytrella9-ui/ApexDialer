# ApexDialer

Call-center dialer workspace. Long-term goal: a professional, installable Windows
desktop application with real browser-based calling, reliable local data storage,
secure configuration, and clear setup/run instructions.

> **Current status: demo mode only.** The backend foundation exists. Telephony is
> **not** connected yet — no real calls are placed, no phone numbers are purchased,
> and no provider charges are incurred. Do not change `demo_mode` to `false` unless a
> supervised, approved live test is underway.

## What is preserved

`ApexDialer_Working_MVP.html` is the unchanged original interface (design, branding,
dashboard, lead management, CSV import/export, dialer layout, activity log, notes,
dispositions). It is served read-only by the backend and will be upgraded incrementally —
never rebuilt from scratch. A verified backup exists at
`ApexDialer_Working_MVP_2026-10-11.html.bak`.

## Requirements

- Windows 10/11 (development verified on Windows)
- Node.js 20+ (tested on Node 24). Install from https://nodejs.org/
- Git (optional, for version control)

## Setup (Windows)

```powershell
cd "C:\Users\jajab\OneDrive\Desktop\ApexDialer"
npm install
```

Optional — create local configuration from the template:

```powershell
copy .env.example .env
```

Defaults are fine for demo mode. `.env` is never committed.

## Run

```powershell
npm start
```

Then open <http://localhost:3210> in Chrome/Edge/Firefox. The original ApexDialer UI
loads from the backend. The API is:

| Method | Route                    | Purpose                                        |
| ------ | ------------------------ | ---------------------------------------------- |
| GET    | `/`                      | Serves the preserved ApexDialer frontend HTML  |
| GET    | `/api/health`            | Liveness check                                 |
| GET    | `/api/health/config`     | Demo mode, telephony status, database status   |

More endpoints (leads, CSV, compliance, auth) arrive in later milestones.

## Tests

```powershell
npm test
```

Covers the database schema/migrations/seed, the API, and server-side validation.

## Data & security

- SQLite database is stored at `data/apexdialer.db` (created on first run). It is
  git-ignored, as are `node_modules/` and `.env`.
- No provider credentials exist in this codebase. When telephony is integrated,
  credentials will live only in server-side configuration (`.env`), never in the browser.
- Demo mode is the hard default (`APEX_DEMO_MODE=true`); live calling is disabled.

## Backing up data

The database is a single file, `data/apexdialer.db`. Copy it while the app is stopped.

## Project layout

```
src/
  server.js          entry point
  app.js             Express app factory
  config.js          environment configuration (no secrets)
  db/db.js           SQLite connection + migration runner
  db/migrate.js      applies ordered migrations
  db/migrations/     numbered SQL migrations
  db/seed.js         default settings (demo mode)
  lib/errors.js      HTTP error + async handler
  routes/            API routers
  validate/          zod schemas for server-side validation
test/                automated tests (node:test)
```

See `docs/architecture.md` for the desktop-packaging strategy and roadmap.

## Roadmap

1. Backend foundation (this milestone) — done, tested.
2. Leads API (server-side CRUD/search/filter).
3. CSV import/export with call type, consent, timezone, suppression.
4. Compliance engine (consent, internal DNC, 8am–9pm recipient-local calling hours).
5. Single-operator authentication (role-ready).
6. Twilio integration in test mode, then live calling — only with explicit approval.
7. Desktop packaging (Electron evaluation in `docs/architecture.md`).

Nothing above is claimed to be production-ready, legally compliant, or capable of real
calls until implemented and verified.