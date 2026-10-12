# ApexDialer — Architecture & Desktop Packaging Strategy

## Current architecture

- **Frontend:** the preserved `ApexDialer_Working_MVP.html` single-file interface.
  It reads and writes browser `localStorage` today. Over Phase 1 it will be upgraded
  incrementally so its data operations call the backend API instead, while the UI,
  branding, and layout stay intact.
- **Backend:** Node.js + Express, SQLite via `better-sqlite3`, versioned SQL
  migrations, `zod` validation. The backend is a plain HTTP server today; this keeps it
  testable without a GUI and lets the UI stay browser-strandard.
- **Telephony:** not connected. The plan is the Twilio Voice SDK (`@twilio/voice-sdk`),
  with a server-minted short-lived Access Token and signature-verified webhooks. Live
  calling stays behind an explicit server-side toggle (`live_enabled`), default `false`.

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
  every milestone. Packaging is cheapest once leads, CSV, compliance, auth, and the
  test-mode telephony path are done.
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

## Multi-agent & inbound (design-time only, not built)

The schema already carries `users.role`, `calls.user_id`, `calls.call_type`, and
`calls.direction`. Adding agents means minting per-user tokens and adding presence and
queue routing; inbound means TwiML `<Dial>` to a registered device. These are additive —
no schema or UI rewrite.

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