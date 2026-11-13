# Tenant-boundary test coverage (Phase 15)

Requirement ids: TEN-01, TEN-02, SEC-02, SEC-03. All results come from the local Docker test database (`node scripts/test-db-local.cjs run`); none were evidenced in production.

## Suites

| Area | File |
|---|---|
| Shared two-tenant fixture | `src/test/tenancy/fixtures.ts`, `src/test/tenancy/request-scope.ts` (self-test `fixtures.integration.test.ts`) |
| Data-gateway resources and fixed RPCs | `src/lib/repositories/cross-tenant.contracts.integration.test.ts` |
| Dynamic id routes, coverage check, list routes, role matrix | `src/app/api/cross-tenant.routes.integration.test.ts` |
| Public v1 API (all 12 route files) | `src/app/api/v1/v1-tenancy.integration.test.ts` |
| Worker-database routes | `src/test/tenancy/worker-db-routes.integration.test.ts` |
| Webhook delivery, realtime cursor, audit, dashboard | `src/test/tenancy/boundaries.integration.test.ts` |
| RLS sweep (every tenant table, roles, definer functions, sensitive columns) | `src/lib/db/rls-sweep.integration.test.ts` |
| Two tenants in two browsers | `e2e/second-tenant.spec.ts` |

## How each suite checks

- **Contracts:**
  - For each of the 36 resources, tenant A runs select by B's id, select by B's `account_id`, update and delete. Each runs through the server path, the worker path, and the browser path where the resource is browser-visible. A positive control proves the same specs find A's rows.
  - All 15 RPC contracts are called with B's ids, through both the app and the worker roles. The `create_broadcast_with_recipients` case also checks that A's broadcast never received B's contact.
  - The membership RPCs `set_member_role`, `remove_account_member` and `transfer_account_ownership` naming B's users return `P0002`, and B's memberships are unchanged.
  - Snapshots of every B row, plus B's outbox count, are compared before and after.
- **Routes:**
  - `CASES` covers 69 method/route pairs on 47 dynamic routes: contacts, conversations and notes, orders, payment links, appointments, broadcasts, flows, automations, lists, segments, media, account webhooks, API keys and members, workspace attributes, teams, quick replies, templates, knowledge, forms, numbers, saved views and report schedules.
  - The pass rule is 403 or 404, B's snapshot unchanged across every one of the 35 named tables that exists, and no B id in the body.
  - Also covered:
    - a positive control: own-id GETs return 200;
    - `/api/media/object` with a B storage key, which returns 403;
    - the existing ones of 17 named list routes (at least 11 required), none of which returns a B id;
    - an 18-case role matrix on A's own rows, which returns 403 and leaves A unchanged. It covers `flows.publish`, `templates.submit`, `ai.knowledge`, `campaigns.send`, `commerce.record_payments`, `appointments.manage`, `appointments.settings` and `commerce.refunds`, plus the admin-only and agent-only routes.
- **v1:**
  - All 12 route files are covered. Tenant A's key gets 404 on 9 B-id calls, with a positive control.
  - The list routes and `/me` return only A.
  - A revoked key and an unknown key both return 401.
  - A read-only key gets 403 on write, send, webhooks, conversations and broadcasts.
  - `messages` and `broadcasts` using B's `phone_number_id` are refused with a 4xx, before any contact, conversation, intent or job is created.
  - `fetch` is stubbed and asserted to have no calls.
- **Worker-DB routes:**
  - **Razorpay settings:** each tenant connects through the real PUT. A's GET shows only A, the secret is never returned, and A's PUT leaves B unchanged.
  - **Razorpay webhook:** A's secret on B's path returns 401 with no receipt. B's secret on B's path naming A's link reference queues exactly one B job, and A is unchanged.
  - **Shiprocket tracking:** A's token on B's path returns 401. B's AWB pushed to A's path is ignored. A positive control queues one A job.
  - **WooCommerce webhook:** A's secret on B's store returns 401. The settings GET lists only A's store.
  - **Zoom webhook:** an event for A's Zoom account that carries B's ids is queued for A's connection only. The settings GET hides B.
  - **Shopify webhooks:** `app/uninstalled` for A's shop stops only A's store. The settings GET hides B.
- **Boundaries:**
  - **Webhook delivery:** `dispatchWebhookEvent` for A queues only for A's endpoint. A forged A-queue job naming B's endpoint makes no request and records no failure count. A positive control delivers to A.
  - **Realtime:** the `/api/events` stream resumed with a cursor on B's outbox event id, or the zero id, shows A's event and never B's.
  - **Audit log:** filtering by B's actor returns nothing, both through `listAuditLog` and the route, and an agent gets 403.
  - **Dashboard:** `loadDashboardOperations(A)` has no B ids and lists only A's team.

## Fixed during integration

The ten route cases that answered a foreign id with 200, 400 or 409 now answer 404, and the `it.fails` placeholder was removed: `PATCH`/`DELETE /api/quick-replies/[id]`, `DELETE /api/automations/[id]`, `DELETE /api/ai/knowledge/[id]`, `PATCH`/`DELETE /api/broadcasts/[id]/schedule` (`src/lib/broadcasts/schedule.ts` checks the campaign is in the workspace before reporting a state conflict), `GET /api/segments/[id]/contacts` (`AudienceNotFoundError`), `GET /api/contacts/[id]/identities` (while Instagram is on; while it is off the route answers `{ enabled: false }` for any id with no query, by design), `GET /api/commerce/orders/[id]/returns` and `GET /api/commerce/orders/[id]/shipment`. No case returned or changed tenant B's data before the fix.

## Route coverage gap

There are 151 dynamic route files. `CASES` covers 47 routes. The exempt routes, each with its reason, are:
- auth;
- invitation tokens;
- the data gateway and RPC endpoints, which the contract suite covers;
- signature-authenticated webhooks, which the worker-DB tests cover;
- the forms data exchange endpoint;
- public share links;
- `public/*`, `platform/*` and `v1/*`.

The AI page's routes `ai/agents/[id]` (GET, PATCH, DELETE), `ai/agents/[id]/duplicate` (POST) and `ai/knowledge/sources/[id]` (GET, POST, PATCH, PUT, DELETE) are mapped in `CASES`, with a switched-off agent and a ready text source created per tenant.

The following dynamic routes have no cross-tenant case yet. The coverage test pins this list (`KNOWN_UNMAPPED`), so it can only shrink, and a new dynamic route fails CI until it is mapped or exempted.

```
account/export/[id]/download, account/invitations/[id], account/support-grants/[id], ai/activity/[id],
ai/assess/conversation/[id], ai/assess/conversation/[id]/refresh, ai/assist/suggestions/[id]/decision,
ai/autoreply/[conversationId], ai/insights/[id], ai/unanswered/[id],
analytics/reports/[id]/download, analytics/reports/[id]/shares, analytics/reports/[id]/shares/[shareId],
appointments/[id]/meeting, appointments/booking-pages/[id], appointments/exceptions/[id],
appointments/messages/[id]/resolve, appointments/staff/[id], appointments/tasks/[id], billing/invoices/[id],
commerce/catalogs/[id], commerce/catalogs/[id]/sync, commerce/coupons/[id], commerce/documents/[id],
commerce/events/[id]/resolve, commerce/inventory/[variantId]/adjust, commerce/inventory/[variantId]/threshold,
commerce/orders/[id]/feedback, commerce/orders/[id]/shipment/awb, commerce/orders/[id]/shipment/label,
commerce/payment-exceptions/[id]/resolve, commerce/returns/[id], commerce/shipment-exceptions/[id],
commerce/shipping-rates/[id], commerce/shop/categories/[id], commerce/shop/products/[id],
commerce/shop/products/[id]/archive, commerce/shop/products/[id]/publish, commerce/shop/products/[id]/variants,
commerce/shop/products/[id]/variants/[variantId], commerce/storefront-links/[id],
contacts/[id]/identities/link, contacts/[id]/identities/unlink, flows/[id]/dry-run, flows/[id]/number,
flows/[id]/runs/[runId], flows/[id]/runs/[runId]/replay, flows/[id]/runs/cancel, flows/[id]/runs/migrate,
flows/[id]/versions/[versionId], inbox/routing-rules/[id], instagram/accounts/[id],
instagram/accounts/[id]/comment-rules, instagram/accounts/[id]/comment-rules/[ruleId],
instagram/accounts/[id]/health, instagram/accounts/[id]/posts, meta-ads/conversions/[id]/resolve, meta-ads/leads/[id],
payments/customer-payments/[id]/refund, payments/refunds/[id], whatsapp/forms/[id]/duplicate, whatsapp/forms/[id]/meta-check,
whatsapp/forms/[id]/publish, whatsapp/forms/[id]/responses/export, whatsapp/media/[mediaId],
whatsapp/numbers/[id]/profile
```

These are still protected by RLS and `account_id` scoping underneath, which `postgres.integration.test.ts` and the RLS sweep check. What is missing is a per-route proof. `payments/refunds/[id]` is exercised only by the role matrix (agent gets 403).
