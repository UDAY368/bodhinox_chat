# WACRM updates missing from BODHINOX

Review date: 24 October 2026. This is a source comparison, not an implementation or a production test.

## Compared versions

| Repository | Revision |
|---|---|
| BODHINOX working checkout | `a694cc33c3ad8a74a9d5734d10ffc254fecf8ff0` |
| Original WACRM import baseline | `27c6bdf43633d1746410168431a8b0e22b4f2ba6` |
| Fresh WACRM main checkout | `34bce1a8abf56281505d90bac165123b6ab7d51a` |

Upstream main's latest commit is dated 16 October 2026. There are **70 commits including merges, or 39 non-merge commits**, after the imported baseline. These are not 70 missing features. The baseline-to-current upstream diff touches 214 files; many are tests, translations, migrations, dependency updates, and fixes.

[Full upstream comparison](https://github.com/ArnasDon/wacrm/compare/27c6bdf43633d1746410168431a8b0e22b4f2ba6...34bce1a8abf56281505d90bac165123b6ab7d51a)

The upstream checkout is isolated in `.reference/wacrm-upstream-review`. No application code, credentials, production configuration, or Git remotes were changed during this review.

## New functionality absent or incomplete locally

| Addition | BODHINOX status | What it would add |
|---|---|---|
| Action-focused dashboard | Missing the new overview implementation; existing charts and dashboard remain | Waiting/over-target/unassigned/closing-window counts, oldest waiting chats, a reply queue, failed-message drill-down, per-agent workload and median reply time, separate AI reply statistics, campaign/automation/flow health, per-pipeline results, and setup checklist. |
| Configurable reply-time target | Missing | Admin setting from 1 to 1,440 minutes, used by dashboard waiting warnings. Local response-time chart defaults to five minutes; there is no matching account setting/schema field. |
| Waiting, unassigned, expiring-soon inbox queues | Missing these additional filters | Waiting means a non-closed chat whose latest inbound is newer than its last reply. Unassigned selects open chats without an agent. Expiring selects waiting chats with at most two hours left in the WhatsApp window. |
| Dashboard WhatsApp quality/limit indicator | Partially covered | Local configuration already checks WhatsApp connectivity and can fetch quality information. Upstream adds a dashboard health chip and a cached `/api/whatsapp/health` endpoint including messaging limits. This is not a wholly missing connection-check feature. |
| Full template rendering inside conversation bubbles | Incomplete | Display template text/media headers, footer, and buttons, using the stored template and message media. Local template bubbles show a template badge and body/name; local sending already supports more components than the bubble displays. |
| Paginated conversation history | Missing in the inspected thread loader | Fetch a recent page, then load older messages without loading the entire conversation. Local thread loading is unbounded. Do not assume upstream's Supabase row-limit failure reproduces identically on the Railway adapter. |
| Better optimistic-message reconciliation | Missing the new merge behavior | Preserve failed local bubbles during resync and reconcile pending messages against persisted rows. Local `handleMessagesLoaded` replaces the entire list with fetched messages, so a refresh can remove local-only failure information. |
| Mobile Enter behavior | Missing | Enter creates a newline on touch devices; the send button sends. Local composer intercepts unmodified Enter and sends regardless of pointer type. Existing responsive layout improvements are a separate matter. |
| Automation template headers | Missing in the inspected automation send path | Send the template header component, including media headers, from automation steps. Local automation `meta-send.ts` sends template name/language/body params without header components. This does not mean manual template sending is missing. |

Dashboard, target setting, health chip and queues: [PR #684](https://github.com/ArnasDon/wacrm/pull/684).
Template rendering: [PR #659](https://github.com/ArnasDon/wacrm/pull/659).
Conversation paging and reconciliation: [PR #677](https://github.com/ArnasDon/wacrm/pull/677).
Mobile keyboard: [commit 140e439](https://github.com/ArnasDon/wacrm/commit/140e439).
Automation header components: [PR #666](https://github.com/ArnasDon/wacrm/pull/666).

**Your existing Session → 24H Active / Expired filters are already present.** Upstream's expiring-soon queue is an additional prioritization tool, not a replacement for those filters.

Local evidence: `src/components/inbox/conversation-list.tsx`, `message-composer.tsx`, `message-thread.tsx`, `message-bubble.tsx`; `src/app/(dashboard)/inbox/page.tsx`; `src/components/dashboard/response-time-chart.tsx`; `src/lib/automations/meta-send.ts`; `prisma/schema.prisma`.

Upstream evidence: `src/lib/dashboard/overview.ts`; new components under `src/components/dashboard/`; `src/components/settings/inbox-settings.tsx`; `src/lib/settings/reply-target.ts`; `src/lib/inbox/inbox-filters.ts`, `optimistic-messages.ts`; `src/lib/whatsapp/template-message-view.ts`; `src/app/api/whatsapp/health/route.ts`.

## Reliability and security changes worth adapting

### 1. Media proxy response hardening — highest priority

[PR #678](https://github.com/ArnasDon/wacrm/pull/678) restricts which media MIME types render inline, downloads other types as attachments, normalizes MIME values, adds `X-Content-Type-Options: nosniff`, applies a sandbox CSP, and changes caching to private.

The local `src/app/api/whatsapp/media/[mediaId]/route.ts` returns the fetched MIME type with `Cache-Control: public, max-age=86400`, without these other response headers. This is a concrete source-level gap; no exploit was attempted or demonstrated. The separate local `/api/media/object` storage route already has protective headers, so apply this assessment specifically to the WhatsApp proxy.

Port the behavior in upstream `src/lib/media/proxy-response-headers.ts` into the current authenticated media architecture. Keep the existing S3/storage paths.

### 2. Flow run integrity — high priority

[PR #674](https://github.com/ArnasDon/wacrm/pull/674) adds:

- Stop existing runs of flows that are no longer active.
- Validate graph saves when the flow is already active.
- Evaluate reply deadlines inline rather than depending only on a periodic timeout sweep.
- Detect cycles made entirely of automatically advancing nodes.
- Claim reply transitions before advancing to reduce duplicate processing.

Local flows have activation validation, a defensive execution cap, timeout processing, and custom AI/human handoff behavior. Those existing safeguards do not fully implement this newer bundle. Adapt the fixes to local engine/worker/transaction behavior rather than copying the Supabase migration wholesale.

This upstream update does **not** deliver the complete AiSensy-style builder previously discussed. It improves the existing flow engine's correctness; the separate BODHINOX flow-builder blueprint still represents proposed future work.

### 3. Automation resume, edit safety, and condition behavior — high priority

[PR #672](https://github.com/ArnasDon/wacrm/pull/672) preserves step identity when editing automations and records the step where a run parked. A resumed run can then find the correct next position after edits, or stop when its original step was removed. It also adds delayed-resume pause checks, wait-persistence error handling, claim recovery, explicit condition timezones, and blank-value guards.

Confirmed local gaps:

- `steps-tree.ts` still replaces steps by delete/reinsert.
- Pending execution schema/resume input lacks `parked_step_id`.
- Delayed `resumePendingExecution` loads the automation and resumes without checking `is_active`; reply-resume already has a pause check.
- Wait insertion in the engine does not inspect the returned insertion error.
- `time_of_day` uses server-local `Date.getHours()`/`getMinutes()`. Overnight ranges already work, but named business timezones are absent here.
- A blank message-content condition currently reaches `text.includes('')`, which evaluates true.

Local PostgreSQL jobs already claim work; assess stalled-job recovery against that existing mechanism before porting upstream's separate claim implementation.

### 4. Contact matching — high priority

[PR #673](https://github.com/ArnasDon/wacrm/pull/673) changes matching toward normalized phone variants and prefers an exact normalized match before a tolerated variant. Local `src/lib/contacts/dedupe.ts` still queries by the last-eight-digit suffix and returns the first `phonesMatch` candidate. That deserves particular attention because incorrect contact selection can affect routing and contact ownership of conversations.

The same upstream PR includes digit-aware search, filter UUID validation, missing-row API responses, and client-IP handling. Those API changes need individual adaptation to the current repositories and Railway proxy trust model; they are not all confirmed missing simply because an upstream helper filename is absent locally.

### 5. AI usage calendar alignment — medium priority

[PR #676](https://github.com/ArnasDon/wacrm/pull/676) includes browser-timezone-aware usage days. Local usage currently buckets through `localDayKey` without an explicit browser timezone. This can place near-midnight usage on a different calendar day from the user. Other AI fixes in this PR are already substantially covered locally, as listed below.

### 6. Business reaction consistency — medium priority

Upstream adds `src/lib/inbox/business-reaction.ts` to model a reaction as the business's reaction, replacing prior staff reactions and supporting rollback/reconciliation. Local reaction API deletion/upsert remains scoped to the individual staff actor. Adapt this if multiple agents are reacting to the same WhatsApp message; different staff identities should not make the local view diverge from the business's actual WhatsApp reaction.

Source: [PR #677](https://github.com/ArnasDon/wacrm/pull/677).

## Changes already covered or inappropriate to copy directly

| Upstream area | Assessment for BODHINOX |
|---|---|
| AI replies after human takeover / stale generation | Custom auto-reply checks already recheck assignment, pause state, customer window and newer inbound state. Preserve the local safeguards. |
| Reusing a stored key with a different provider/endpoint | Local AI test route already requires a new key for provider changes and a changed compatible endpoint. No need to duplicate upstream's helper just to match filenames. |
| Partial knowledge indexing failures | Local knowledge create/update/reindex routes already surface warnings or partial indexing errors. |
| Knowledge retrieval / out-of-context handling | Local implementation includes custom relevance and handoff behavior. Upstream's keyword fix should be evaluated against that behavior, not treated as a new missing knowledge-base feature. |
| Webhook ordering, duplicate ingestion and first inbound | Local transactional ingestion and arrival ordering differ from upstream's Supabase implementation. Compare invariants instead of replacing the ingestion system. |
| Webhook body limits | Local reader already enforces a streaming body cap. Upstream raises its cap to 4 MiB; a capacity increase is a separate decision, not proof local requests are unbounded. |
| Account invitation, transfer and membership migrations | BODHINOX uses custom JWT/auth and PostgreSQL repositories. Upstream Supabase auth/RLS changes cannot safely be applied unchanged. |
| Fresh Supabase install UUID fix | Not a new application feature. Local Prisma/PostgreSQL UUID defaults already use the current stack's approach. |
| Node 22 runtime update | Local runtime targets Node 24. Do not downgrade simply to match upstream. |
| Base UI, React Flow, next-intl, lucide and development dependencies | Maintenance updates, not new CRM capabilities. Check compatibility separately if upgrading. |
| Turbopack PostCSS worker workaround | Build-system change, not a product feature. Apply only if it addresses a reproduced local build problem. |

Additional upstream broadcast status/parameter fixes, WhatsApp configuration role-gating, API rate limits and error responses merit regression checks before a port. BODHINOX has custom send deduplication, permission checks, storage and job handling; this review does not claim every upstream fix is missing or every equivalent path is proven correct under runtime races.

## Recommended order

1. Adapt WhatsApp media proxy headers.
2. Add regression coverage and adapt flow/automation integrity fixes, including template headers and condition timezone/blank handling.
3. Tighten contact selection and verify API boundary behavior.
4. Improve thread pagination, optimistic resync, mobile Enter behavior and template bubble rendering.
5. Add the reply-time target and new inbox queues.
6. Add the dashboard's operational data/cards using BODHINOX's existing cream-and-copper design and PostgreSQL queries.
7. Separately evaluate timezone reporting, reactions, dependency maintenance and the remaining broadcast/webhook fixes against local behavior.

Do not merge upstream main wholesale. Its Supabase migrations/RPCs/RLS and auth assumptions differ from the Railway/PostgreSQL application. Port behavior and tests in small groups while retaining existing providers, AI safeguards, quick-reply CTAs, media storage, custom jobs and design.

## Verification and limits

Verified with a fresh upstream Git checkout, baseline-to-main commit/diff inspection, and direct comparison of local and upstream source paths, types, schema, components and API handlers. Counts were obtained from Git; source gaps were checked against current local files rather than inferred only from commit subjects.

No code was implemented, no existing tests were run, and no production behavior was exercised. This establishes source-level feature gaps and recommended follow-up work, not deployed parity or a runtime security assessment. Only this report was added by the review; unrelated existing working-tree changes were preserved.
