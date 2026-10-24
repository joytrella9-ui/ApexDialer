# Environment variables

Copy `.env.example` to `.env`. Never commit `.env`. Placeholders only are documented here; see the example file for the full commented list.

| Name | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3210` | HTTP port |
| `APEX_DEMO_MODE` | `true` | Demo mode; keep on until a supervised live test |
| `APEX_DB_PATH` | `data/apexdialer.db` | SQLite file |
| `APEX_PUBLIC_BASE_URL` | unset | Public **https origin** for webhook signature verification |
| `APEX_COOKIE_SECURE` | `false` | Set `true` only behind HTTPS |
| `APEX_PUBLIC_SIGNUP` | `true` | Guest self-signup; first user is admin |
| `APEX_TWILIO_ENABLED` | `false` | Mounts signed Twilio **status** webhook only; does not place calls |
| `APEX_TWILIO_WEBHOOK_SECRET` | empty | Twilio auth token for signature check |
| `APEX_VOICE_ENABLED` | `false` | Simulated voice sessions |
| `APEX_CAMPAIGN_RUNNER` | `false` | Background campaign ticks; keep off unless you want simulated auto-advance |
| `APEX_REQUIRE_COMPLIANCE_PROFILE` | `true` | Forced on except demo+fake+live off |

Live provider credential **names** (values never in git): `APEX_TWILIO_ACCOUNT_SID`, `APEX_TWILIO_AUTH_TOKEN`, `APEX_TWILIO_FROM_NUMBER`. Filling them does **not** enable live calling.
