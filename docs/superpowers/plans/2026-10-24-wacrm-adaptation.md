# WACRM adaptation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development and dispatching-parallel-agents for independent subsystems; preserve the shared checkout and unrelated changes. User approved proceeding with the recommendations in the linked review. No further product/design approval is required for this scope.

**Goal:** Adapt useful WACRM fixes and operational features while preserving the Railway/PostgreSQL architecture, cream/copper UI, custom AI guards and current integrations.

**Spec:** `docs/research/2026-10-24-wacrm-upstream-gap-review.md`, approved by the user's “proceed with your plan” instruction.

**Architecture:** Port behavior from pinned upstream `.reference/wacrm-upstream-review` at `34bce1a`, never merge Supabase migrations or services. Existing typed data client, tenant scoping, workers, Prisma migrations and auth remain authoritative. No production deployment in this task.

**Constraints:** Node 24, installed dependencies only; no keys or environment values in source/logs; backwards-compatible defaults and additive migrations; preserve existing 24h session filters, AI fallback, Quick Reply CTAs and handoffs. Do not stage unrelated README/user-guide/research changes. Read installed Next.js docs before changing Next.js code.

## Review focus

- Untrusted media cannot render active content inline or enter shared caches.
- Pausing/editing a flow or automation and concurrent replies cannot advance stale work twice.
- Deleted/reordered steps, failed wait persistence, blank conditions and business timezones produce explicit safe outcomes.
- Resync/history pagination retains local failures without duplicating messages; keyboard IME/mobile behavior remains usable.
- Operational metrics/filters are tenant scoped, count real replies, respect session boundaries, and do not treat system/template-only events as human replies.

## Tasks

### 1. Media proxy hardening (primary agent)
- [x] Add failing MIME/header tests, port safe-header helper, wire authenticated WhatsApp media proxy; verify allowlisted inline types, attachment fallback, nosniff/sandbox/private cache.
- [x] Run targeted media tests.

### 2. Flow integrity (flow agent)
- [x] Read local and upstream engine/validation/API/tests; add regression tests for inactive runs, inline timeout, auto cycles, active-save validation and claimed replies.
- [x] Adapt the upstream behavior through local scoped client/worker preserving AI fallback and handoffs. Avoid changing shared schema/types unless needed; communicate exact needs.
- [x] Run affected tests and report files, results and unresolved risks.

### 3. Automation reliability (automation agent)
- [x] Test and adapt stable step replacement/parked-step resume, paused delayed jobs, wait insertion failures, explicit timezone and blank condition guards, template header components.
- [x] Use existing PostgreSQL job claims/recovery rather than importing upstream job system. Add additive migration and schema field for parked-step identity if necessary; own automation-specific schema section only.
- [x] Preserve tenant transaction guarantees, send idempotency, bot pauses and CTA automation calls. Verify all affected automation tests.

### 4. Inbox improvements (inbox agent)
- [x] Test and implement history pagination, failed optimistic-message retention/reconciliation, rich template bubble rendering and mobile/IME Enter behavior.
- [x] Add waiting/unassigned/expiring-soon queues while retaining existing session/status/tag/company filters. Use current last-customer timestamp semantics and real reply timestamps derived/scoped correctly.
- [x] Preserve Quick Reply media/CTA, AI draft and handoff controls. Run targeted inbox/template tests and report.

### 5. Contacts and operational dashboard (primary agent)
- [x] Add exact-normalized-first phone matching and regression tests without broad fuzzy selection.
- [x] Add reply target setting (admin 1–1440 minutes) through account schema, additive migration, settings API/UI and translations.
- [x] Add tenant-scoped operational overview: reply queue/counts, failed-message drilldown, team/AI replies, per-pipeline results, campaign/flow/automation health and WhatsApp health display using existing design/components/queries. Adapt to bounded/scoped SQL rather than Supabase RPC.
- [x] Reuse inbox filters for navigation; verify dashboard calculations/permissions and timezone boundaries.

### 6. Integration and review (primary agent + independent reviewer)
- [x] Review per-subsystem diffs for spec compliance and security/tenant consistency; fix issues with regression tests.
- [x] Run affected suites, full unit suite, typecheck, lint and production build; investigate actual failures.
- [x] Independently review complete diff, fix material findings, update progress/test record and setup/migration instructions. Report verified outcomes and remaining limitations. No production deployment or external messaging.

## Progress ledger

Ruling: User approved the existing concrete gap review and recommended order; execute without another design approval cycle. Work in the existing `codex/bodhinox-foundation` branch to preserve local context and installed dependencies; no checkout reset or worktree creation. Separate agent ownership avoids overlapping code changes; shared schema/model changes must be coordinated.

Pre-flight: flow and automation engines are independent; inbox shares filter/metric semantics with dashboard, so dashboard navigation uses inbox agent's exported filter contract. Primary agent owns account schema/settings; automation agent owns automation pending schema only.

Tasks 1–6 complete.

- Media/contact/data-contract run: 68 passing tests.
- Flow run: 159 passing tests before review, then 20 passing timeout/run-integrity regressions after the review fix.
- Automation run: 124 passing tests; inbox/template run: 63 passing tests.
- API/rendering/phone-health run: 23 passing tests.
- Additive migrations applied to isolated bodhinox_test only, all successful.
- CRM integration initial corrected run: 15/15 passed. Additional filled-data queue/reply/tenant tests: 2/2 passed. Historical-median regression reproduced the wrong first-response sample, then passed after the SQL fix.
- Final unit-only run: 168 files, 1,529 tests passed.
- Final typecheck and production webpack build passed after review fixes. ESLint: zero errors, 32 remaining warnings.
- Independent review found a stale-timeout race and wrong handoff badge source. Both fixed, then re-reviewed with no further material findings. Parent additionally fixed cancelled run status display and historical first-response median.
- The all-at-once suite had one remote PostgreSQL workflow timeout (1,602 passed). The final sequential integration run passed all 74 tests across eight suites in 638.86 seconds. Combined with 1,529 unit tests, all 1,603 tests passed across the separated runs.

Ruling: derive last_reply_at as a read-only tenant-scoped SQL projection, mirroring existing last_customer_message_at, rather than adding a stored column/trigger. This avoids stale timestamps and unnecessary migration state.
Ruling: automated reply totals include both AI and automation bots and are labelled honestly, because sender_type alone cannot distinguish them.
Ruling: preserve existing graph/automation multi-statement save behavior; published versions and atomic graph replacement remain separate future work.

Rollout and limits: docs/deployment/wacrm-adaptation-2026-10-25.md. No production migration, external message, push or deployment performed.
