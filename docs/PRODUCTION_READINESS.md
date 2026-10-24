# Production readiness

## Verdict

**Ready for local demo immediately.**  
**Ready for real click-to-call after you add Twilio credentials in Settings** (and expose a public HTTPS URL). AI-voice/live recording remain off.

`readyForLive` is always false in this build (`src/services/readiness.js`).

## Evidence

- `npm test`: 440 passed (2026-10-24, this workspace).
- CI: `.github/workflows/ci.yml` (Node 20/22 unit tests, Playwright e2e, `npm audit --omit=dev --audit-level=high`).
- Demo path: SQLite, auth, leads, campaigns, simulated dialer, reports.

## Launch blockers for live calling

From the readiness report (configuration evidence, not a live call):

- `live_calling` — `liveEnabled` hardcoded false
- `live_call_path` — no production route creates outbound calls
- `ai_connector` — no production GPT-Live connector
- `mandatory_audio` — no approved disclosure recording
- `provider_lookup` — no provider SID reconciliation
- `public_base_url` / media stream — required for real webhooks
- Legal review per market — not established by software

## Required of you (cannot be done in code alone)

1. Decide whether ApexDialer stays a **local workspace** or becomes a **hosted** product.
2. If hosted: domain, TLS, backups, bind address, `APEX_COOKIE_SECURE=true`.
3. If live voice: Twilio (or other) account, numbers, compliance registration, webhook secret, public HTTPS URL, approved scripts/audio.
4. Do **not** set `APEX_DEMO_MODE=false` except during a supervised test.
5. Billing: no provider is integrated; do not collect cards in-app.

## Safe local run

```powershell
cd C:\Users\jajab\OneDrive\Desktop\ApexDialer
npm install
copy .env.example .env
npm start
```

Open http://127.0.0.1:3210 — first run creates the admin operator.
