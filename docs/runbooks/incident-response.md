# Incident response

Requirement ids: OPS-01, SEC-03. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

**Severity**: SEV1 = app down, data exposure, cross-tenant leak, wrong charges; SEV2 = a core journey broken for a tenant (inbound, send, payments, bookings) or deep health `down` > 10 min; SEV3 = degraded, single feature, workaround exists.
**Owner**: the product owner is on call by default during the pilot (no rota yet).
**Steps**: 1) acknowledge the alert and open a timeline (UTC); 2) classify severity; 3) stabilise (rollback per release-rollback; cancel or reschedule campaigns that have not started (Broadcasts, `DELETE /api/broadcasts/[id]/schedule`; a campaign already sending cannot be stopped today); disable a provider via its flag in `docs/release/feature-flags.md`); 4) for a suspected data exposure: preserve logs, revoke affected sessions/tokens, do not delete evidence; 5) communicate (SEV1/2: affected tenants within 1 h, plain language, no internal details); 6) verify recovery with `/api/health`, the deep check and the console; 7) postmortem within 5 working days for SEV1/2.

Timeline template: `time (UTC) | what was observed | action | by whom`.
Postmortem template: summary; impact (tenants, duration, data); timeline; root cause; what went well/badly; action items (owner, due date); requirement ids affected.
