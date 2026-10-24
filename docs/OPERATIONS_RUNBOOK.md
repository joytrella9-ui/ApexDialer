# Operations runbook

## Process

- Start: `npm start`
- Dev reload: `npm dev`
- Health: `GET /api/health` (liveness), `GET /api/health/config` (demo/telephony flags, no secrets)
- Readiness (authenticated): `GET /api/settings/readiness`

## Common issues

| Symptom | Check |
| --- | --- |
| Login 429 | Rate limit; wait for the window or restart (in-memory counters) |
| 403 forbidden | Role policy (operator hitting export/import/campaigns/audit) |
| 403 cross_origin_forbidden | Origin/Referer mismatch |
| Session expired | 12h TTL or password change |
| Cannot dial | Compliance decision not `allowed`; demo still does not call a carrier |
| Forgot password | `npm run reset-operator` on the DB host |

## Backup / retention

```powershell
npm run backup
npm run retention -- --help
```

Transcript deletion requires an explicit confirmation token; dry-run first.

## Emergency

`POST /api/campaigns/emergency-stop` (supervisor+) stops running/paused campaigns and live simulated voice sessions. It cannot hang up a real carrier call because none are placed.
