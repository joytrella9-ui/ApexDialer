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
| GET    | `/`                   | Serves the integrated ApexDialer frontend HTML (public) |
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
| POST   | `/api/leads/reset-queue` | Return completed leads to `pending` (atomic); DNC/suppressed stay `blocked` |
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
| GET    | `/api/calls/:id`      | One attempt with its event history (scoped to the operator who made it) |
| POST   | `/api/calls/:id/pause`  | `in_progress` → `paused`                          |
| POST   | `/api/calls/:id/resume` | `paused` → `in_progress`                          |
| POST   | `/api/calls/:id/end`    | End with a disposition (required) and update the lead |
| POST   | `/api/calls/:id/abort`  | Abandon the attempt without a disposition         |
| GET    | `/api/settings`       | Effective server configuration, read-only (`readOnly: true`) |
| GET    | `/api/compliance/campaigns/:id` | A campaign's declared compliance profile (`null` if unset)   |
| PUT    | `/api/compliance/campaigns/:id` | Create/update the campaign compliance profile (required by the gate) |
| GET    | `/api/compliance/campaigns/:id/eligibility` | Preview the fail-closed decision (`?leadId=`, optional `?at=<ISO>`) with no dial |
| POST   | `/api/compliance/consent` | Record a consent grant/revoke scoped to `(phone, channel, purpose)` |
| GET    | `/api/compliance/consent` | List consent records for a number (`?phone=`)                |
| POST   | `/api/compliance/consent/revoke` | Revoke a consent record (blocks the next call immediately) |
| GET    | `/api/campaigns`      | List campaigns with per-status counts               |
| POST   | `/api/campaigns`      | Create a campaign (name, window, attempts, concurrency, IVR/AI) |
| POST   | `/api/campaigns/emergency-stop` | Stop every `running`/`paused` campaign |
| GET    | `/api/campaigns/:id`  | One campaign with stats and enrolled leads          |
| PUT    | `/api/campaigns/:id`  | Update a campaign (not while `running`)             |
| POST   | `/api/campaigns/:id/start`  | `draft`/`paused`/`stopped` → `running`        |
| POST   | `/api/campaigns/:id/pause`  | `running` → `paused`                          |
| POST   | `/api/campaigns/:id/resume` | `paused` → `running`                          |
| POST   | `/api/campaigns/:id/stop`   | Stop a campaign                               |
| POST   | `/api/campaigns/:id/queue`  | Enroll leads (default: only eligible ones)          |
| POST   | `/api/campaigns/:id/tick`   | Claim the next eligible lead for a simulated dial   |
| POST   | `/api/campaigns/:id/outcome`| Record a call outcome (drives retry/final status)   |
| POST   | `/api/campaigns/:id/ivr`    | Simulate an IVR keypress (1/2/3/9) and route it     |
| POST   | `/api/campaigns/:id/ai`     | Simulate an AI conversation turn (offline classifier) |
| GET    | `/api/campaigns/:id/leads/:leadId` | One enrolled lead's campaign status          |
| POST   | `/api/telephony/webhooks/twilio` | Provider status callback (public; signature-verified; only mounted when the telephony sandbox is enabled) |
| POST   | `/api/voice/sessions` | Start a simulated voice session for a `dialing` campaign lead (off unless `APEX_VOICE_ENABLED=true`) |
| GET    | `/api/voice/sessions/:id` | One voice session with its event timeline                 |
| POST   | `/api/voice/sessions/:id/turn` | Apply a caller/agent turn (`speech`/`dtmf`/`silence`/`interrupt`/`stream_disconnected`/`provider_error`) |
| POST   | `/api/voice/sessions/:id/tools` | Execute one validated AI tool call on an answered session (allowlist, budget, duplicate guard, duration cap) |
| POST   | `/api/voice/sessions/:id/end` | Operator-ends a live voice session                         |
| POST   | `/api/voice/webhooks/fake` | Signed provider callback for the fake voice provider (public; signature-verified; only mounted when the voice sandbox is enabled) |

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
  with `Retry-After`. Setup is limited to 10 attempts/hour. **Password changes are rate
  limited too** (same failure cap) so the current password cannot be guessed in a loop.
- Expired sessions are purged from the `sessions` table the next time a session is
  created, so the table does not grow without bound.
- **Security headers** are sent on every response (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, a restrictive `Content-Security-Policy`, `Referrer-Policy:
  no-referrer`, COOP/CORP, and a `Permissions-Policy` that disables camera/mic/geo), and
  every `/api` response is `Cache-Control: no-store` so session/lead data is never cached.
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
  session (cleared on reload). The server records the same actions in `audit_log`, but
  there is no read endpoint to browse the full audit trail yet.
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

### Telephony sandbox (provider webhooks, off by default)

A provider-webhook path exists so the call state machine and status timeline can be
exercised end-to-end **without ever placing a real call**. It is disabled unless you
opt in:

```env
# .env  (defaults preserve demo mode)
APEX_TWILIO_ENABLED=false
APEX_TWILIO_PROVIDER=twilio
APEX_TWILIO_WEBHOOK_SECRET=      # Twilio Auth Token; required when enabled
```

- `POST /api/telephony/webhooks/twilio` accepts `application/x-www-form-urlencoded`
  status callbacks. It is **not** cookie-authenticated; instead every request must carry
  an `X-Twilio-Signature` header that matches an HMAC-SHA1 of the request URL plus the
  sorted parameters (the standard Twilio validation algorithm). A bad/absent signature is
  rejected with `401 invalid_signature`; if the sandbox is enabled without a secret the
  route returns `403 provider_disabled`; while disabled it returns `404 not_found`.
- Status values map onto the internal state: `initiated`/`ringing`/`in-progress`/
  `queued` → `in_progress`; `completed`/`busy`/`no-answer`/`failed`/`canceled` →
  `completed` (terminal, sets `ended_at`/`duration_seconds`). An unmapped status is
  journaled without changing the call, and a terminal call is never reopened by a later
  in-progress callback.
- Every verified callback is written to the new `provider_events` table (unique on
  `provider + event_id`), so a retried callback is a harmless no-op (`duplicate`), and the
  call timeline gets a `provider_status` `call_event` plus an `audit_log` row (actor
  `provider`).
- The provider secrets are **server-side only**: neither `GET /api/settings` nor
  `GET /api/health/config` exposes the webhook secret.

**Not yet real calling.** This sandbox has been verified only against its own signature
algorithm and payload shape, not against a live Twilio account. A real integration still
requires a Twilio account, a purchased number, a Primary Compliance Profile / SHAKEN-STIR
registration, and a supervised live test; `live_enabled` remains hardcoded `false`.

### Campaigns, IVR & simulated AI (outbound engine, off by default)

A campaign engine, an IVR menu, a persistent opt-out list, and a **simulated, offline AI
conversation** turn loop exist so the full outbound workflow can be built and tested
end-to-end **without a carrier and without a live AI model**. This is deliberately a
provider-agnostic simulation: it places no real calls, downloads no model weights, and
processes no audio.

**Nothing dials on its own.** The background runner is disabled by default and campaigns
only advance when an operator explicitly calls `tick`, or when the runner is turned on with
`APEX_CAMPAIGN_RUNNER=true`. When a dial is claimed it is a simulated attempt only (no
`provider_call_sid`, no audio). The "never dial" guarantees from the power dialer and
telephony sandbox are unchanged.

```env
# .env  (defaults keep everything off)
APEX_CAMPAIGN_RUNNER=false            # background runner, OFF by default
APEX_CAMPAIGN_RUNNER_INTERVAL_MS=15000
APEX_CAMPAIGN_MAX_ATTEMPTS=3
APEX_CAMPAIGN_RETRY_DELAY_MINUTES=60
APEX_CAMPAIGN_CONCURRENCY=1
APEX_CAMPAIGN_PACING_PER_MINUTE=30
APEX_CAMPAIGN_MAX_CONCURRENCY=5
APEX_AI_ENABLED=false                 # simulated AI turn loop; contacts no external model
APEX_AI_MAX_TURNS=8
```

Lifecycle: a campaign is `draft → running ⇄ paused → stopped`, and auto-completes when no
enrolled lead is left active. `POST /api/campaigns/emergency-stop` stops every running or
paused campaign at once. A campaign can be edited only while not `running`.

Eligibility is never bypassed. `tick` claims a lead only when the compliance engine returns
`allowed`; a lead that is suppressed, on the internal DNC list, opted out, completed, or
blocked is never dialed and is terminalized in the campaign. The engine also enforces:

- **Concurrency** (`concurrencyLimit`) and **pacing** (`pacingPerMinute`, dials per minute).
- **Calling window / timezone** using the lead's zone (falling back to the campaign default).
- **Retry backoff** (`retryDelayMinutes`) up to `maxAttempts`, then `failed`.
- **No duplicate concurrent dials:** a lead already `dialing` in *any* campaign is skipped.
- **Persistent opt-out:** a stop request is stored (`opt_outs`), mirrored to the internal
  DNC list, and forces matching leads to `dnc`/suppressed — across every campaign and all
  future imports.

IVR: `POST /api/campaigns/:id/ivr` accepts `1` interested, `2` callback, `3`
representative, `9` opt out. Unknown digits are rejected and timeouts prompt, both with a
bounded number of retries before falling through to `unanswered`. Every keypress is written
to `ivr_responses`.

AI: `POST /api/campaigns/:id/ai` runs a deterministic, local intent classifier (keyword
rules → `interested` / `callback` / `representative` / `opt_out` / `unknown`) and persists
both sides of the exchange to `ai_transcripts`. A real integration would replace only the
`classifyIntent` step with a provider call while keeping the same turn/route contract.

New tables: `campaigns`, `campaign_leads` (unique per `campaign` + `lead`), `campaign_events`,
`ivr_responses`, `ai_transcripts`, `opt_outs`. All are additive and backward-compatible.

**Scope note.** The full original AI-dialer specification was truncated when it was provided
(mid "section B"). This implementation covers the campaign lifecycle, IVR routing, the
persistent opt-out, and a simulated AI turn loop; any later sections (e.g. real-time audio,
live STT/TTS, or provider streaming) are **not** represented and remain future work.

### Real-time voice dialer (Phase 0: simulated media/agent, off by default)

Phase 0 of the real-time AI voice dialer adds a **provider-agnostic adapter**, a
**deterministic conversational state machine**, a **voice-session lifecycle**, and a
**signed provider webhook** — all simulated and offline. **It places no real call, uses no
telephony network, processes no audio, and contacts no external model.** `liveEnabled` is
hardcoded `false` and only the in-process `fake` provider exists, so there is no code path
that can reach a carrier.

```env
# .env  (defaults keep everything off)
APEX_VOICE_ENABLED=false
APEX_VOICE_PROVIDER=fake
# APEX_VOICE_WEBHOOK_SECRET=      # HMAC-SHA256 secret; required when enabled
# APEX_VOICE_BUSINESS_NAME=ApexDialer Demo
# APEX_VOICE_PURPOSE=follow up on your recent inquiry
# APEX_VOICE_TRANSFER_NUMBER=
# APEX_VOICE_MAX_TURNS=8
# APEX_VOICE_MAX_SILENCE_RETRIES=2
# APEX_VOICE_MAX_INVALID=2
```

- **Session lifecycle.** A session is `starting → ringing → in_progress → ended` (or
  `failed`). `POST /api/voice/sessions` starts one for a lead the campaign engine has
  already claimed (`dialing`); the campaign must be `running`. Starting creates a linked
  `calls` row (with a **NULL operator**, so it never collides with the one-active-attempt
  index) and asks the provider to begin the call. A **provider start failure** returns
  `502 provider_start_failed`, marks the session `failed`, and feeds `failed` back into the
  campaign (requeue/backoff).
- **Conversational agent.** The agent is a pure, offline state machine
  (`greeting → awaiting → collecting_callback → ended`). On answer it plays a scripted
  **automated-call disclosure** and the purpose template (templated from config only — it
  invents no facts), then routes caller input: speech is classified with the same local
  intent classifier used by the campaign AI loop (`interested` → completed, `callback` →
  prompt then `callback`, `representative` → transfer/`connected`, `opt_out` → persistent
  opt-out, `unknown` → reprompt); DTMF is resolved with the shared IVR menu
  (`1`/`2`/`3`/`9`); silence, invalid input, and turn count are bounded by
  `maxSilenceRetries`/`maxInvalid`/`maxTurns` and fall through to `unanswered`. Both sides
  of the conversation are written to `ai_transcripts` (never real audio).
- **Outcomes are enforced through the campaign engine.** A session disposition is applied
  with the same `applyCampaignOutcome` path as manual outcomes, so opt-outs persist
  (`opt_outs` + internal DNC + lead forced to `dnc`), retries/backoff apply, and the
  campaign auto-completes when no lead remains. An abrupt stream disconnect maps to
  `unanswered` and requeues the lead.
- **Duplicate-call protection.** A partial unique index
  (`idx_voice_sessions_active_lead`) plus a service check ensure a lead has at most **one
  live session** across every campaign; a second attempt returns `409 voice_session_active`.
- **Signed webhook.** `POST /api/voice/webhooks/fake` is public but **never cookie-
  authenticated**; it requires an `X-Apex-Voice-Signature` header carrying an HMAC-SHA256
  (base64) of the request URL plus the sorted parameters. Bad/absent signature → `401
  invalid_signature`; enabled without a secret → `403 provider_disabled`; disabled →
  `404 not_found`; unknown session → acknowledged and ignored. Callbacks are **idempotent**
  (deduped via `provider_events` on `provider + event_id`), advance the session, mirror the
  status onto the linked call, and **cannot reopen an ended session**.
- **Emergency stop** (`POST /api/campaigns/emergency-stop`) now also ends every live voice
  session (finalized `unanswered`/`emergency_stop`).
- **Secrets stay server-side.** Neither `GET /api/settings` nor `GET /api/health/config`
  exposes `APEX_VOICE_WEBHOOK_SECRET`.

- **Provider interface layer.** The dialer is built against five small, swappable
  capability contracts (`src/providers/contracts.js`): **telephony** call control, **audio**
  bidirectional streaming, **stt**, **tts**, and **conversation**. `createVoiceStack`
  (`src/providers/voiceStack.js`) assembles them from a registry that today contains only the
  offline `fake` adapters (`fakeVoice`, `fakeAudio`, `fakeStt`, `fakeTts`, `fakeConversation`),
  each of which **makes no network request**. Provider webhook events are validated against a
  typed schema (`normalizeProviderEvent`) so malformed or oversized payloads fail closed, and
  call/session status transitions are **forward-only** (a late ring cannot downgrade an
  answered call). Config is validated fail-closed by `validateVoiceProviderConfig`, which
  reports four **independent** facts — `recognized`, `implemented`, `credentialsPresent`,
  `ready`/`liveEnabled` — so a provider is never called ready just because credentials exist:
  an unknown provider is **not recognized**, and a recognized-but-unregistered provider (e.g.
  `twilio`) is **not implemented**, so `ready` and `liveEnabled` stay `false` even with every
  credential populated. Only credential **names** are ever reported, never values.
  `describeVoiceStack` (exposed by `/api/health/config` and `/api/settings`) returns the
  secret-free summary (`mode` is `simulation` for the fake stack, `not_implemented` for a
  recognized real provider). Live mode is refused outright (`live_voice_disabled`, or
  `voice_provider_not_implemented` for a known-but-unregistered provider), and `liveEnabled`
  is forced `false` after config merging so **no env var, override, or fallback can silently
  enable real calls**. A Twilio telephony adapter (`src/providers/twilioVoice.js`) implements
  the contract against an **injected transport** (no network by default) and is deliberately
  **not registered**, so it cannot be selected until implemented live and approved.

New tables: `voice_sessions`, `voice_events`. All additive and backward-compatible.

**What Phase 0 does *not* do (and cannot be verified here).** There is no real audio path,
no STT/TTS/LLM provider, no media streaming, no recording, and no carrier integration. The
webhook and the agent are verified only against this repository's own signature algorithm
and deterministic state machine — **not** against any live provider. Real-time phases
(streaming media, a live voice-AI stack, consent/recording disclosures per jurisdiction, and
a supervised live test) remain future work and require explicit approval.

### Fail-closed compliance gate & consent ledger (enforced in the real dial path)

Every real outbound path now passes a single fail-closed eligibility gate before a
session row is created. It never infers the recipient's jurisdiction from the phone
number, and it can never enable recording.

- **Campaign compliance profile** (`campaign_compliance`, migration `008`): business
  name, legal identity, consent purpose/basis, AI disclosure, operator-declared
  allowed countries, and a retention window. A missing or incomplete profile blocks
  the call.
- **Scoped consent ledger** (`dialer_consents`): consent is per `(phone, channel,
  purpose)` with evidence/source/timestamp/seller identity. A missing, revoked, or
  incomplete record blocks the call; revocation takes effect immediately.
- The gate reuses the existing `evaluateLead` checks for internal DNC, opt-out,
  suppression, lead status, timezone, and calling hours, then adds the profile and
  consent checks. It is enforced in `campaigns.claimNext`, in
  `voiceSessions.startVoiceSession`, and — unconditionally — in the end-to-end
  orchestrator below. The offline simulator suites opt out via
  `compliance.requireComplianceProfile=false`; the real path does not.
- Configure it through the `/api/compliance/...` routes (see the API table). The
  profile/consent are **operator assertions**, not verified facts and not a legal
  certification; per-market legal review remains required.

### AI tool loop, media-stream & realtime adapter foundation

The pieces a live voice-AI call needs now exist as tested, **transport-injected,
offline** modules. None of them opens a socket or reaches a network by default:

- **`src/providers/aiTools.js`** — the single server-authoritative tool allowlist
  (`approved_response`, `keypad_routing`, `opt_out`, `callback_request`,
  `transfer_request`, `end_call`). Every tool call is re-validated against strict
  schemas; model text can never cause free-form speech (`approved_response` only
  speaks a pre-approved script line). Duplicate-call detection is keyed on the
  provider `call_id`.
- **`src/providers/twilioMediaStream.js`** — validates Twilio bidirectional
  media-stream messages (`connected`/`start`/`media`/`dtmf`/`stop`/`mark`),
  enforces connection ordering, and writes only through an injected socket
  (fails closed with no socket).
- **`src/providers/openaiRealtime.js`** — builds the Realtime `session.update`
  (tools pinned to the allowlist) and translates server events into the internal
  voice vocabulary. It opens no WebSocket; a socket is injected.
- **`src/services/aiToolExecutor.js`** — executes a validated tool call under a
  per-session tool budget, a duration cap, and a suppressed-contact policy, then
  finalizes the session through the campaign outcome path.
- **`src/services/voiceOrchestrator.js`** — the single coordinator that ties
  selection → gate (`assessOutboundCall`, always) → telephony session → provider
  events → media stream → realtime session → tool execution → cleanup, plus
  `emergencyStop`. It is exercised end-to-end in tests with fake sockets and makes
  no network call.

**Still not connected.** These are boundaries, not live integrations: the Twilio
telephony adapter is unregistered, the media/realtime sessions have no real
transport, and there is no audio codec, no credential, and no public HTTPS webhook.
`describeVoiceStack` reports `not_implemented` for a real provider, and live mode
stays refused. A supervised live test would additionally require Twilio credentials
and a number, an OpenAI API key, a public HTTPS endpoint, consent/recording
disclosure review per jurisdiction, and explicit human approval.

**Hardening pass (offline, tested).**

- The profile/consent gate can be relaxed only in demo mode with the fake provider
  (`effectiveRequireComplianceProfile`). Outside that, it is forced on in both
  `loadConfig` and `mergeConfig`, so env vars and overrides cannot bypass it.
- AI tool actions require an answered call (`call_not_answered` otherwise).
- `POST /api/voice/sessions/:id/tools` (authenticated, voice-enabled only) executes a
  model tool call through `executeAiToolCall`. It validates the name and arguments,
  enforces the budget, duplicate guard, suppression policy, and duration cap, and
  writes an `ai_tool` audit row for each successful action.
- The orchestrator fails safe: a realtime `provider_error`, a stream that cannot
  open, or a call over `APEX_VOICE_MAX_CALL_SECONDS` ends the call, and events for an
  ended call are refused with `409 session_ended`.
- Outbound caller ID now comes from `APEX_VOICE_FROM_NUMBER`. Previously it was
  wrongly taken from `APEX_VOICE_TRANSFER_NUMBER`.

External steps still required before any live use are listed under "Still not
connected" above: Twilio credentials and a number, an OpenAI key, a public HTTPS
webhook, a real transport implementation, an approved `liveEnabled` change, and
recording/disclosure review by the operator or counsel.

### Transcript retention (operator procedure)

Transcript text (`ai_transcripts`, and `lead:speech` / `ai:say` rows in `voice_events`)
expires after its campaign's `retention_days` (compliance profile). Rows with no
profile, invalid retention, or an unparseable date are **kept** and reported.
Leads, calls, consents, opt-outs, and the audit log are never touched.

1. Dry run (read-only, changes nothing; the default):
   `npm run retention -- --db "<path to apexdialer.db>"`
   or `GET /api/compliance/retention` while signed in.
2. Review `totals.expired` and `byCampaign`.
3. Execute, only when you have approved the count:
   `npm run retention -- --db "<path>" --execute --confirm DELETE_EXPIRED_TRANSCRIPTS --expected <count> --backup-to "<new backup path>"`
   The script writes a WAL-safe backup to the new path first, refuses to overwrite
   an existing file, and deletes in one transaction. A changed count aborts the run.
   The API equivalent is `POST /api/compliance/retention/execute` with
   `{"confirm":"DELETE_EXPIRED_TRANSCRIPTS","expectedTotal":<count>}`.

Do not run execute against a live database until you have confirmed the policy
period with counsel. The retention window is a setting, not a legal determination.

### Provider transports (status)

- **Twilio REST** (`src/providers/twilioRest.js`): create/end call against the
  documented Calls resource, Basic auth, timeouts, no automatic retry of call
  creation (flagged `ambiguous`), redacted errors. It is **not registered** and
  refuses to send unless constructed with `liveEnabled: true`. Verified only with
  injected fetch and no real account.
- **GPT-Live WebSocket** (`src/providers/gptLive.js`): session.start with telephony
  G.711 μ-law at 8 kHz, Responses-delegation tools limited to the allowlist, tool
  results returned to the model, graceful `session.close`, start/close timeouts, and
  a `wss://`-only connector. Verified against a loopback `ws` server that implements
  the documented messages. It is **not registered** and has no real-account test.
- **Legacy Realtime adapter** (`src/providers/openaiRealtime.js`): kept for existing
  tests. Its audio format name (`audio/g711_ulaw`) is not one of the GPT-Live formats
  documented (`audio/pcmu`), so do not use it for live work.
- **Webhooks**: `APEX_PUBLIC_BASE_URL` (https origin) is used for signature
  verification. Replays of a valid callback are idempotent through `provider_events`.

### Readiness, roles, and known limits (current build)

- `GET /api/settings/readiness` (signed in) lists each check as ok, info, or blocker,
  with credential **names** only. It always reports `readyForLive: false` in this build.
  A passing check is configuration evidence, not a verified call.
- Role rules: retention preview is `admin` or `supervisor`; retention execution is
  `admin` only. Operators and AI tools cannot run destructive retention.
- The manual power dialer (`POST /api/calls/attempt`) is simulation only. It runs only when demo mode is on, the provider is the in-process fake, and live calling is off. Otherwise it returns `409 manual_dial_requires_campaign_gate` and writes nothing. It keeps the legacy per-lead checks (consent, suppression, status, calling window), because manual dials have no campaign profile. Live dialing runs through a campaign and the profile gate.
- Outbound placement (`src/services/outboundPlacement.js`) claims a session atomically, revalidates eligibility, and makes exactly one provider call. An ambiguous create (timeout, 5xx, malformed response) is never retried. It fails the session and marks the lead `ambiguous` (not requeued) for manual reconciliation.
- Disclosure gate: the AI session starts only after approved mandatory audio plays and the carrier echoes its mark. Production ships no approved audio, so calls fail closed at this step. The repository's only audio is a labelled synthetic test fixture. Counsel must approve the wording and recording.
- Readiness panel: Settings shows demo and live readiness separately, lists each blocker in plain language, and has no control that enables live calling.
- Twilio status callback: `POST /api/voice/webhooks/twilio/status` (signed over `APEX_PUBLIC_BASE_URL`, idempotent). It is not verified for freshness, because Twilio's callback has no signed timestamp.
- `src/providers/twilioTwiml.js` builds a validated `<Connect><Stream>` document
  (wss only, no query string, escaped parameters). No route serves it yet.
- Media Streams: `POST /api/voice/webhooks/twiml/:sessionId` (Twilio-signed, requires a
  live session whose call SID matches) returns `<Connect><Stream>` with a single-use
  token. The WebSocket endpoint at `/api/voice/media` accepts only streams that present
  that token. Both exist only when `APEX_VOICE_ENABLED=true` and `APEX_PUBLIC_BASE_URL`
  is an HTTPS origin. Both are tested with mock and loopback clients only.
- Not yet built: the step that creates the Twilio call and joins the call lifecycle
  (route, provider, stream, and AI session) into one verified path. See
  `docs/architecture.md` for the full status matrix.

### Test commands

- `npm test`: unit, integration, and loopback transport tests (no browser, no network).
- `npm run test:e2e`: real-browser smoke tests using Microsoft Edge on this machine
  through `playwright-core` (channel `msedge`). Uses a temporary database and an
  in-process server bound to 127.0.0.1. Synthetic data only. If Edge is missing the
  suite reports a skip with the reason. Set `APEX_E2E_CHANNEL` to use another channel.



The Settings page now matches reality:

- **"Reset completed leads to Pending"** calls `POST /api/leads/reset-queue`. The server
  returns every `completed` lead to `pending` with its disposition cleared, in one
  audited transaction. Do Not Call (matching the internal `dnc_entries` list) and
  suppressed/blocked contacts are left `blocked` and are never made dialable again. The
  button reports how many were reset and how many were kept suppressed, and is disabled
  while the request is in flight (prevents double-submit cascades).
- **Server configuration card.** `GET /api/settings` exposes the *effective* running
  configuration (demo mode, telephony provider/live status, calling window, session
  TTL, stale-attempt limit) as read-only values from the server. The previous card
  claimed the settings were "this browser's data", and the page showed no real
  configuration at all.
- **`GET /api/health/config` now reflects the live configuration** (env vars), not the
  seeded `settings` table, so it can never disagree with the running process.
- **Leads status filter** uses the lowercase values the API expects (`pending`,
  `completed`, `dnc`, `blocked`), so filtering actually returns rows. The search
  placeholder no longer claims IDs are searchable (they are not).
- **Security hardening:** `GET /api/calls/:id` is scoped to the authenticated operator
  (a foreign operator's call returns `404 call_not_found`). Password changes enforce the
  12–72 character rule client-side too. Key destructive/state-changing actions
  (save/edit lead, reset queue, password change, and every power-dialer control) are
  guarded against double submission.

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
API access, password change, password-change rate limiting, session purge, rate limiting,
CSRF/origin checks, and security headers), the power-dialer workflow (attempt lifecycle,
one-active-attempt enforcement, server-side compliance re-checks, dispositions,
skip/next, pause/resume, stale-attempt abandonment, and disposition-gated advancement),
the telephony sandbox (signature verification, status transitions, dedupe, terminal-call
protection, and secret non-exposure), the campaign engine (lifecycle transitions, eligible-
only queueing, concurrency/pacing, cross-campaign duplicate-dial prevention, retry backoff,
persistent opt-out, IVR routing with invalid/timeout handling, the simulated AI intent
classifier, emergency stop, and audit coverage), the real-time voice dialer Phase 0 (session
lifecycle and provider start failure, signed-webhook auth/idempotency/terminal protection,
speech/DTMF/silence/interrupt/disconnect routing, persistent opt-out, duplicate-session
prevention, emergency stop, and secret non-exposure), backup/recovery, the lead audit trail, and the
frontend integration (original HTML hash guards, integrated frontend contract,
session-expiry handling, CSRF same-origin behavior, and the UI-equivalent
auth/lead/CSV/compliance flows). Run this after every change.

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

The database is a single file, `data/apexdialer.db`. You can copy it while the app is
stopped, or make a **WAL-safe, live** copy at any time with the built-in helper:

```powershell
npm run backup
# writes data/apexdialer.db.backup-<timestamp>
```

`scripts/backup.js` uses SQLite's online backup API with a read-only source connection, so
it never locks out operators and never modifies the original. To restore, stop the app and
copy the backup file over `data/apexdialer.db` (delete the matching `-wal`/`-shm` sidecars
first). `test/backup.test.js` verifies a backup can be reopened with all data and
migrations intact.

## Project layout

```
ApexDialer_App.html    integrated frontend (served by the app; source of truth for the UI)
ApexDialer_Working_MVP.html   preserved original UI (unmodified, no longer served)
src/
  server.js          entry point (binds to 127.0.0.1; graceful shutdown)
  app.js             Express app factory (public routes then auth gate)
  config.js          environment configuration (no secrets)
  db/db.js           SQLite connection + migration runner
  db/migrate.js      applies ordered migrations
  db/migrations/     numbered SQL migrations (001 schema … 007 voice)
  db/seed.js         default settings (demo mode)
  lib/errors.js      HTTP error, zod error mapping, async handler
  lib/sessions.js    session tokens (random, hashed at rest) + expiry + purge
  lib/rateLimit.js   in-memory sliding-window rate limiter
  middleware/        cookie parsing, origin guard, security headers, auth guards
  routes/            API routers (health, auth, leads, calls, campaigns, voice, settings, telephony)
  services/          business logic + SQL (leads, csv, compliance, auth, calls, campaigns, ivr, ai, optouts, voiceAgent, voiceSessions)
  providers/         provider adapters + typed contracts (Twilio signature/status map; fake voice/audio/stt/tts/conversation stack via contracts.js + voiceStack.js; HMAC verifier)
  validate/          zod schemas for server-side validation
scripts/             local operator-password reset helper; database backup
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
8. Telephony sandbox (signed provider webhook endpoint, status/state mapping, dedupe, `provider_events` journal; still no real calling) — done, tested. Real Twilio integration in test mode, then live calling — only with explicit approval.
9. Real-time AI voice dialer — Phase 0 (provider-agnostic adapter, offline conversational state machine, session lifecycle, signed webhook; simulated only) — done, tested. Real streaming media + a live voice-AI stack remain future work and require explicit approval.
10. Desktop packaging (Electron evaluation in `docs/architecture.md`).

Nothing above is claimed to be production-ready, legally compliant, or capable of real
calls until implemented and verified.