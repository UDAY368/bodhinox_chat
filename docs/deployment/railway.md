# Railway deployment runbook

Project: Bodhinox_Chat (`45ece5a5-786b-4ed5-848a-aaefb8589c04`). Environment: production (`6fe2fdf9-f4cb-4cad-8f55-f2912abb93f4`). GitHub repository: https://github.com/UDAY368/bodhinox_chat.

| Resource | ID | Configuration |
| --- | --- | --- |
| Postgres | 2c9ad580-bdf3-4adf-903a-a5812509052d | PostgreSQL 18, existing volume |
| Bodhinox-Web | 3dc6ac06-e3ba-484f-96df-e0d763de249a | Dockerfile, port 3000, /api/health |
| Bodhinox-Worker | 1dd980b1-d523-4b4e-b685-faca2fc83087 | Dockerfile.worker, continuous process |
| Bodhinox-Media | bbdc1ab1-8b5b-4b0a-9e59-98d39bbef508 | Private S3-compatible bucket |

The configured application hostname is https://bodhinox-web-production.up.railway.app. Domain allocation and service configuration alone do not confirm a successful deployment; record the deployment status and HTTP checks after connecting source.

The public PostgreSQL proxy uses port26854. On Railway's private network use postgres.railway.internal:5432. Every cloud role URL trusts `/app/deploy/railway-postgres-ca.crt` with verify-ca/uselibpqcompat, without disabling TLS certificate-chain validation. If Railway rotates the project CA, verify the replacement against the operator's database service, update this public certificate, and deploy it alongside updated clients.

The web receives constrained application, auth and worker connections because authenticated API handlers also enqueue work and resolve incoming provider routing. The worker receives only its worker connection; it has no auth database URL, JWT private key or owner migration credential. Tenant domain operations still require transaction-local tenant context and FORCE ROW LEVEL SECURITY.

Use `${{Bodhinox-Media.ENDPOINT}}`, `.BUCKET`, `.REGION`, `.ACCESS_KEY_ID`, and `.SECRET_ACCESS_KEY` reference variables for S3 settings. Bucket URL style is virtual-host; S3_FORCE_PATH_STYLE=false. Set APP_URL and AUTH_JWT_ISSUER to the exact HTTPS application origin.

## Releases

1. Run local/CI typechecking, linting, unit and isolated PostgreSQL integration tests and the production build.
2. Review additive migrations. Existing applied migration files are immutable.
3. Take a Railway backup before changing a database that contains customer data. The initial target was verified empty.
4. Push to `main`. The "Bodhinox validation" workflow runs every check and, only if they pass, its `migrate` job applies pending migrations to production through the reusable "Apply production Prisma migrations" workflow and the `MIGRATION_DATABASE_URL` secret in the GitHub `production` environment. The web and worker services never hold the owner credential. The workflow can still be dispatched by hand, or `npm run db:migrate` run locally with the migration-owner URL. Role bootstrap is only required for onboarding or coordinated role-password rotation.
5. Railway deploys both services only after those GitHub checks succeed: **Wait for CI** (`checkSuites`) must stay enabled in each service's source settings, otherwise code can go live before its migration (as on 1 November 2026, when contacts and the inbox returned 500 for about six minutes). Wait for SUCCESS and verify /api/health, unauthenticated login, protected page redirects and worker readiness.
6. Configure SMTP and Meta credentials when ready, then test signup/verification/MFA, inbound status and message webhooks, private media, a single approved recipient send, and broadcast completion with the browser closed.

Keep one web and one worker replica until shared API rate limiting and provider-wide throughput coordination have been implemented and measured. PostgreSQL job claims and lease fencing support crash recovery; browser request rate-limit buckets are currently process-local. Avoid overlapping worker releases; uncertain dispatches require operator reconciliation.

Migration `20261101000000_round_robin_cursor` adds the worker-only `assignment_cursors` table used by round-robin assignment. It is additive and needs no backfill; run it with the normal migration step before deploying the code that uses it.

Migration `20261101010000_contact_consent` adds nullable `opted_out_at`, `opt_out_source` and `blocked_at` columns to `contacts`. It is additive, needs no backfill (existing contacts start as not opted out and not blocked) and must run before the code that reads the columns.

Migration `20261101020000_segments` adds the tenant-scoped `segments` table (RLS: members read, agents and above write). It is additive and is applied automatically by the CI `migrate` job before Railway deploys the code.

Migration `20261101030000_lists_attributes_tag_categories` adds nullable `tags.category`, the `contact_lists` and `contact_list_members` tables (members read, agents and above write) and `workspace_attributes` (members and the worker read, admins write). It is additive with no backfill. Secret workspace attributes are encrypted with the existing `ENCRYPTION_KEY`; rotating that key makes stored secrets unreadable, so re-enter them after a rotation.

Migration `20261102000000_broadcast_cancelled_status` widens the `broadcasts.status` check to allow `cancelled`. Scheduled campaigns need no extra process: their dispatch job waits in `jobs` with `run_at` set to the scheduled time, so the existing single worker starts them. A campaign that stays throttled by Meta for about an hour pauses with its remaining recipients pending; resume it from the campaign page.

Migration `20261102010000_campaign_tracking_api` adds `broadcasts.kind`, `tracked_url` and `click_count`, `broadcast_recipients.click_token` and `clicked_at`, the `broadcast_clicks` table and the SECURITY DEFINER `resolve_click_token(text)` (worker only). Additive with no backfill. Click tracking needs templates whose URL button is exactly `<APP_URL>/r/{{1}}`, so `APP_URL` must stay the public app origin; changing it breaks tracking for templates created with the old origin.

Migration `20261102030000_entitlements` adds the `plans` catalogue (seeded with free, basic, pro and enterprise) and `account_subscriptions`. Existing workspaces have no subscription row and stay unrestricted. Until billing exists, an operator assigns a plan with the migration owner, for example `INSERT INTO account_subscriptions(account_id, plan_id) VALUES ('<account uuid>', 'pro') ON CONFLICT (account_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`. Lowering a plan never deletes data: existing segments, lists and active flows stay, but new ones beyond the limit are refused.

Migration `20261102040000_flow_builder_nodes` widens the flow node and run-event CHECK lists and adds `flow_runs.delay_until`; it changes no existing rows. Flow delays and reply timeouts are `flow.timer` jobs run by the worker, so the worker must be deployed with the web service: a timer queued before the worker restarts runs when it comes back (late, never twice). Inbound locations and WhatsApp address-form replies are now stored in `messages.interactive_payload`.

Migration `20261102050000_flow_integration_nodes` widens the same CHECK lists for the template, API request, assign agent and connect flow steps; it changes no existing rows. Flow nodes are now read-only through the generic browser data API (the flow editor saves through `PUT /api/flows/[id]`). API request steps call customer-configured URLs from the worker; outbound traffic must be allowed from the worker service.

Migration `20261102060000_flow_triggers_testing` adds the `template_reply` flow trigger, `flows.test_numbers` (at most 3, digits only) and `whatsapp_config.ice_breakers` / `ice_breakers_synced_at`; it changes no existing rows. Inbound-action jobs may now carry `contextMetaId`; jobs queued before the deploy are still accepted without it. Ice breakers are saved only after Meta's conversational_automation endpoint accepts them.

Migration `20261102070000_template_studio` adds `message_templates.template_kind` (default `standard`), `cards`, `auth_options`, `lto`, the `location` header type and the append-only `template_status_events` table (FORCE RLS; members read, admins and the worker insert). Existing templates keep working unchanged as standard templates. The data layer now binds a JavaScript null as SQL NULL for JSON columns (before, it stored the JSON value null). The template AI writer uses the workspace's configured AI provider and answers 409 when none is set.

## Operations

Inspect failed jobs by ID, type, attempts and sanitized last_error through a trusted operator database session. Inspect inbound_action_steps and outbound_intents for interrupted external actions. Do not reset unknown/dispatching intents or stage checkpoints and resend blindly. First reconcile the provider's delivery state and application audit records.

Rotate RSA signing keys with a new AUTH_JWT_KID. Retired public keys remain configured only for the bounded 15-minute access-token overlap described in authentication-validation.md; keep refresh revocation and current-membership checks enabled.

For account defaults run `npm run db:seed -- ACCOUNT_UUID EXISTING_OWNER_USER_UUID` after verified owner onboarding. It is idempotent and does not create demo contacts or send any message. Email-provider setup is explicitly deferred; no live-email success is implied by database authentication tests.

## Recorded release state — 15 October 2026

Application commit `e55c2252e75c2d105a57c53211a162a5bdda95c3` is pushed to `main`. [GitHub validation](https://github.com/UDAY368/bodhinox_chat/actions/runs/38675497680) completed successfully after a clean Linux install, isolated migrations/role bootstrap, typecheck, lint, all tests and production build. Local verification passed1,267tests across136files; runtime dependency audit reports0vulnerabilities. Lint exits0 with33 retained warnings.

Production database migrations1–7 and constrained role bootstrap passed. Repeat migration deploy reports no pending migrations. Local worker smoke reached `[worker] ready` and was stopped afterward.

Web/worker GitHub source connections to `UDAY368/bodhinox_chat@main` and application watch patterns are staged in production patch `d1d5f84a-eb00-4822-b73f-26af1a797b82`. The attempted `accept-deploy` returned “the user did not approve this action”; no application deployment started. The allocated domain is therefore not a verified live application. Apply the reviewed eight staged source/watch-pattern changes through Railway approval when deployment is wanted, then complete the runtime health/worker checks above.

The requested local web server remains at http://localhost:3001 using the isolated synthetic preview account in `bodhinox_test`. It does not operate on production customer data. Email setup is explicitly deferred, and Meta/AI live acceptance remains outstanding.
