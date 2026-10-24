# Architecture (audit summary)

The long-form design history lives in `docs/architecture.md`. This file is the current runtime picture.

```
Browser (ApexDialer_App.html)
        HTTPS or loopback HTTP
Express (src/app.js)
  public: /, /api/health, /api/auth/{config,setup,login,logout}, signed webhooks
  session: requireAuth + authorize (role policy)
  routers: leads, calls, campaigns, compliance, reports, audit, voice, settings, users
SQLite (data/apexdialer.db)
  migrations 001–010
Providers (src/providers/*)
  fake* = in-process simulation
  twilio* = adapters; not live; liveEnabled forced false
```

## Data

Core tables: `users`, `sessions`, `leads`, `dnc_entries`, `calls`, `call_events`, `audit_log`, `campaigns`, `campaign_leads`, `opt_outs`, `provider_events`, `voice_sessions`, compliance profiles, transcripts.

## Invariants (code-enforced)

- `mergeConfig` forces `telephony.liveEnabled = false`, `voice.liveEnabled = false`, `recordingEnabled = false`.
- Compliance profile gate can be relaxed **only** in demo + fake provider + live off.
- One active power-dialer attempt per operator (partial unique index).
- One live voice session per lead.
- Webhooks are signature-verified, never cookie-authenticated.
- Provider secrets never appear in settings or health payloads.

## Why SQLite and a single HTML file stay

This is a local/desktop-oriented workspace, not a multi-region SaaS. Replacing Express/SQLite or splitting the UI into a SPA would not fix the actual launch blocker (no live carrier path and no legal/audio assets).
