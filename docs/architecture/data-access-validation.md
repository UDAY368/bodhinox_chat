# CRM data access validation

Updated: 15 October 2026. This records the data migration implementation and measured checks; it is not a claim that every imported product journey has passed acceptance testing.

## Implemented boundary

The internal `DataClient` facade preserves the imported fluent query surface: select, equality/comparison/inclusion/null/search filters, containment, bounded OR expressions, ordering, inclusive range pagination, limit, insert/update/upsert/delete, returning projections, single/maybeSingle, and counts. The declared JSON text filter `flow_run_events.payload->>meta_message_id` is supported. Unsupported negated operators, arbitrary JSON paths, and related-resource ordering return explicit errors.

The browser uses fixed resource paths under `/api/crm/<resource>` and REST verbs. Request bodies contain records; they never contain a table name, operation selector, SQL, or SQL identifier. Slugs resolve against the fixed 36-resource registry, and each resource's columns/types come from the committed reviewed schema inventory. Projections, relationship names, filter fields/operators, sort fields, pagination, payload fields/types, and mutation roles are validated server-side. Bodies are streamed with byte limits before JSON decoding. Session validation precedes reads; mutations also require the shared Origin/CSRF assertion.

Server repositories add explicit active-organization scope even for ID lookups and run through `withTenant` transaction-local settings. PostgreSQL constrained app/worker roles and RLS supply the database boundary. SQL identifiers come only from validated resource metadata, and values are bound parameters. Related foreign IDs are looked up under the same tenant transaction before writes; upstream assignment/configuration references without a foreign key are checked explicitly. Child rows receive the active account ID.

Error envelopes preserve stable uniqueness/foreign-key/validation SQLSTATE codes needed by the imported deduplication and concurrency handlers. Messages are fixed safe summaries; raw driver messages, SQL, record values and constraint details are never forwarded.

Browser wildcard projections omit WhatsApp access/verification values and their hashes, API-key hashes, webhook signing values, AI provider/embedding keys, vector embeddings and full-text internals. Private settings writes use their dedicated existing endpoints. API-key, invitation, webhook endpoint and knowledge chunk tables are unavailable through browser data transport. Agent/viewer profile projections mask other members' email addresses; active profile account/role fields come from membership records.

Background callers supply `{accountId}` or an explicit `account_id` equality/payload. Missing or conflicting scopes fail closed. Narrow worker-only database functions resolve WhatsApp number/WABA identities, an API-key hash, and a webhook verification hash before a scoped domain query. They cannot select arbitrary tables or return provider credentials.

Organization changes use the authentication role's narrowly granted identity tables. They re-read the actor's membership, serialize on the account row, protect the owner from deletion/demotion, update ownership and membership atomically, revoke affected sessions, and write audit entries. Invitation redemption locks the invitation, requires a usable unexpired token hash, consumes it once, and adds a membership while preserving the user's other organizations.

## Type compatibility

`select<DTO>()` and `returns<DTO>()` allow explicit migrated payload types. The transitional default for `select` is the documented `LegacyData` compatibility alias, matching the removed SDK's existing consumer inference. The single explicit `any` alias has a line-level lint exemption; there is no global TypeScript or lint relaxation. It does not bypass runtime resource/payload/tenant validation. New consumers should supply DTO types and use explicit repositories where appropriate.

## Verification evidence

Confirmed runs before the final combined coordinator run:

- 28 data transport/body/query/security/pagination/membership-policy unit tests passed.
- Three real Prisma/PostgreSQL CRM tests passed against the isolated test database with constrained app/auth credentials and the configured trusted CA. They exercised persisted inserts, updates, exact counts, filtering, sorting, range pagination, nested contact/tag payloads, tag-filter RPCs, tenant-hidden ID reads, rejected foreign tag IDs, viewer write denial, and private settings projection denial.
- Owned-path TypeScript checks emitted no errors after adding explicit DTO selection support, the declared JSON filter path, and the realtime channel type export.

The coordinator's combined data/repository run passed **36 tests in eight files** in 42.68 seconds. This includes four real PostgreSQL membership scenarios: one-use invite redemption with existing-organization preservation, live membership authority and JWT revocation after role changes, protected-owner/member removal behavior, and atomic ownership transfer with affected-session revocation. Earlier native-binding/filesystem sandbox and certificate failures were setup failures, not passing database checks; the CA-verified reruns above passed. No permissive TLS override was used.

Final command:

```powershell
npm.cmd exec vitest run src/lib/data src/lib/repositories -- --maxWorkers=1 --reporter=verbose
```

The latest focused coordinator run passed **46 tests in four files** in 58.25 seconds (`.superpowers/sdd/data-reviewed-tests.log`, started 21:58:55 on October 14). It exercised the migrated processor against typed atomic-ingest/status/stage boundaries, reference-validation regressions, request-scoped automation routes, and real constrained PostgreSQL behavior. The real database cases now include nested automation step inserts/replacement, flow node writes/deletion, hidden foreign-account reads and rejected foreign-parent inserts, worker reads with correct record projections, and historical author retention after member removal while removed-member assignment remains forbidden.

The processor fixture records persistence inputs and runs captured durable action payloads; it does not claim to prove database deduplication, unread atomicity, status monotonicity, or checkpoint durability. Those guarantees have separate database tests. HTTP receipt failures have separate route tests.

The subsequent full-suite run passed **1,233 tests in 127 files**, with zero failures, in 366.04 seconds (`.superpowers/sdd/full-tests-reviewed.log`, started 22:01:14 on October 14). This includes the new flow-route same/foreign-account mutation cases and realtime expiry/refresh/cursor/revocation cases. The run used `npm.cmd test -- --maxWorkers=1 --reporter=dot`; test execution accounted for 333.56 seconds. The production build also compiled and completed TypeScript and static generation (`.superpowers/sdd/build-current.log`). Later changes made by other implementers require their own subsequent checks.

Included passing checks cover safe SQLSTATE errors, server storage path/viewer denial, JWT-authenticated SSE with 201 same-timestamp events crossing a 200-row batch, foreign-tenant event exclusion, cursor validation preserving PostgreSQL microseconds, client replay deduplication/resync and authenticated reconnect, raw-body webhook signatures, durable receipt failures, queued outbound webhook dispatch, and SSRF/failure handling in the worker. Expanded owned-path ESLint completed with no errors or warnings; focused TypeScript output contained no errors in the changed paths. The narrower verification command is retained below for subsequent data-boundary changes.

```powershell
npm.cmd exec vitest run src/lib/data src/lib/repositories src/lib/realtime src/lib/storage/policy.test.ts src/lib/storage/server.test.ts src/app/api/whatsapp/webhook/route.test.ts src/app/api/whatsapp/webhook/receipt.test.ts src/lib/webhooks/deliver.test.ts src/app/api/flows/[id]/route.test.ts src/app/api/automations/[id]/route.test.ts -- --maxWorkers=1 --reporter=verbose
```

## Live-event and media compatibility

The October 15 follow-up passed **76 tests in ten files** in 63.27 seconds (`.superpowers/sdd/data-final-green.log`, started 08:26:10). The presence regression first reproduced `DATABASE_ERROR`: PostgreSQL `void` results cannot be decoded through the former Prisma query path. Explicit void RPC contracts now execute a fixed parameterized statement without decoding that result and return `data: null`. Scalar and row RPCs retain their previous handling. Real PostgreSQL checks prove the browser heartbeat persists `online` and retains safe SQLSTATE `42501` errors for an absent actor.

Two timestamp regressions first failed in `.superpowers/sdd/timestamps-red.log`. The browser transport now removes only legacy caller `created_at`/`updated_at` fields without changing the caller's object. Raw HTTP timestamps remain forbidden. Repositories add the mutation timestamp after validating the caller payload; existing database update triggers remain authoritative. The passing database regression exercises browser request encoding, strict server decoding/validation and persisted contact edit results.

Unread reset uses the fixed `conversation-mark-read` action with a UUID conversation argument and an agent role requirement; foreign/missing conversations return 404 and viewers cannot mutate. The thread uses this action only when the verified role permits sending. The media-retention switch uses the fixed admin-only `media-retention` action, which changes only the active account's `mirror_inbound_media`; generic browser writes to WhatsApp configuration remain unavailable. Real database tests verify both action policies and persisted results.

`inbound_created_meta_id` is excluded from browser projections, filters, sorts and writes. Authenticated server reads retain it; only trusted worker writes may set it. SSE removes this internal column from both outbox snapshots. Processor tests verify that a retry of the same provider message recovers contact/conversation creation flags and that a different message does not claim creation. These changes passed expanded owned-path ESLint with zero warnings and a focused TypeScript check with no changed-path errors. Browser acceptance checks are coordinated separately; the October 14 full-suite result above predates this follow-up.

The generic browser resources `automations` and `automation_steps` are read-only. Creation, editing, activation, duplication and deletion use dedicated automation routes, which apply scheduling-audience and activation validators. Auditing the list and builder found all UI mutations already use those routes; generic browser queries only read automation records. A regression first reproduced the generic-write bypass (`.superpowers/sdd/automation-contract-red.log`). After the descriptor change, **15 contract and automation-route tests passed** in two files (`.superpowers/sdd/automation-contract-green.log`, 08:33:23 on October 15), checking every generic mutation verb for agents and owners, continued browser reads, and continued authenticated server writes. Focused lint completed without warnings.

```powershell
npm.cmd exec vitest run src/lib/data src/lib/repositories/mutation-timestamps.test.ts src/lib/repositories/crm.integration.test.ts src/lib/realtime/projection.test.ts src/app/api/whatsapp/webhook/route.test.ts -- --pool=threads --maxWorkers=1 --reporter=verbose
```

Server `DataClient` storage uses the direct server S3 facade with a tenant context and the appropriate app/worker credential; it does not call browser HTTP helpers. Its returned URL is an authenticated proxy reference. Upload/removal failures return errors, and invalid tenant paths/viewer mutations are rejected before storage I/O. Real S3/provider behavior remains a separate external acceptance gate.

SSE emits a validated five-minute resume cursor containing the exact PostgreSQL timestamp and UUID, advances by keyset across full batches, and checks JWT/session/membership on each poll. The browser keeps cursor IDs, suppresses replay duplicates, refreshes expired authentication before reconnecting, and permanently closes a revoked stream. Connection and periodic resync callbacks fetch authoritative inbox/unread state; the periodic snapshot repairs transaction-time/commit-time ordering differences and incremental drift. A stream is reported degraded when unavailable. Realtime transport is not an exactly-once side-effect executor.

## Remaining acceptance scope

The data tests prove the exercised query/security contracts and ORM behavior. They do not yet demonstrate every screen, broadcast/provider dispatch, automation flow, public API/MCP journey, production deployment, or long-lived event/media behavior. Those are integrated application acceptance checks owned by the coordinator. Limits are explicit: maximum 1,000 selected rows per query, 500 mutation rows, 30 filters, five sort fields/OR groups, bounded inclusion arrays and bounded projection/expression depth; larger jobs must paginate/chunk. Planned/estimated count requests currently return the exact count. No arbitrary SQL fallback exists.
