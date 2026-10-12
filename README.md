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

Then open <http://127.0.0.1:3210> in Chrome/Edge/Firefox (the server binds to
`127.0.0.1` by default). The app opens a sign-in screen (or first-run operator setup).
After signing in, the ApexDialer workspace loads from the backend.

### Frontend source of truth

- The app now serves **`ApexDialer_App.html`** — the integrated frontend connected to the
  authenticated API (sign-in, server-stored leads, CSV, and compliance display).
- The original **`ApexDialer_Working_MVP.html`** is preserved **byte-for-byte** in this
  repository (SHA-256 `FB922BC05D876A7593F868B9693D97AC48B802B6255063FE6051700DA8CDEBF9`)
  and is no longer served. Its SQL/backup `.bak` is unchanged.
- `test/frontend.test.js` guards both facts.

### API endpoints

Public (no login needed): `GET /` (frontend HTML), `GET /api/health`,
`GET /api/health/config`, `GET /api/auth/config`, `POST /api/auth/setup` (only when no
operator exists), `POST /api/auth/login`, `POST /api/auth/logout`. Everything else under
`/api` requires a valid session cookie.

| Method | Route                 | Purpose                                             |
| ------ | --------------------- | --------------------------------------------------- |
| GET    | `/`                   | Serves the preserved ApexDialer frontend HTML (public) |
| GET    | `/api/health`         | Liveness check (public)                             |
| GET    | `/api/health/config`  | Demo mode, telephony status, database status (public) |
| GET    | `/api/auth/config`    | Setup status + session policy (public)              |
| POST   | `/api/auth/setup`     | First-run operator creation (public, refused once an operator exists) |
| POST   | `/api/auth/login`     | Log in and receive a session cookie (public, rate limited) |
| POST   | `/api/auth/logout`    | End the current session (works with or without a session) |
| GET    | `/api/auth/me`        | Current operator + session expiry                   |
| PUT    | `/api/auth/password`  | Change the operator password (requires current password) |
| GET    | `/api/leads`          | List leads. Query: `q`, `status`, `callType`, `eligible` |
| GET    | `/api/leads/export`   | Download leads as CSV (same query filters as the list) |
| POST   | `/api/leads/import`   | Import leads from CSV (`text/csv` body or JSON `{ "csv": "..." }`) |
| GET    | `/api/leads/:id`      | Get one lead                                        |
| GET    | `/api/leads/:id/compliance` | Evaluate whether a lead may be dialed (optional `?at=<ISO>`) |
| POST   | `/api/leads`          | Create a lead (validated)                           |
| PUT    | `/api/leads/:id`      | Update a lead (validated)                           |
| DELETE | `/api/leads/:id`      | Delete a lead (204)                                 |
| GET    | `/api/calls`          | List recent call attempts (`?limit=`)               |
| GET    | `/api/calls/active`   | The operator's current attempt (or `null`); auto-abandons stale attempts |
| GET    | `/api/calls/next`     | Next eligible + `allowed` lead to preview (`?exclude=1,2`) |
| POST   | `/api/calls/attempt`  | Start an attempt for a lead (server re-checks compliance) |
| POST   | `/api/calls/skip`     | Record a skip and return the next lead              |
| GET    | `/api/calls/:id`      | One attempt with its event history                  |
| POST   | `/api/calls/:id/pause`  | `in_progress` → `paused`                          |
| POST   | `/api/calls/:id/resume` | `paused` → `in_progress`                          |
| POST   | `/api/calls/:id/end`    | End with a disposition (required) and update the lead |
| POST   | `/api/calls/:id/abort`  | Abandon the attempt without a disposition         |

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

### Authentication & security (single operator)

The app is a single-operator local application. The backend enforces authentication on
every `/api` route except the small documented public set (health, auth config/setup/
login/logout). Passwords are hashed with **bcrypt** (`bcryptjs`, cost factor 10 by
default); login comparisons are **server-side** and fail **closed**. No password,
plaintext or hashed, is ever returned to the client; sessions store **only a SHA-256
hash** of the random session token (not the token itself).

**First-run setup** — start the app, then create the operator account:

```powershell
$setup = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3210/api/auth/setup `
  -ContentType 'application/json' `
  -Body '{"username":"operator","password":"a long random passphrase","displayName":"Demo Operator"}'
$login = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3210/api/auth/login `
  -ContentType 'application/json' `
  -Body '{"username":"operator","password":"a long random passphrase"}'
```

- `POST /api/auth/setup` returns `409 operator_exists` once an account exists — there is
  exactly one operator and no way to add more through the API.
- Login sets an **`HttpOnly` + `SameSite=Strict`** session cookie named
  `apexdialer_session`. Sessions last **12 hours** (`APEX_SESSION_TTL_HOURS`), are
  stored server-side, and are invalidated on logout or password change. `Secure` is only
  set when `APEX_COOKIE_SECURE=true` (i.e. when served over HTTPS).
- Wrong username and wrong password return the **same** `401 invalid_credentials`
  response (no user enumeration); bcrypt verification is run against a dummy hash when
  the username does not exist to avoid a timing side channel.
- Login is **rate limited** in memory: 5 failed attempts per username/IP per window and
  20 attempts per IP per window (see `.env.example`), returning `429 too_many_attempts`
  with `Retry-After`. Setup is limited to 10 attempts/hour.
- **CSRF protection:** state-changing requests with an `Origin`/`Referer` that does not
  match the server host are rejected with `403 cross_origin_forbidden`; the cross-site
  cookie flood is already blocked by `SameSite=Strict`.
- The server binds to **`127.0.0.1`** so only this machine can reach the API.

Auth-related events (setup, login, failed login, logout, password change) are written to
the `audit_log` table.

**Changing your password** (while logged in):

```powershell
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:3210/api/auth/password `
  -ContentType 'application/json' -WebSession $session `
  -Body '{"currentPassword":"old passphrase","newPassword":"new strong passphrase"}'
```

**If you forget the password** — there is intentionally no password-recovery API (that
would be an insecure shortcut). Use the local helper on the machine that owns the
database; it prompts for a new password, hashes it, and invalidates all sessions:

```powershell
npm run reset-operator
```

This is local-only and does not bypass the running app's auth: anyone who can run it
already has file-system access to the database. Changing a password also logs out other
sessions automatically.

**Notes / limitations:** rate-limit state is in-memory (resets on restart); sessions are
not IP-bound (appropriate for a localhost desktop app); the login screen is a later
frontend milestone — the login screen was added by the frontend-integration milestone.

### Frontend integration (connected workspace)

`ApexDialer_App.html` keeps the original visual design, navigation, and pages while
replacing browser storage with the authenticated API:

- **Sign in & first-run setup.** A login card (or operator-creation card when no
  operator exists yet) is shown before the workspace. The session cookie is
  `HttpOnly` + `SameSite=Strict`; the frontend never writes passwords, tokens, or lead
  data to `localStorage`/`sessionStorage` — the server is the only copy.
- **Session handling.** On load the app calls `/api/auth/config` and `/api/auth/me`.
  Any `401` from the API switches back to the login screen ("Your session expired").
  Logout and password change use `/api/auth/logout` and `/api/auth/password`.
- **Leads.** Add, edit, delete, search, and status filters hit `/api/leads`; consent,
  call type, and IANA timezone are editable so round-trips are lossless. DNC/suppressed
  leads reflect the server's answer.
- **CSV.** Import posts the file to `/api/leads/import` (server validation, DNC
  enforcement, dedupe) and surfaces the row-level report; export downloads
  `/api/leads/export`.
- **Compliance gate.** The Dialer page shows the server's compliance decision for the
  next/current contact (`allowed` / `review` / `blocked`) with reason codes and the
  disclaimer. Starting any call (including the local demo dialer and manual numbers)
  is **gated on `allowed`**; `review` and `blocked` open the decision panel and never
  start. No real or simulated provider call is ever initiated automatically.
- **Dispositions.** Ending a demo call saves `status`/`disposition`/`notes` to the lead
  via the API ("Add to DNC" sets the lead status to `dnc`).

**Existing UI features without full backend support (shown honestly, not faked):**

- The **Activity log** is session-only: it lists actions performed in the current
  session and is explicitly labeled "not stored server-side" (cleared on reload). The
  schema has an `audit_log` table but no read endpoint for it yet.
- The **dialer** runs a server-backed **power-dialer session** (see below) but still
  simulates calls: no telephony provider is connected and no calls (real or simulated)
  start automatically.
- The original auto-seeded sample-lead list is gone: leads come only from the server
  (add, or CSV-import, your own). There is no provider-secret material anywhere in the
  HTML.

### Power dialer (simulated attempts, server-persisted)

The Dialer page adds an explicit, click-driven **power-dialer session** for demo mode.
Nothing is auto-dialed: starting a session only *previews* the next contact, and a call
attempt begins only when the operator presses **Dial** (or the legacy "Start next"). The
workflow is Start → Dial → (Pause/Resume) → disposition **Save & next**, with Skip, Next,
and Stop.

- **Server-owned state.** Attempts are stored in the existing `calls` table and every
  transition is appended to `call_events`; start/end/pause/resume/abort/skip are written
  to `audit_log`. Opening the workspace restores any in-progress attempt
  (`GET /api/calls/active`) so a reload does not lose it.
- **One live attempt at a time.** Enforced in the database by a partial unique index
  (`idx_calls_one_active` on `calls(user_id)` where status is `in_progress`/`paused`); a
  second attempt is refused with `409 attempt_in_progress`.
- **Compliance is re-checked on the server** every time an attempt starts. A lead that
  was previewed but has since become ineligible (completed, DNC, consent revoked, outside
  the window) is refused with `409 not_eligible` and the full decision, even if the UI
  thought it was dialable.
- **Dispositions are required.** Ending an attempt without one returns
  `400 disposition_required`. Ending records `status`, `disposition`, `notes`, and
  `duration_seconds`; **"Add to DNC"** inserts the phone into `dnc_entries` and forces the
  lead to `dnc`/suppressed.
- **Stale attempts** older than `APEX_MAX_ATTEMPT_MINUTES` (default 240) are abandoned
  automatically on the next check.
- **Failed/unknown transitions** return `409 invalid_transition`; unknown attempts return
  `404 call_not_found`.

This is a **simulated** workflow: `calls` rows record intent and outcome, no carrier call
is placed, and there is no dialer tone, recording, or provider ID (`provider_call_sid`
stays empty).

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

### Compliance engine (preliminary guardrail)

`GET /api/leads/:id/compliance` runs a **server-side** evaluation of whether a lead may
proceed to dialing. Exactly one answer comes back:

```json
{
  "data": {
    "decision": "allowed",
    "allowed": true,
    "mayDial": true,
    "leadId": 1,
    "callType": "sales",
    "leadStatus": "pending",
    "phoneKey": "5550101001",
    "reasons": [
      { "code": "within_calling_window", "severity": "info", "message": "..." }
    ],
    "details": {
      "evaluatedAt": "2026-06-15T13:00:00.000Z",
      "dnc": { "matched": false },
      "suppression": { "flagged": false },
      "consent": { "required": true, "status": "recorded", "proofLevel": "self-asserted", "evidence": true, "source": true, "date": true },
      "schedule": {
        "timeZone": "America/New_York",
        "valid": true,
        "localTime": "2026-06-15 09:00",
        "localWeekday": "Mon",
        "localHour": 9,
        "localMinute": 0,
        "utcOffsetMinutes": -240,
        "window": { "start": "08:00", "end": "21:00", "startMinutes": 480, "endMinutes": 1260, "open": true }
      }
    },
    "disclaimer": "Preliminary internal guardrail only. It is NOT a legal compliance certification. ..."
  }
}
```

- `decision` is `allowed`, `review`, or `blocked`; `mayDial` (alias `allowed`) is `true`
  only for `allowed`. `blocked` — hard stop. `review` — no auto-dial; a human must
  confirm first. The most severe reason wins (`block` > `review` > `info`).
- `?at=<ISO timestamp>` evaluates at a specific instant (used by tests and "what if"
  checks); without it the current server time is used.
- Every call returns `reasons` with machine-readable `code` + `severity` + explanation.

Checks performed, in order: internal DNC, suppression flag, lead status, call type,
consent, timezone, and the calling window.

| Code                          | Meaning                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `internal_dnc`                | (block) phone matches the internal DNC list                        |
| `suppression_flagged`         | (block) lead flagged as suppressed                                 |
| `lead_status_completed` / `dnc` / `blocked` | (block) lead not dialable                       |
| `unknown_call_type`           | (block) call type not recognized — fail closed                     |
| `missing_consent`             | (block) sales call without recorded consent                        |
| `consent_revoked`             | (block) contact revoked consent                                    |
| `insufficient_consent_evidence` | (block) recorded consent with no evidence on file                |
| `consent_metadata_incomplete` | (review) evidence exists but source/date missing; verify by human  |
| `missing_timezone` / `invalid_timezone` | (block) cannot verify recipient-local hours            |
| `outside_calling_window`      | (block) outside the configured recipient-local window              |
| `invalid_calling_window_config` | (block) window settings malformed                                |
| `within_calling_window`       | (info) inside the window                                           |
| `consent_not_required`        | (info) existing-customer call needs no marketing consent           |

Configuration — the preliminary calling window, recipient-local:

```env
# .env  (defaults shown)
APEX_CALL_WINDOW_START=08:00
APEX_CALL_WINDOW_END=21:00
```

Timezone handling uses each lead's IANA timezone (e.g. `America/New_York`) and Node's
`Intl`/ICU data, so US and international DST transitions are computed per instant.

**This is a preliminary guardrail — not a legal compliance certification.** It does not
check national/state/number-area DNC registries, consent wireline/cell distinctions,
state-specific rules, or business-day/holiday rules. Consent is **self-asserted**: the
engine treats a `recorded` consent as *claimed*, reports `proofLevel: "self-asserted"`,
and does not treat it as independent proof of legal permission. A lead can be
`allowed` here and still be unlawful to call; a human operator and the operator's
professional/legal review remain the decision-makers.

More endpoints (auth) arrive in later milestones.

### CSV import & export

`GET /api/leads/export` streams a CSV attachment with a stable column order:

```
Lead ID, Name, Phone, Company, Call Type, Timezone,
Consent Status, Consent Source, Consent Date, Consent Evidence,
Status, Disposition, Notes, Suppressed, Created At, Updated At
```

- Export applies the same `q`, `status`, `callType`, `eligible` filters as `GET /api/leads`.
- Cells that begin with `=`, `+`, `-`, `@`, tab, or CR are prefixed with `'` to prevent
  spreadsheet formula injection. The `Phone` column is exempt (already validated).
- `POST /api/leads/import` accepts a UTF-8 CSV body (`Content-Type: text/csv`, up to 2 MB),
  or JSON `{ "csv": "<csv text>" }`. Headers are matched case-insensitively; `Name` and
  `Phone` are required, all other columns are optional. `Call Type` accepts
  `sales` / `existing-customer` (spaces and underscores are normalized).

Import rules (returned in the summary as `total`, `imported`, `rejected`, `skipped`,
plus row-level `errors` and `warnings`):

- Each row is validated server-side. Invalid or missing `name`/`phone` rows are
  **rejected** with the offending line number and reason.
- Phones already in the database, or duplicated within the file, are **skipped**.
- Internal DNC suppression is always applied: any row whose phone is on the internal
  Do Not Call list is imported as `blocked`, never eligible.
- Imported consent claims are **not trusted as verified**. A row claiming
  `Consent Status = recorded` with no source, date, or evidence is downgraded to `none`
  and reported as a warning.
- Valid rows are written in a single all-or-nothing transaction: if a write fails, the
  whole batch is rolled back and nothing is saved.
- Files are limited to 5000 rows per import.


## Tests

```powershell
npm test
```

Covers the database schema/migrations/seed, the API, leads CRUD, input validation,
Do Not Call suppression, CSV import/export (round-trip, quoting, row-level errors,
formula-injection escaping, limits, and transaction rollback), the compliance engine
(allowed/blocked/review decisions, DNC, consent, call types, timezones, calling window,
DST transitions, and HTTP endpoint validation), authentication (setup, login/logout,
wrong-credential behavior, session cookies, expiry, garbage/expired tokens, unauthorized
API access, password change, rate limiting, and CSRF/origin checks), the power-dialer
workflow (attempt lifecycle, one-active-attempt enforcement, server-side compliance
re-checks, dispositions, skip/next, pause/resume, stale-attempt abandonment, and
disposition-gated advancement), and the frontend
integration (original HTML hash guards, integrated frontend contract, session-expiry
handling, CSRF same-origin behavior, and the UI-equivalent auth/lead/CSV/compliance
flows). Run this after every change.

## Data & security

- SQLite database is stored at `data/apexdialer.db` (created on first run). It is
  git-ignored, as are `node_modules/` and `.env`.
- Operator passwords are bcrypt-hashed; session tokens are random and only their
  SHA-256 hash is stored. There are no hardcoded passwords, session secrets, or other
  credentials in this codebase. No provider credentials exist; when telephony is
  integrated, credentials will live only in server-side configuration (`.env`), never in
  the browser.
- The API binds to `127.0.0.1` and every sensitive route requires a valid session.
- Demo mode is the hard default (`APEX_DEMO_MODE=true`); live calling is disabled.

## Backing up data

The database is a single file, `data/apexdialer.db`. Copy it while the app is stopped.

## Project layout

```
ApexDialer_App.html    integrated frontend (served by the app; source of truth for the UI)
ApexDialer_Working_MVP.html   preserved original UI (unmodified, no longer served)
src/
  server.js          entry point (binds to 127.0.0.1)
  app.js             Express app factory (public routes then auth gate)
  config.js          environment configuration (no secrets)
  db/db.js           SQLite connection + migration runner
  db/migrate.js      applies ordered migrations
  db/migrations/     numbered SQL migrations (001 schema, 002 sessions)
  db/seed.js         default settings (demo mode)
  lib/errors.js      HTTP error, zod error mapping, async handler
  lib/sessions.js    session tokens (random, hashed at rest) + expiry
  lib/rateLimit.js   in-memory sliding-window rate limiter
  middleware/        cookie parsing, origin guard, auth guards
  routes/            API routers (health, auth, leads, calls)
  services/          business logic + SQL (leads, csv, compliance, auth, calls)
  validate/          zod schemas for server-side validation
scripts/             local operator-password reset helper
test/                automated tests (node:test)
test-support/        shared test helpers (auto-authenticate requests)
```

See `docs/architecture.md` for the desktop-packaging strategy and roadmap.

## Roadmap

1. Backend foundation — done, tested.
2. Leads API (server-side CRUD/search/filter + internal DNC enforcement) — done, tested.
3. CSV import/export with call type, consent, timezone, suppression — done, tested.
4. Compliance engine (consent, internal DNC, 8am–9pm recipient-local calling hours) — done, tested (preliminary guardrail, not certification).
5. Single-operator authentication (bcrypt, sessions, rate limiting, CSRF guards) — done, tested.
6. Frontend integration (sign-in screen, server-backed leads, CSV and compliance display; original UI preserved) — done, tested.
7. Power dialer workflow (click-driven session, server-persisted attempts, re-checked compliance, disposition-gated advancement; simulated, no telephony) — done, tested.
8. Twilio integration in test mode, then live calling — only with explicit approval.
9. Desktop packaging (Electron evaluation in `docs/architecture.md`).

Nothing above is claimed to be production-ready, legally compliant, or capable of real
calls until implemented and verified.