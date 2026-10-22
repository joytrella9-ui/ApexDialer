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
- **Telephony:** not connected to a real carrier. A **sandbox webhook path** is
  implemented (`src/providers/twilio.js` + `src/routes/telephony.js`) that verifies
  Twilio-style signature callbacks, maps status onto the call state, and journals each
  event in `provider_events` — all with `live_enabled` hardcoded `false`. Real calling
  still requires the Twilio Voice SDK (`@twilio/voice-sdk`), a server-minted short-lived
  Access Token, a number, and compliance registration, behind an explicit server-side
  approval.

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
**activity log** is session-only (there is no audit-read endpoint yet). The original
auto-seeded sample leads were removed — leads come only from the server.

## Power dialer (implemented — simulated attempts)

The Dialer page hosts a click-driven power-dialer session over the existing `calls` and
`call_events` tables. The server owns the state:

- **Preview, not dial.** `GET /api/calls/next` returns the next eligible lead whose
  compliance decision is `allowed`; the UI merely previews it. An attempt is created only
  by an explicit `POST /api/calls/attempt` (Dial/Start next). Nothing dials on load.
- **One active attempt per operator**, enforced by a DB partial unique index
  (`idx_calls_one_active`); a second attempt is `409 attempt_in_progress`.
- **Compliance is re-evaluated on the server** at attempt time, so a lead that became
  ineligible after preview is refused (`409 not_eligible` with the full decision).
- **Disposition-gated advancement.** `POST /api/calls/:id/end` requires a disposition
  (`400 disposition_required`); "Add to DNC" writes `dnc_entries` and suppresses the lead.
  Pause/Resume are validated transitions (`409 invalid_transition` otherwise). Skip
  advances and excludes the lead for the session; Next advances without excluding; Stop is
  `POST /api/calls/:id/abort` (no disposition).
- **Reload-safe.** `GET /api/calls/active` restores an in-progress attempt (auto-abandoning
  attempts older than `APEX_MAX_ATTEMPT_MINUTES`).

Every transition is appended to `call_events` and recorded in `audit_log`. This remains
**simulated**: `calls` rows capture intent/outcome only — no carrier, no audio, no
`provider_call_sid`. Live calling stays disabled until telephony is integrated and approved.

## Settings & config (implemented — from the full bug audit)

The Settings page and configuration surface were repaired so what the UI shows matches
how the server actually behaves:

- **Queue reset is server-side and safe.** `POST /api/leads/reset-queue` runs one audited
  transaction on `src/services/leads.js`: completed leads go back to `pending` with
  `disposition` cleared, and any contact whose phone is on `dnc_entries` or is flagged
  `suppression_blocked` is forced to `blocked`. The previous frontend loop fetched
  `?eligible=true` (already-pending leads only) so it was a no-op that still claimed success.
- **One config source of truth.** `GET /api/settings` (`src/routes/settings.js`) returns the
  *effective* `cfg` the running process uses — demo mode, telephony, calling window,
  session TTL, stale-attempt limit — marked `readOnly: true, source: 'server'`. The UI
  renders it (but can never edit it), and the misleading "this browser's data" copy is gone.
- **`/api/health/config` reads live config**, not the seeded `settings` table, so status
  reporting always matches the process (a bug when env vars differed from the seed).
- **Leads filter values match the API today** (lowercase statuses, plus `blocked`), the
  search placeholder no longer over-claims ID search, the DNC stat includes suppressed
  rows, and password changes are length-checked client-side as well as server-side.
- **IDOR closed:** `GET /api/calls/:id` returns 404 unless the attempt belongs to the
  authenticated operator (every other attempt route was already user-scoped).
- **Double-submit guards** wrap save/edit, reset queue, password change, and all
  power-dialer controls via the `guard(key, fn)` in-flight helper.

## Telephony sandbox (implemented — signed status callbacks, no real calls)

The provider integration boundary is in place as an opt-in sandbox
(`APEX_TWILIO_ENABLED`, default `false`). `POST /api/telephony/webhooks/twilio` is not
cookie-authenticated; it verifies the `X-Twilio-Signature` header as an HMAC-SHA1 of the
full request URL plus the alphabetically sorted POST parameters (`src/providers/twilio.js`,
`signatureBase` + `verifyTwilioSignature` with `timingSafeEqual`). Results:

- **State mapping:** `initiated`/`ringing`/`in-progress`/`queued` → `in_progress`;
  `completed`/`busy`/`no-answer`/`failed`/`canceled` → `completed`. Terminal events set
  `ended_at`/`duration_seconds`; an unmapped status is journaled without a state change;
  a terminal call is never reopened by a later in-progress callback.
- **Idempotent & durable:** every verified callback writes a `provider_events` row
  (migration `004`, `UNIQUE(provider, event_id)`), so provider retries are no-ops. Each
  applied callback appends a `provider_status` `call_event` and an `audit_log` row with
  actor `provider`.
- **Fail-closed:** bad/absent signature → `401 invalid_signature`; enabled without a
  secret → `403 provider_disabled`; disabled → `404 not_found`. The webhook secret is
  never returned by `GET /api/settings` or `GET /api/health/config`.

This is verified only against the sandbox's own algorithm/payload shape — **not** a live
Twilio account. Real calling remains out of scope and `live_enabled` stays `false`.

## Campaigns, IVR & simulated AI (implemented — simulated outbound, off by default)

A provider-agnostic outbound engine was added so the full campaign → dial → IVR/AI outcome
workflow can be built and tested end-to-end with **no carrier and no live AI model**:

- **Data model** (migration `005`+`006`, additive): `campaigns`, `campaign_leads`
  (`UNIQUE(campaign_id, lead_id)`), `campaign_events`, `ivr_responses`, `ai_transcripts`,
  `opt_outs`.
- **Engine** (`src/services/campaigns.js`): create/list/update, `start`/`pause`/`resume`/
  `stop`, `emergencyStopAll`, `queueLeads`, and `claimNext`. `claimNext` is the single dial
  gate: it enforces concurrency and pacing, the lead's **calling window/timezone**, the
  compliance decision (only `allowed` leads are dialed; blocked ones are terminalized), the
  `maxAttempts`/retry backoff, and a cross-campaign `dialing` guard so a lead is never in two
  concurrent calls. Campaigns auto-complete when no enrolled lead is active.
- **IVR** (`src/services/ivr.js`): a configurable menu (`1` interested, `2` callback, `3`
  representative, `9` opt out) with invalid/timeout handling and bounded retries; every
  keypress is persisted.
- **Simulated AI** (`src/services/ai.js`): a deterministic, offline keyword intent
  classifier (`interested`/`callback`/`representative`/`opt_out`/`unknown`); it contacts no
  external model, downloads no weights, and processes no audio. Both sides of each turn are
  persisted. A real integration swaps only `classifyIntent` for a provider call.
- **Persistent opt-out** (`src/services/optouts.js`): a stop request is stored normalized,
  mirrored into `dnc_entries`, and forces matching leads to `dnc`/suppressed — and it is
  honored by the compliance engine (`opted_out`) across all campaigns and future imports.
- **Surfaces:** `src/routes/campaigns.js` (auth-gated REST) and a Campaigns page in
  `ApexDialer_App.html`.

**Nothing dials on its own.** The runner is disabled unless `APEX_CAMPAIGN_RUNNER=true`, and
even then a "dial" is simulated (no `provider_call_sid`, no audio). This preserves the
existing "never dial automatically" guarantee. The AI-dialer specification was supplied
partially truncated; streaming audio, live STT/TTS, and provider-specific call control are
**not** implemented and remain future work.

## Real-time voice dialer — Phase 0 (implemented — simulated, offline, off by default)

Phase 0 establishes the provider boundary and the conversation/session lifecycle for the
real-time AI voice dialer **without any live telephony, audio, or external model**. It is
gated by `APEX_VOICE_ENABLED` (default `false`); `voice.liveEnabled` is hardcoded `false`,
and the provider registry ships only the in-process `fake` adapter, so there is no code path
to a carrier.

- **Data model** (migration `007`, additive): `voice_sessions` (lifecycle + agent counters)
  and `voice_events` (per-session timeline). A partial unique index
  (`idx_voice_sessions_active_lead`) guarantees at most one live session per lead; a unique
  index on `provider_call_sid` maps a provider call to exactly one session.
- **Provider boundary** (`src/providers/voice.js` + `fakeVoice.js`): a small registry
  (`createVoiceProvider`, only `fake`) behind a four-method contract
  (`startOutboundCall`/`endCall`/`getCall`/`normalizeEvent`). A real adapter (e.g. Twilio
  Media Streams + an STT/LLM/TTS stack) would implement the same contract and be selected by
  configuration; `liveEnabled` blocks selection until explicitly (and separately) enabled.
  `verifyVoiceSignature` uses HMAC-SHA256 (base64, `timingSafeEqual`) over the URL plus sorted
  params.
- **Typed capability contracts** (`src/providers/contracts.js` + `voiceStack.js`): the dialer
  targets five swappable capabilities — **telephony**, **audio** (bidirectional streaming),
  **stt**, **tts**, and **conversation** — each declared as a method contract
  (`CAPABILITY_METHODS`, `assertCapability`/`assertVoiceStack`). `createVoiceStack` builds the
  stack from a registry holding only offline `fake` adapters
  (`fakeVoice`/`fakeAudio`/`fakeStt`/`fakeTts`/`fakeConversation`), none of which touch the
  network. Inbound provider events are validated by `normalizeProviderEvent` (zod, with length
  caps); the provider boundary treats call/session status as **forward-only** so a delayed ring
  cannot downgrade an answered call. Config is validated fail-closed by
  `validateVoiceProviderConfig`, which separates **recognized**, **implemented**,
  **credentialsPresent**, and **ready/liveEnabled** — a recognized-but-unregistered provider is
  `not_implemented`, so it is never reported ready even with full credentials (credential
  **names** only, never values). `describeVoiceStack` yields a secret-free summary for
  health/settings. `liveEnabled` is forced `false` in `mergeConfig` (which destructures nested
  sections so they are merged exactly once), so scripts, env, and overrides cannot enable live
  calls.
- **Twilio telephony adapter - offline increment** (`src/providers/twilioVoice.js`): implements
  the `telephony` contract for Twilio but performs **no provider operation itself** — every
  network action is delegated to an injected `transport`, and with the default (no transport)
  it throws `live_voice_disabled`. It is deliberately **not registered** in `VOICE_STACKS`, so
  readiness reporting stays honest. `normalizeTwilioVoiceEvent` maps Twilio `CallStatus` values
  into the internal voice status domain and reuses `verifyTwilioSignature`. Going live requires
  a real transport (REST + Media Streams), an approved `liveEnabled` path, an E.164 number and
  public HTTPS webhook, and jurisdiction/consent decisions for the confirmed market.
- **Agent** (`src/services/voiceAgent.js`): a **pure, deterministic** state machine
  (`greeting → awaiting → collecting_callback → transferring → ended`). It plays a scripted
  automated-call disclosure + purpose (templated from config only), then routes speech via the
  shared offline intent classifier, DTMF via the shared IVR menu, and handles silence /
  invalid input / turn limits with bounded retries. It synthesizes no audio and contacts no
  model; a real integration replaces it with streaming STT/LLM/TTS behind the same contract.
- **Sessions** (`src/services/voiceSessions.js`): `startVoiceSession` (only for a `dialing`
  campaign lead; creates a NULL-operator `calls` row; provider start failure → `502` + feed
  `failed` back to the campaign), `handleTurn`, `handleProviderEvent` (idempotent via
  `provider_events`, mirrors status onto the call, never reopens an ended session),
  `finalizeSession`, and `endActiveVoiceSessions` (wired into campaign emergency-stop).
  Outcome → campaign disposition reuses the same `applyCampaignOutcome` path, so opt-outs,
  retries, and completion behave exactly like manual outcomes.
- **Surfaces:** `src/routes/voice.js` — an auth-gated session API mounted after
  `requireAuth`, and a public, signature-verified webhook
  (`POST /api/voice/webhooks/fake`) mounted before it.

**Verified only against this repo's own signature algorithm and state machine — not against
any live provider.** Real streaming media, a live voice-AI stack, recording, per-jurisdiction
disclosure handling, and a supervised live test remain future work and require explicit
approval. `live_enabled` stays `false`.

## Reliability & data protection (implemented)

- **Security headers** (`src/middleware/security.js`) are set on every response:
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, a restrictive CSP, `Referrer-Policy:
  no-referrer`, COOP/CORP, and a `Permissions-Policy`. All `/api` responses are
  `Cache-Control: no-store`.
- **Auth hardening:** password changes are rate limited (same failure cap as login), and
  expired sessions are purged when a new session is created.
- **Health probe:** `GET /api/health` runs a real `SELECT 1` and returns `503` with
  `database: "error"` if the database is unreachable; `/api/health/config` probes too.
- **Backup/recovery:** `scripts/backup.js` (`npm run backup`) uses SQLite's online backup
  API with a read-only source connection to produce a WAL-safe, live copy without locking
  operators or modifying the original; `test/backup.test.js` reopens a backup and asserts
  data + migrations survive.
- **Graceful shutdown:** `src/server.js` handles `SIGINT`/`SIGTERM`, drains the HTTP
  server, closes the database, and force-exits after a 10s timeout.

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
  integration, the power-dialer workflow, and the test-mode telephony path are done.
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
## Implementation status matrix (verified in this pass)

Each capability is classified by the strongest evidence that exists. "Mock/local"
means the behaviour is tested against injected fakes or a loopback server only.

| Capability | Status | Evidence |
| --- | --- | --- |
| Operator setup, login, sessions, CSRF/origin guard, rate limits | Implemented and tested | `test/auth.test.js`, `test/api.test.js`, E2E |
| Lead CRUD, CSV import/export, DNC and suppression | Implemented and tested | `test/leads.test.js`, `test/csv.test.js` |
| Campaign engine (simulated dial, outcomes, emergency stop) | Implemented and tested (simulation) | `test/campaigns.test.js` |
| Campaign and voice-session compliance gate (profile + consent + window + DNC) | Implemented and tested | `test/dialerEligibility.test.js`, `test/voiceOrchestrator.test.js` |
| Power dialer `/api/calls/attempt` | Simulated; uses the legacy evaluator (`evaluateLead`), **not** the profile/consent gate. It has no provider and cannot place a call. It must adopt the profile gate before any live provider is wired. | `test/calls.test.js` |
| Role enforcement on retention (admin execute; admin/supervisor preview) | Implemented and tested | `test/phase2Hardening.test.js` |
| Transcript retention (dry run, confirmed execution, backup-first CLI) | Implemented and tested on temporary databases. Not run against the real database. | `test/transcriptRetention.test.js` |
| Webhook signature verification using `APEX_PUBLIC_BASE_URL` | Implemented and tested (HMAC-SHA1 per documented algorithm; signature inputs are fixtures) | `test/providerIntegration.test.js` |
| Replay / duplicate webhook handling | Implemented and tested (`provider_events` unique index, idempotent acceptance). Twilio callbacks carry no timestamp, so replay defence is idempotency, not freshness. | `test/telephony.test.js`, `test/voice.test.js` |
| Twilio REST create/end transport | Mock/local only (injected fetch). Not registered. No account test. | `test/providerIntegration.test.js` |
| Twilio TwiML `<Connect><Stream>` route `POST /api/voice/webhooks/twiml/:sessionId` | Implemented and tested with signed requests. Requires a live, matching session and the Twilio call SID; issues a single-use token passed as a `<Parameter>`, never in the URL. Nothing creates the Twilio call that would fetch it. | `test/mediaStream.test.js`, `test/phase2Hardening.test.js` |
| Twilio Media Streams WebSocket endpoint (`src/providers/mediaStreamServer.js`) | Implemented; mock/local protocol tests only. Mounted only when voice is enabled and `APEX_PUBLIC_BASE_URL` is set. Accepts only streams that present a single-use token (`src/services/mediaStreamTokens.js`); enforces message order, binary/size/rate/idle/connection limits, and backpressure. Not connected to any live call path. | `test/mediaStream.test.js` |
| GPT-Live WebSocket bridge (session.start, telephony G.711, tools, close) | Mock/local protocol only (loopback `ws` server). Not registered; no account test. | `test/providerIntegration.test.js` |
| Legacy Realtime adapter (`openaiRealtime.js`) | Superseded. Its audio format name is not a documented GPT-Live format. Do not use for live work. | `test/openaiRealtime.test.js` |
| Exact approved-script delivery for mandatory lines | **Not guaranteed** with GPT-Live (the voice model generates its own speech). Requires a deterministic TTS or recorded-audio path plus legal review. | - |
| Readiness diagnostics (`GET /api/settings/readiness`) | Implemented and tested. Reports blockers truthfully; `readyForLive` is always false in this build. | `test/phase2Hardening.test.js` |
| Live call lifecycle end to end (create, webhook, stream, tools, transfer, terminal reconciliation) | **Not joined.** Parts exist and are tested: claim-first placement with exactly-once creation and ambiguity handling (`src/services/outboundPlacement.js`), the signed status callback (`/api/voice/webhooks/twilio/status`), the signed TwiML route, the token-bound media endpoint, the disclosure gate, and the orchestrator. No production route creates the Twilio call, and no route joins the media endpoint to an `OutboundCall`. Live join stays blocked. | `test/callLifecycle.test.js`, `test/voiceOrchestrator.test.js`, `test/mediaStream.test.js` |
| Recording | Disabled and hard-coded off. | `test/compliance.test.js` |
| Real provider (Twilio/OpenAI) account test | **BLOCKED**: needs authorized credentials, a funded account, a public HTTPS/WSS endpoint, and an explicit supervised-test authorization. | - |
| Legal / regulatory compliance | **Not established by code.** Requires qualified counsel review of consent, calling-time, caller-ID, AI-voice, and recording rules for the intended markets. | - |

Duplicate call prevention rests on three layers: the one-active-attempt partial unique
index for the power dialer, the one-active-voice-session index per lead, and the
`campaign_leads` claim transition. Ambiguous outbound-call creation (timeout or 5xx
after the request was sent) is flagged `ambiguous` by the Twilio transport and must
be reconciled by an operator; the code never retries call creation automatically.
## Current-build lifecycle, disclosure, and eligibility (session 5)

**Claim-first outbound placement** (src/services/outboundPlacement.js). Placement runs in
two phases. The synchronous phase needs no network. The asynchronous phase claims the
session with one atomic UPDATE (writes the sentinel PENDING:<id> into
provider_call_sid; the partial unique index also protects it), revalidates eligibility
with ssessOutboundCall, then makes exactly one provider create call.

- A second placement for the same session is refused with 409 attempt_already_claimed
  and never reaches the provider.
- A definitive rejection (no call was created) releases the claim, fails the session,
  and lets the campaign's retry policy apply.
- An ambiguous outcome (timeout, connection loss, 5xx, or a malformed create response)
  leaves the sentinel in place, fails the session with disconnect_reason =
  ambiguous_create, records the campaign outcome mbiguous (which is not requeued), and
  returns 502 provider_create_ambiguous with econcile: true. An operator must check the
  provider console before any further action. No code retries it.
- Consent revoked after session creation is caught by the re-check before the claim.

**Known race (fail-closed, documented).** A status callback that arrives before the Call
SID is recorded finds no matching session and is ignored. It is not replayed, so an
operator may need to reconcile that session by hand. A provider-side lookup would close
this gap, but it is not implemented.

**Webhook idempotency and freshness.** The status callback is signed over the public URL
(/api/voice/webhooks/twilio/status). Duplicate deliveries are absorbed by the
provider_events unique index. Terminal sessions are never reopened. Freshness is
**not** verified: Twilio's callback carries no signed timestamp, so a replayed, valid
callback can only land as a duplicate or as a no-op. It cannot create a new transition.

**Media stream binding** (src/providers/mediaStreamServer.js). A stream is accepted
only if (1) its single-use token resolves to a session, (2) no other live stream is bound
to that session, and (3) alidateStart confirms the session is inging or
in_progress and that its recorded provider SID equals the stream's Call SID. With no
validator configured, every stream is refused. The binding is released on every close
path. **Not yet done:** nothing hands the accepted socket to an OutboundCall, so audio
does not reach the AI session.

**Mandatory disclosure gate** (src/services/mandatoryAudio.js, src/services/voiceOrchestrator.js).
On answer, the orchestrator streams the approved disclosure frames, then sends a Media
Streams mark. The AI session opens only after the carrier echoes that mark. Until then,
caller turns, audio, and model tools are refused with disclosure_not_played. A missing
asset, a missing socket, or a missing echo (after markTimeoutMs) ends the call. Production
ships **no** approved asset, so every call fails closed at this step. The only asset in the
repository is a clearly labelled **synthetic silence fixture** in 	est-support/. It
contains no wording and is not a recording of any statement. Counsel must approve the
wording, language, timing, and the recording itself.

**Eligibility on every consequential action.** Each non-terminal AI action (speech,
routing) re-runs ssessOutboundCall. Consent revoked or suppression applied mid-call
rejects the action with eligibility_revoked. Terminal actions (opt_out, end_call)
stay permitted so the call can always end. The calling-window block is excluded so a
call started inside the window can finish a clean hangup.

**Tool and destination limits.** Tools come only from the server allowlist. Transfers use
only APEX_VOICE_TRANSFER_NUMBER, never a model-supplied number. Caller ID comes only from
APEX_VOICE_FROM_NUMBER.

**Not verified against a provider.** Every behaviour above is covered by mock transports,
fake sockets, or loopback clients. No test contacts Twilio or OpenAI, and the test guard
rejects any non-loopback network request. The Twilio REST call shapes come from the
Calls resource reference, and the status callback mapping comes from the Twilio status
values. Account-level behaviour (compliance registration, number provisioning, callback
delivery, signature behaviour under a real proxy) is unverified.