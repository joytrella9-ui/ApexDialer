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
| GET    | `/api/leads/export`   | Download leads as CSV (same query filters as the list) |
| POST   | `/api/leads/import`   | Import leads from CSV (`text/csv` body or JSON `{ "csv": "..." }`) |
| GET    | `/api/leads/:id`      | Get one lead                                        |
| GET    | `/api/leads/:id/compliance` | Evaluate whether a lead may be dialed (optional `?at=<ISO>`) |
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
formula-injection escaping, limits, and transaction rollback), and the compliance
engine (allowed/blocked/review decisions, DNC, consent, call types, timezones, calling
window, DST transitions, and HTTP endpoint validation). Run this after every change.

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
  services/          business logic + SQL (leads, csv import/export, compliance)
  validate/          zod schemas for server-side validation
test/                automated tests (node:test)
test-support/        shared test helpers (not treated as tests)
```

See `docs/architecture.md` for the desktop-packaging strategy and roadmap.

## Roadmap

1. Backend foundation — done, tested.
2. Leads API (server-side CRUD/search/filter + internal DNC enforcement) — done, tested.
3. CSV import/export with call type, consent, timezone, suppression — done, tested.
4. Compliance engine (consent, internal DNC, 8am–9pm recipient-local calling hours) — done, tested (preliminary guardrail, not certification).
5. Single-operator authentication (role-ready).
6. Twilio integration in test mode, then live calling — only with explicit approval.
7. Desktop packaging (Electron evaluation in `docs/architecture.md`).

Nothing above is claimed to be production-ready, legally compliant, or capable of real
calls until implemented and verified.