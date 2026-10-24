# ApexDialer project audit

**Date:** 2026-10-24  
**Baseline:** `npm test` — 437 passing before this session; 440 passing after the UI/permission fixes.  
**Product identity:** ApexDialer, local call-center workspace (Node 18+, Express, SQLite).

## Stack (verified)

| Layer | What is actually used |
| --- | --- |
| Frontend | Single-file `ApexDialer_App.html` (served at `GET /`). Original `ApexDialer_Working_MVP.html` is preserved and not served. |
| Backend | Express 5 ESM (`src/app.js`, `src/server.js`) |
| Database | SQLite via `better-sqlite3`, versioned SQL in `src/db/migrations/` |
| Validation | Zod |
| Auth | bcryptjs passwords, HttpOnly `SameSite=Strict` session cookie, server-side session table |
| Roles | `admin`, `supervisor`, `operator` (`src/middleware/policy.js`) |
| Telephony | Sandbox/adapters only. `liveEnabled` is **hardcoded false**. Fake in-process provider for simulation. |
| Tests | Node test runner (`npm test`), Playwright e2e (`npm run test:e2e`), GitHub Actions CI |

## What was broken or disconnected (this session)

These were real product gaps, not missing “looks”:

1. **Overview metrics** counted only the leads already loaded in the browser. They now come from `GET /api/reports/overview`.
2. **Activity log** was session-only even though `audit_log` and `GET /api/audit` existed. Supervisors/admins now load the durable trail.
3. **Reports, team admin, and CSV preview APIs were unused** by the UI. They are wired.
4. **Operators could bulk-export leads and read the full audit log** (no GET rule). Export, audit, and calls CSV are supervisor+.
5. **403 toasts always said “cross-origin guard”**, including real permission denials.
6. **Import saved immediately** with no preview even though `POST /api/leads/import/preview` existed.
7. **Lead table loaded unbounded** lists. The table now pages (`limit`/`offset`).

## What is intentionally not “fixed” as live calling

Live outbound calling, recording, GPT-Live, Twilio Media Streams in production, billing, email, MFA, and password reset over email are **not** enabled. The app fails closed: demo mode on, `liveEnabled` false, no production AI connector, no mandatory disclosure audio. See `docs/PRODUCTION_READINESS.md`.

## Architecture notes

See `docs/architecture.md` (existing long-form) and `docs/ARCHITECTURE.md` (this audit’s summary).
