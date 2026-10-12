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
loads from the backend.

### API endpoints

| Method | Route                 | Purpose                                             |
| ------ | --------------------- | --------------------------------------------------- |
| GET    | `/`                   | Serves the preserved ApexDialer frontend HTML       |
| GET    | `/api/health`         | Liveness check                                      |
| GET    | `/api/health/config`  | Demo mode, telephony status, database status        |
| GET    | `/api/leads`          | List leads. Query: `q`, `status`, `callType`, `eligible` |
| GET    | `/api/leads/:id`      | Get one lead                                        |
| POST   | `/api/leads`          | Create a lead (validated)                           |
| PUT    | `/api/leads/:id`      | Update a lead (validated)                           |
| DELETE | `/api/leads/:id`      | Delete a lead (204)                                 |

A lead response looks like:

```json
{
  "data": {
    "id": 1,
    "name": "Jordan Mitchell",
    "phone": "+1 555 010 1001",
    "company": "Northstar Logistics",
    "callType": "existing-customer",
    "timezone": "America/New_York",
    "consent": { "status": "recorded", "evidence": "signed", "source": "web-form", "date": "2026-09-01" },
    "status": "pending",
    "disposition": "",
    "notes": "",
    "suppressed": false,
    "eligible": true,
    "createdAt": "2026-10-12 03:00:00",
    "updatedAt": "2026-10-12 03:00:00"
  }
}
```

Create/update body fields: `name`, `phone` (7-15 digits), `company`, `callType`
(`sales` | `existing-customer`), `timezone`, `consent` object, `notes`; update also
accepts `status` (`pending` | `completed` | `dnc` | `blocked`) and `disposition`.

### Do Not Call (internal suppression)

Suppression is enforced on the server, not just the UI. If a lead's phone matches an
active entry in the internal `dnc_entries` list (compared by the last 10 digits, so
formatting does not matter), the API forces its status to `blocked`, sets
`suppressed: true`, and reports `eligible: false`. A suppressed lead cannot be made
eligible by updating its status. The `?eligible=true` filter returns only leads that
are `pending` and not suppressed — the safe candidate list for dialing.

**This internal suppression is not, by itself, legal compliance.** Consent rules,
national/state Do Not Call registries, calling-hour windows, and provider
registrations are separate requirements handled in later milestones.

More endpoints (CSV, compliance engine, auth) arrive in later milestones.

## Tests

```powershell
npm test
```

Covers the database schema/migrations/seed, the API, leads CRUD, input validation,
and Do Not Call suppression behavior. Run this after every change.

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
  lib/errors.js      HTTP error, zod error mapping, async handler
  routes/            API routers (health, leads)
  services/          business logic + SQL (leads)
  validate/          zod schemas for server-side validation
test/                automated tests (node:test)
test-support/        shared test helpers (not treated as tests)
```

See `docs/architecture.md` for the desktop-packaging strategy and roadmap.

## Roadmap

1. Backend foundation — done, tested.
2. Leads API (server-side CRUD/search/filter + internal DNC enforcement) — done, tested.
3. CSV import/export with call type, consent, timezone, suppression.
4. Compliance engine (consent, internal DNC, 8am–9pm recipient-local calling hours).
5. Single-operator authentication (role-ready).
6. Twilio integration in test mode, then live calling — only with explicit approval.
7. Desktop packaging (Electron evaluation in `docs/architecture.md`).

Nothing above is claimed to be production-ready, legally compliant, or capable of real
calls until implemented and verified.