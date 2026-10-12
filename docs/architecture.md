# ApexDialer — Architecture & Desktop Packaging Strategy

## Current architecture

- **Frontend:** **`ApexDialer_App.html`** is the served, integrated single-file
  interface (login/setup screen, server-backed leads, CSV, and compliance display). The
  preserved **`ApexDialer_Working_MVP.html`** original remains byte-for-byte in the repo
  (hash-guarded by `test/frontend.test.js`) but is no longer served. The UI, branding,
  and layout stay intact; only the data layer was swapped from `localStorage` to the
  authenticated API.
- **Backend:** Node.js + Express, SQLite via `better-sqlite3`, versioned SQL
  migrations, `zod` validation. The backend is a plain HTTP server today; this keeps it
  testable without a GUI and lets the UI stay browser-standard.
- **Telephony:** not connected. The plan is the Twilio Voice SDK (`@twilio/voice-sdk`),
  with a server-minted short-lived Access Token and signature-verified webhooks. Live
  calling stays behind an explicit server-side toggle (`live_enabled`), default `false`.

## Frontend integration (implemented)

`ApexDialer_App.html` opens on a login card (or first-run operator setup), then the
workspace loads from the API. Session is the `HttpOnly` + `SameSite=Strict` cookie; the
frontend never touches `localStorage` and holds no secrets. Any `401` returns the user to
the login screen with a session-expired message. Leads CRUD/search/filter, CSV
import/export, and compliance checks all round-trip through the server. The Dialer page
shows the server compliance decision and **starts a call only when the decision is
`allowed`** (`review`/`blocked` open the decision panel and never dial); the demo dialer
remains a local simulation and nothing dials automatically.

Known UI features without full backend support yet (shown as such, not faked): the
**activity log** is session-only (there is no audit-read endpoint yet), and the dialer
has no telephony provider. The original auto-seeded sample leads were removed — leads
come only from the server.

## Desktop packaging: Electron evaluation

Requirement: an installable Windows application, distributed to other users later,
while **retaining the exact same architecture** so no rewrite is needed.

**Recommendation: Electron is a good fit, with one structural rule.** Electron wraps the
existing Node/Express backend as the Electron *main* process and loads the existing
frontend in a `BrowserWindow` pointed at `http://127.0.0.1:<port>`. WebRTC audio for
calling works natively in Chromium.

Why it fits here:

- The backend is plain Node — Electron can host it as-is (same `createApp`/`createDb`
  modules). No frontend rewrite.
- `electron-builder` produces a Windows NSIS installer with a Start-menu/desktop
  shortcut and works with Express + `better-sqlite3`.
- The browser frontend keeps working for local http testing and for a future hosted
  multi-agent deployment — desktop and web share one codebase.

Why it is **not being packaged yet** (decision):

- Packaging Electron before the API surface is stable means rebuilding installers for
  every milestone. Packaging is cheapest once leads, CSV, compliance, auth, frontend
  integration, and the test-mode telephony path are done.
- `better-sqlite3` is a native module and must be rebuilt for Electron's Node ABI. This
  is a solved problem (`electron-rebuild` / electron-builder's `npmRebuild`) but it is
  exactly the class of issue to defer until packaging actually starts.

When packaging begins, the work is: add Electron as a dev dependency, add a thin main
process (start server, open window, handle app lifecycle), configure `electron-builder`
with NSIS settings, rebuild native modules for Electron's ABI, and document install +
upgrade + data-backup steps.

## Data & secrets

- SQLite at `data/apexdialer.db` (git-ignored). For a packaged desktop app the DB path
  will move under the per-user app data directory.
- Provider credentials: server-side `.env` / Electron `app.getPath('userData')` config
  only — never in browser code. Tokens handed to the browser are short-lived.

## Authentication (implemented — single operator)

Single-operator auth landed as `src/routes/auth.js` + `src/services/auth.js` with a
`sessions` table (migration 002). Passwords use bcrypt (`bcryptjs`, cost 10 default);
sessions are random tokens whose SHA-256 hash is stored, expire after a configurable TTL
(default 12h), and are revoked on logout/password change. Every `/api` route except a
small documented public set (health, auth config/setup/login/logout) requires a valid
`HttpOnly` + `SameSite=Strict` cookie. Login is rate limited in memory, wrong
username/password return identical errors, and a same-origin check rejects state-changing
requests with a foreign `Origin`/`Referer`. The server binds to `127.0.0.1`. Operator
password recovery is intentionally offline: `npm run reset-operator`.

**Multi-agent is still design-time only.** The schema already carries `users.role`,
`calls.user_id`, `calls.call_type`, and `calls.direction`. Adding agents means per-user
tokens, presence, and queue routing; inbound means TwiML `<Dial>` to a registered device.
These are additive — no schema or UI rewrite.

## Compliance gate (implemented — preliminary guardrail)

The compliance engine milestone landed as a server-side evaluation
(`src/services/compliance.js`, endpoint `GET /api/leads/:id/compliance`). It evaluates
consent, internal DNC, and the 8am–9pm recipient-local calling window using each lead's
IANA timezone and Node's `Intl`/ICU data (DST transitions computed per instant). It
returns one decision — `allowed`, `review`, or `blocked` — with machine-readable reason
codes and details. It fails closed: a missing/invalid timezone or missing/insufficient
consent for a sales call is a hard block, and unknown call types are blocked.

**This is a preliminary guardrail, not a legal compliance certification.** It does not
consult national/state/number-area DNC registries, and consent records are
self-asserted (reported as `proofLevel: "self-asserted"`), so a `recorded` consent is a
*claimed*, not verified, basis. It deliberately exposes this limitation in every
evaluation response (`disclaimer`). US outbound calling additionally requires
provider-side registration (e.g., a Twilio Primary Compliance Profile and SHAKEN/STIR
registration) that is the user's account responsibility and outside this codebase's
control. Live calling remains disabled until a supervised, approved live test.