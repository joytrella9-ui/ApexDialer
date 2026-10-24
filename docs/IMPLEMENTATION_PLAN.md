# Implementation plan and progress

## Completed this session (2026-10-24, later)

- Workspace Twilio settings UI (admin). Credentials encrypted in SQLite; token never returned.
- Live click-to-call: when enabled, Dial rings the operator callback number via Twilio, then connects the lead. Status webhooks + TwiML are signature-verified.
- Live cannot be turned on until SID, auth token, from-number, callback number, and public HTTPS origin are saved.
- Tests: 444 pass.

## Completed this session (2026-10-24)

- Baseline: `npm test` 437 pass / 0 fail.
- Restricted `GET /api/leads/export`, `GET /api/audit`, `GET /api/reports/calls.csv` to supervisor+.
- Overview uses `GET /api/reports/overview` (unavailable metrics labeled).
- Reports page, audit trail UI, admin Team UI, CSV import preview, lead pagination.
- Honest 403 toasts; role-hidden buttons for import/export/campaign control.
- Supervisor call CSV export lists all operators’ calls.
- Tests: 440 pass / 0 fail.
- Audit docs in this folder.

## Next (needs credentials, legal, or a product decision)

1. **Live calling** — only after Twilio account, numbers, SHAKEN/STIR / 10DLC as required, public HTTPS origin, webhook secret, approved disclosure audio, and an explicit code change to allow `liveEnabled`.
2. **GPT-Live / realtime AI** — server-side key, `APEX_VOICE_LIVE_BACKEND_MODEL`, connector verified against the live API. Currently a documented blocker in readiness.
3. **Hosted deployment** — bind address, `APEX_COOKIE_SECURE=true`, HTTPS, backup schedule. See `docs/DEPLOYMENT.md`.
4. **Billing** — not started; do not enable charges without a decision.
5. **Email password reset / MFA** — only if this becomes a networked multi-user product.

## Acceptance still open

- E2E in this environment was not re-run after the UI change (`npm run test:e2e` needs Chromium). CI runs it.
- No load test; do not claim concurrent-agent capacity.
- Legal compliance is not certified by software.
