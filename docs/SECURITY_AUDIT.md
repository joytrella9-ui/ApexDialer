# Security audit

## Fixed or already solid (verified by tests)

| Item | Evidence |
| --- | --- |
| Auth required on `/api` except documented public set | `test/auth.test.js`, `test/api.test.js` |
| Password hashing, dummy bcrypt on unknown user | `src/services/auth.js` |
| Session is hashed at rest; cookie HttpOnly + SameSite Strict | auth routes |
| CSRF origin guard on state-changing `/api` | `originGuard` |
| Security headers + `Cache-Control: no-store` on API | health/api tests |
| Role policy fail-closed for unknown roles | `policy.js`, `rolePolicy.test.js` |
| Lead delete / import / campaigns supervisor+ | policy |
| **Bulk export and audit GET supervisor+** | added this session |
| Call GET scoped to operator (IDOR) | `phase2Hardening.test.js` |
| Webhook signatures, idempotent `provider_events` | telephony/voice tests |
| Secrets omitted from settings/health | telephony tests |
| Live calling cannot be flipped via env/override | `mergeConfig` tests |
| SQL via prepared statements | services |
| CSV formula injection prefix stripped | `sanitizeCell` |
| Login / setup / password-change rate limits | auth tests |

## Remaining risks (launch blockers or accept)

| Severity | Issue | Disposition |
| --- | --- | --- |
| High for internet expose | Default bind `127.0.0.1` is correct for local use. Binding `0.0.0.0` without HTTPS, Secure cookies, and a reverse proxy is unsafe. | Documented; do not do it casually |
| Medium | Rate limits are in-memory (reset on process restart) | Acceptable for single-node local; not for public brute-force at scale |
| Medium | Sessions are not IP-bound | Appropriate for localhost; revisit if hosted |
| Medium | Operators can still read all leads in the workspace | Single-tenant by design |
| Low | No MFA | Local app; add if hosted |
| Info | `npm audit` runs in CI at high/critical on production deps | Keep CI green |
| Legal | Consent/DNC/window are operator-asserted controls, not a legal opinion | Readiness and UI already say this |

## Compliance (calling)

The dial gate checks calling window (recipient timezone), DNC, suppression, opt-out, consent for sales, and campaign compliance profile. Recording is forced off. This is **not** TCPA/GDPR certification.
