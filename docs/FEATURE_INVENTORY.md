# Feature inventory

Status key: **Complete and verified** (code + tests) · **Implemented, needs improvement** · **Partial** · **Missing** · **Blocked by external dependencies** · **Broken or insecure** (none remaining that we left unfixed in this pass)

| Feature | Status | Notes |
| --- | --- | --- |
| Sign-in, logout, first-run setup | Complete and verified | Cookie session, rate limits, generic 401 |
| Password change | Complete and verified | Invalidates other sessions |
| Password reset via email | Missing | Local `npm run reset-operator` only (filesystem access) |
| MFA | Missing | Not appropriate until hosted multi-user SaaS |
| Roles (admin/supervisor/operator) | Complete and verified | Enforced on the server |
| User create / role / disable | Complete and verified | Admin API + Settings → Team UI |
| Lead CRUD, search, filters | Complete and verified | Pagination in UI |
| CSV import with preview | Complete and verified | Preview then confirm; supervisor+ to import |
| CSV export | Complete and verified | Supervisor+ |
| Duplicate phone guard | Complete and verified | 409 on create |
| DNC / suppression / opt-out | Complete and verified | Honored on import and dial gate |
| Compliance window / consent | Complete and verified | Fail-closed; profile required outside simulator |
| Power dialer (simulated) | Complete and verified | Server-owned attempts; no carrier |
| Campaigns, tick, IVR, simulated AI | Complete and verified | Runner off by default |
| Voice sessions (fake provider) | Complete and verified | Off unless `APEX_VOICE_ENABLED` |
| Live telephony | Blocked by external dependencies | Twilio credentials, numbers, legal, code change for `liveEnabled` |
| Dashboard metrics | Complete and verified | `GET /api/reports/overview` |
| Reports + calls CSV | Complete and verified | Answer/abandonment labeled unavailable |
| Server audit UI | Complete and verified | Supervisor+ |
| Settings / readiness | Complete and verified | Read-only config; secrets never returned |
| Health / metrics | Complete and verified | Metrics admin-only |
| Backups / transcript retention | Complete and verified | Scripts + confirmation token |
| Notifications (email/in-app product) | Partial | Toasts + overview alerts from report codes |
| Billing / subscriptions | Missing | Local single-workspace product; do not add Stripe without a decision |
| Follow-up tasks / agent occupancy | Missing | No data source; occupancy labeled unavailable |
| Conference / hold / mute (carrier) | Blocked | No live call path |
| Multi-tenant orgs | Missing | Single SQLite workspace |
