# AiSensy parity: gap analysis and implementation plan

Date: 1 November 2026. Status: proposal, nothing implemented yet.

This plan compares the AiSensy feature set with Bodhinox Chat as it exists on `main` today, then gives a phased build order. The AiSensy feature list (323 features in 17 areas) was compiled from `.reference/aisensy-full-2026-10-29`, `.reference/aisensy-rea` and the AiSensy research under `docs/research/`. The Bodhinox side was checked against the code, not the older roadmap documents, which are out of date in places.

## How to read this plan

- **AiSensy IDs** (`BC-07`, `FN-16` and so on) point to the source inventory. Each row there cites the evidence file that proves the feature.
- **Status:** ✅ Bodhinox already has it · 🟡 partial · ❌ missing · ⛔ deliberately not building.
- **Priority:** **P0** is needed before Bodhinox can be called a premium product, **P1** is a strong differentiator, **P2** is nice to have.
- **Size:** S is up to 3 days, M is 1–2 weeks, L is 3+ weeks for one engineer.
- **Evidence strength:** AiSensy evidence is strongest for the flow builder, campaigns, templates and ads. The Live Chat, Dashboard, Contacts, Settings, Team and Developer Hub screens were never captured. For those areas this plan specifies Bodhinox's own design rather than claiming parity.
- **Clean-room rule:** the AiSensy bundles are third-party copyrighted code. Implement from the observed behaviour and limits, and never copy their source code, copy text, icons or assets.

## Recommendation (read this first)

Do **not** try to match every AiSensy feature. About a third of the 323 items are AiSensy business plumbing: their own plan gates, credit wallets, white-label reseller mode, affiliate tracking, telemetry vendors, Dialogflow, Easyinsights, Google Ads and virtual-number resale. Copying those adds cost without making Bodhinox better.

Bodhinox is already ahead in several areas. Keep these as selling points:
- Multi-provider AI (OpenAI, Anthropic, Gemini and OpenRouter) with a knowledge base, drafts, auto-reply and handoff summaries.
- Pipelines and deals.
- An automations engine with 8 triggers and 13 steps.
- A public API with scoped keys, signed and SSRF-guarded webhooks, and an MCP server.
- MFA, row-level security tenancy, and durable outbound intents.

The real gaps that matter for a premium product, in order:

1. **Audience and campaign depth:** segments, opt-in and opt-out, scheduling, retargeting, more than 1,000 recipients, click tracking and reports.
2. **Flow builder parity:** question formats, API request, delay and timeout, template and connect-flow nodes, test numbers and a template gallery.
3. **Template types:** carousel, limited-time offer, authentication/OTP, a premade library and an AI writer.
4. **WhatsApp onboarding:** Embedded Signup, business-profile editing and multiple numbers per workspace.
5. **Plans and entitlements, then billing.** Without these the premium tiers can't be sold.
6. **Inbox premium features:** internal notes, search, real round-robin and routing rules, number masking, and a media library.
7. **Commerce and payments**, then **integrations** (Shopify, Razorpay, Sheets and a webhook UI).
8. **AI agents:** website-trained agents, AI in flows and an AI campaign agent.
9. **Click-to-WhatsApp ads (last):** the most expensive part, and it needs Meta app review.

## 1. Comparison by area

| Area | AiSensy (count) | Bodhinox today | Gap verdict |
|---|---|---|---|
| Team inbox / live chat | 21 | ✅ Core inbox, filters, reactions, quotes, quick replies, typing indicator, handoff, SSE live updates | 🟡 Missing: conversation notes, message search, chat lifecycle states and auto-resolve, saved agent filters, a real round-robin, routing rules, number masking, media library, history view |
| Contacts / attributes / tags | 17 | ✅ Contacts, custom fields, tags, CSV import, dedupe, contact notes | 🟡 Missing: segments, static lists, opt-in/opt-out and block, contact export, global attributes, lead stage/journey, plan limits |
| Broadcast campaigns | 29 | ✅ 4-step wizard, approved templates, per-recipient parameters, retry/resume, counters, recipient CSV export | 🟡 Missing: scheduling (column exists, no dispatcher), the 1,000 cap, retargeting filters, CSV and API campaign types, click tracking, auto failed-message retry, reports, quality/tier/quota header, TTL |
| Template manager | 35 | ✅ Submit, edit, delete, sync, status webhooks, text/media header, QR/URL/phone/copy-code buttons | 🟡 Missing: carousel, limited-time offer, authentication/OTP, location, premade library, drafts, journey timeline, duplicate, AI writer, full 68-language list, health column |
| Flow builder | 73 | ✅ 10 node types, keyword/first-message/manual triggers, fallback, timeout, run log, 3 starter templates | 🟡 Missing about 12 node types, regex/template/icebreaker triggers, per-message delay and timeout, default fallback message, test numbers and "testing only", a template gallery, AI flow generation, quotas |
| Automations | — (AiSensy has none as a separate product) | ✅ Full engine | ✅ Bodhinox advantage. Fix the round-robin stub |
| Pipelines / deals | — | ✅ | ✅ Bodhinox advantage |
| AI | 12 | ✅ Multi-provider assistant, knowledge base (text), drafts, auto-reply, playground, usage | 🟡 Missing: website-crawl agent onboarding, AI node in flows, AI template writer, AI flow generator, campaign agent, AI learnings review |
| WhatsApp number / WABA | 14 | 🟡 Manual token paste, phone health, quality and tier read | ❌ Missing: Embedded Signup, business profile editing, multiple numbers, display-name and green-tick status, migration help |
| Dashboard / analytics / reports | 11 | ✅ Basic dashboard and operations panel | 🟡 Missing: template analytics, campaign reports, downloadable and emailed reports, agent performance |
| Team / roles | 8 | ✅ Owner/admin/agent/viewer, invites, presence, ownership transfer | 🟡 Missing: seat limits, per-feature permissions (for example reports), owner-only sections, audit-log viewer |
| Integrations / API | 14 | ✅ Public API v1, API keys, MCP server, outbound webhooks (3 events) | 🟡 Missing: webhook settings UI and more events, developer hub page, app catalogue (Shopify, WooCommerce, Razorpay, Sheets), Meta Conversions API |
| Commerce / payments | 12 | ❌ | ❌ Catalogue connect, product messages, cart/order trigger, payment links and WhatsApp Pay, order messages |
| Ads (CTWA) | 30 | ❌ | ❌ Ads manager, CTWA trigger and attribution, lead hub, lead forms, audiences, pixel, AI creatives |
| Billing / plans | 16 | ❌ | ❌ Plans, entitlements, add-ons, subscriptions, invoices with GSTIN, usage meters |
| Auth / security / onboarding | 11 | ✅ Email login, TOTP MFA, recovery codes, CSRF, rate limits, RLS | 🟡 Missing: Google sign-in, concurrent session limit and device list, signup questionnaire, trial onboarding |
| Settings | 7 | ✅ Settings hub | 🟡 Missing: opt-in management, notification preferences, timezone per workspace, chat settings (auto-resolve, working hours) |
| Shell / white-label | 13 | ✅ App shell | ⛔ White-label reseller mode, affiliates and telemetry vendors are out of scope |

## 2. Complete feature list with decisions

Each row gives the AiSensy reference, the Bodhinox status, the priority and the phase that delivers it.

### 2.1 Contacts and audience

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Opt-in / opt-out with STOP/START keywords, consent source and timestamp | CT-11, BC-10 | ❌ | P0 | 1 |
| Block / unblock contact (excluded from sends) | CT-12, LC-09 | ❌ | P0 | 1 |
| Saved segments (dynamic filters), clone segment | CT-06, BC-12 | ❌ | P0 | 1 |
| Shared audience filter builder: quick filters, attribute filters, AND groups, tag has/not has | CT-04, BC-07..13 | 🟡 Wizard only | P0 | 1 |
| System attributes for filtering: source, first message, last seen, created date, campaigns received, conversation status, intervened | CT-05, BC-08 | 🟡 | P0 | 1 |
| Static lists with CSV import into a list | CT-07 | ❌ | P1 | 1 |
| Contact export (CSV of a filter or selection) | — (Bodhinox gap) | ❌ | P0 | 1 |
| Bulk actions on the whole filter result, not just the loaded page | CT-02 | 🟡 | P1 | 1 |
| Global (workspace) attributes usable in flows and API nodes | CT-15, FX-06 | ❌ | P1 | 1 |
| Lead stage / customer journey tag categories | CT-09, CT-16 | ❌ | P2 | 1 |
| Tag categories | CT-09 | ❌ | P2 | 1 |
| Plan limits on tags, attributes, segments and lists, with archive-on-downgrade | CT-08..10, BL-04 | ❌ | P1 | 8 |

### 2.2 Campaigns

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Schedule a broadcast for a date and time (timezone aware), cancel, reschedule | BC-18 | 🟡 Column only | P0 | 2 |
| Remove the 1,000-recipient cap; batching paced by the number's messaging tier | BC-24 | 🟡 | P0 | 2 |
| Audience from a segment or list | BC-07 | ❌ | P0 | 2 |
| Retargeting: new campaign from recipients who were sent, delivered, read, replied to or failed a past campaign | BC-08 (Campaigns filter) | ❌ | P0 | 2 |
| CSV campaign (upload with column mapping for template variables, duplicates option) | BC-15, BC-23 | 🟡 CSV audience exists | P1 | 2 |
| API campaign (a named campaign triggered through the public API) | BC-14 | 🟡 v1 broadcast exists, and its durable-queue follow-up is open | P1 | 0 + 2 |
| Click tracking on URL buttons (redirect service and per-recipient clicks) | BC-20, TM-18 | ❌ | P1 | 2 |
| Automatic retry of failed messages with a policy (retryable error codes only) | BC-22 | 🟡 Manual retry | P1 | 2 |
| Header showing quality rating, messaging tier and remaining 24h quota | WA-06, WA-07 | 🟡 Health is read in settings | P1 | 2 |
| Campaign list tabs (All / Broadcast / API / Scheduled), search, pagination | BC-01 | 🟡 | P1 | 2 |
| Test-send to your own number before launch | BC-06 | ❌ | P0 | 2 |
| Campaign reports: day-wise or aggregated CSV, per-user report, emailed ZIP | AN-05..07 | 🟡 Recipient CSV | P1 | 9 |
| Campaign budget and cost estimate (Meta pricing per category and country) | BC-21 | ❌ | P2 | 9 |
| Message TTL (template time-to-live) | TM-27 | ❌ | P2 | 2 |
| AI campaign agent (goal → audience → template → schedule) | BC-16 | ❌ | P2 | 7 |
| Broadcast to ad leads | BC-25 | ❌ | P2 | 10 |
| A/B test (two templates, split audience) | — (not in AiSensy) | ❌ | P2 | 2 (optional) |

### 2.3 Templates

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Carousel templates (up to 10 cards, per-card media/body/buttons) | TM-23 | ❌ | P0 | 3 |
| Authentication / OTP templates (copy code, expiry warning, security disclaimer) | TM-25 | ❌ | P0 | 3 |
| Limited-time offer templates (expiry, coupon) | TM-24 | ❌ | P1 | 3 |
| Location header templates | TM-26 | ❌ | P2 | 3 |
| Full 68-language list and per-language variants | TM-08 | 🟡 | P1 | 3 |
| Drafts (save without submitting), Discard / Save to Draft guard | TM-29 | ❌ | P1 | 3 |
| Template journey timeline (created → pending → approved / rejected, with reason) | TM-03, TM-04 | 🟡 Status and reason stored | P1 | 3 |
| Duplicate template | TM-31 | ❌ | P1 | 3 |
| Premade template library by industry, with "use this" | TM-05, TM-06 | ❌ | P1 | 3 |
| AI template writer (tone, goal, prompt history) | TM-28 | ❌ | P1 | 3 |
| Shared button-capacity validation and Meta's button ordering | TM-17..21 | 🟡 Validators exist | P1 | 3 |
| Health / quality column, filter tabs (Draft / Pending / Approved / Action required) | TM-01, TM-35 | 🟡 | P1 | 3 |
| Fix the `TODO(account-sharing)` conflict target in template submit | — | 🟡 | P0 | 0 |

### 2.4 Flow builder

Bodhinox nodes today: `start`, `send_message`, `send_buttons`, `send_list`, `send_media`, `collect_input`, `condition`, `set_tag`, `handoff`, `end`. Build on `docs/research/bodhinox-flow-builder-blueprint.md`, which already designs much of this.

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Ask Question formats: number with min/max, date, true/false (yes/no), email, regex; attempts, error message, skip button, success / exhausted / timeout ports | FN-16 | 🟡 any/email/phone/regex only | P0 | 4 |
| Ask Media (image/video/document/audio) saved to an attribute | FN-17 | ❌ | P1 | 4 |
| Ask Location (lat/long attributes) and Ask Address | FN-14, FN-15 | ❌ | P1 | 4 |
| Set Attribute (write a contact field or flow variable from a literal or a variable) | FN-18 | 🟡 Automations only | P0 | 4 |
| API Request node: method, params, headers, JSON body, test before save, dot-path response mapping, up to 5 status branches plus fallback | FN-20, FA-01..08 | ❌ (`http_fetch` planned) | P0 | 4 |
| Send Template node (with quick-reply branches) | FN-07 | ❌ | P0 | 4 |
| Connect Flow (jump to another flow) | FN-13 | ❌ | P1 | 4 |
| Condition operators: exists, time-in window, date-in range, numeric greater/less, AND/OR groups | FN-12 | 🟡 equals/contains/present/absent | P0 | 4 |
| Per-message delay (seconds) and per-message timeout with an After Timeout port | FX-01, FX-02 | 🟡 Run-level timeout only | P0 | 4 |
| Default fallback message (text, image or video) when the user goes off-script | FX-03 | 🟡 Fallback policy exists | P1 | 4 |
| Regex trigger with a case toggle; keyword chips | FT-01, FT-02 | 🟡 exact/contains | P1 | 4 |
| Template quick-reply trigger (a reply to a broadcast starts a flow, one route per button) | FT-03 | ❌ | P0 | 4 |
| Icebreaker trigger and icebreaker management | FT-06, FN-22 | ❌ | P2 | 4 |
| Assign agent / team node (not only handoff) | — | 🟡 | P1 | 4 |
| AI Reply node (answer from the knowledge base, then continue or hand off) | AI-03 | ❌ | P1 | 7 |
| Test numbers (up to 3) and "testing only" status for draft flows | FL-03, FL-08 | ❌ | P0 | 4 |
| Flow template gallery by industry (target 20–30, not 72) | FL-07 | 🟡 3 templates | P1 | 4 |
| Duplicate flow, "created by" column, search | FL-02 | 🟡 | P1 | 4 |
| Canvas quality: minimap, fit view, drop-to-create node, edge delete, lock | FE-06..08 | 🟡 Check the current canvas | P1 | 4 |
| Live WhatsApp-style preview panel | FE-13 | 🟡 | P1 | 4 |
| AI flow generation from a prompt, with prompt history | FX-07, FX-08 | ❌ | P2 | 7 |
| WhatsApp Forms (Meta Flows) node | FN-08 | ❌ | P2 | 4b |
| Meta Conversions API node (Lead / Purchase events) | FN-11 | ❌ | P2 | 10 |
| Catalogue, single-product and multi-product nodes; order trigger | FN-04..06, FT-07 | ❌ | P1 | 6 |
| WhatsApp Pay / payment link node | FN-09 | ❌ | P1 | 6 |
| Flow and API-node quotas per plan | FL-04, FA-08 | ❌ | P1 | 8 |
| Composite nodes (several content blocks in one card) | FE-09 | ⛔ Keep single-purpose nodes | — | — |

### 2.5 Inbox and team

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Real round-robin assignment (fix the stub at `src/lib/automations/engine.ts:910-919`), with an online-only option | LC-15 | 🟡 Stub | P0 | 0 |
| Routing rules: by tag, keyword, team or working hours; reassign when unanswered | LC-16 | ❌ | P1 | 5 |
| Internal notes on a conversation (not visible to the customer) | LC-10 | 🟡 Per contact | P0 | 5 |
| Full-text message search, with jump to the message | LC-11 | ❌ | P0 | 5 |
| Chat lifecycle (bot → requesting → assigned → resolved), auto-resolve after N hours, reopen | LC-02, LC-04 | 🟡 open/pending/closed | P1 | 5 |
| Saved inbox filters per agent | LC-12 | ❌ | P2 | 5 |
| Canned messages: favourites and personal vs shared | LC-13 | 🟡 Quick replies | P2 | 5 |
| Media library (reuse uploads, storage meter) | LC-14 | ❌ | P1 | 5 |
| Number masking for agents (role-based) | LC-17 | ❌ | P1 | 5 |
| Contact panel: opt-in, block and lead-stage toggles from chat | LC-09 | 🟡 | P1 | 5 |
| Notifications: new message in assigned chat, mention, SLA breach, campaign finished, template rejected; email digest | ST-05 | 🟡 One type | P1 | 5 |
| Working hours and away message | ST-02 | ❌ | P1 | 5 |
| Agent performance: first response time, resolution time, chats handled | AN-02 | ❌ | P1 | 9 |
| Teams/departments and per-feature permissions (reports, campaigns, flows) | TR-02, TR-03 | ❌ | P1 | 8 |
| Seat limits per plan | TR-04 | ❌ | P1 | 8 |
| Audit-log viewer | TR-06 | 🟡 Table exists | P2 | 8 |

### 2.6 WhatsApp account

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Meta Embedded Signup (connect WABA and number without pasting tokens) | WA-02 | ❌ | P0 | 6a |
| Business profile editing: about, description, address, email, websites, vertical, profile photo | WA-04 | ❌ | P0 | 6a |
| Multiple WhatsApp numbers per workspace | SH-03 | ❌ (`@@unique([account_id])`) | P1 | 6a |
| Display-name status and rejection reason; green-tick (OBA) application tracker | WA-04, WA-05 | ❌ | P2 | 6a |
| Quality rating, tier and quota sync job, with a notification on downgrade | WA-06, WA-11 | 🟡 On demand | P1 | 6a |
| Number migration from another BSP (guided steps) | WA-03 | ❌ | P2 | 6a |

### 2.7 AI

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| AI agent onboarding from a website URL (crawl → knowledge base → greeting and instructions) | AI-02 | 🟡 Text knowledge base only | P1 | 7 |
| File and URL ingestion into the knowledge base (PDF, DOCX, sitemap) | AI-03 | ❌ | P1 | 7 |
| AI learnings: review unanswered questions and promote answers into the knowledge base | AI-04 | ❌ | P2 | 7 |
| AI message metering and plan quota | AI-06, AI-11 | 🟡 Usage log | P1 | 8 |

### 2.8 Integrations and developer

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Webhook settings UI; events for contact, conversation, campaign, flow and template status | IN-04 | 🟡 3 events, API only | P0 | 0 |
| Developer hub page (API keys, docs link, webhook logs, test event) | IN-03 | 🟡 | P1 | 0 |
| Shopify: order/cart/fulfilment events → templates; abandoned cart | CM-11, CM-12 | ❌ | P1 | 6 |
| WooCommerce | CM-11 | ❌ | P2 | 6 |
| Razorpay payment links (and PayU later) | CM-07 | ❌ | P1 | 6 |
| Google Sheets (append row on flow completion) | — | ❌ | P2 | 6 |
| Zapier/Make: use the public API and webhooks, and publish a recipe | — | 🟡 | P2 | 6 |
| CDP connectors (WebEngage, CleverTap, MoEngage), LeadSquared, Dialogflow, Easyinsights | IN-06, IN-07, AI-12, FN-21 | ❌ | ⛔ | — |

### 2.9 Commerce, ads, billing and analytics

| Feature | AiSensy | Status | Priority | Phase |
|---|---|---|---|---|
| Connect a Meta catalogue, list products, send product/catalogue messages from inbox and flows | CM-01..04 | ❌ | P1 | 6 |
| Cart/order intake from WhatsApp orders, orders list, order-confirmation message | CM-05, FX-04 | ❌ | P1 | 6 |
| Payments list and reconciliation (payment link status webhooks) | CM-06 | ❌ | P1 | 6 |
| CTWA ads: connect ad account, list ads with insights, ad-to-flow trigger, lead attribution | ADS-01..06, FT-04 | ❌ | P2 | 10 |
| Create CTWA ads, targeting, budget, AI creatives, audiences, lead forms, pixel | ADS-08..25 | ❌ | P2 | 10 |
| Plans and entitlements (limits plus feature flags enforced server-side) | BL-04..07, BL-15 | ❌ | P0 | 8 |
| Subscriptions, add-ons, invoices with GSTIN, upgrade/downgrade, trial | BL-01..13 | ❌ | P0 | 8 |
| Message wallet / conversation credit | BL-14 | ❌ | P2 | 8 |
| Dashboard KPIs: conversations, response time, campaign funnel, flow completion, AI resolution | AN-01..02 | 🟡 | P1 | 9 |
| Template analytics (sent/delivered/read/clicked per template, by day) | AN-04 | ❌ | P1 | 9 |
| Google sign-in | AU-02 | ❌ | P1 | 8 |
| Concurrent session list and "log out other devices" | AU-06 | 🟡 logout-all exists | P2 | 8 |

### 2.10 Deliberately not building (⛔)

| Item | Reason |
|---|---|
| White-label / partner reseller mode (WL-01..03) | A separate business. Revisit only if you plan to resell. |
| Google Ads (ADS-26), Ads micro-frontend (ADS-29) | Gated even inside AiSensy, with no evidence of use. |
| Virtual number purchase (WA-09), MM Lite (WA-12) | These need a telecom partner or a Meta program. Not core. |
| Telemetry vendors, Intercom, affiliates (SH-09, BL-16) | Choose your own tools. These aren't product features. |
| Cross-sell launcher, signup questionnaire (SH-06, AU-09) | Marketing UX. Add after the product works. |
| Composite node cards (FE-09) | Rewriting the editor model costs weeks and adds no capability that single-purpose nodes lack. |
| CDP connectors, LeadSquared, Easyinsights, Dialogflow, Ginger | Niche. Generic webhooks plus the API cover them. |
| WhatsApp-based 2FA / dashboard lock (AU-03, AU-05) | Bodhinox already has TOTP MFA and recovery codes, which is a stronger design. |

## 3. Step-by-step implementation

Every phase follows the repo rules in `CLAUDE.md`:
- Additive Prisma migrations only.
- Every domain query inside `withTenant`.
- Queue background work before acknowledging.
- Outbound sends go through `dispatchOnce` and outbound intents.
- No secrets or customer content in logs.
- Security, durability and tenancy tests for each behaviour change.
- Update the feature inventory and `docs/deployment/railway.md` when behaviour changes.

A phase is done only when `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=1` and `npm run build` pass, and a Railway deploy shows web and worker `SUCCESS`.

### Phase 0: Finish the loose ends (about 1 week, S tasks)

These are cheap fixes that remove known bugs before new work builds on them.

1. **Round-robin assignment.**
   - Replace the stub in `src/lib/automations/engine.ts:910-919`.
   - Add `accounts.assignment_cursor` (or a small table) and pick the next eligible agent in a transaction with `FOR UPDATE`, so two concurrent assignments never pick the same cursor slot.
   - Add an "online agents only" option that uses `member_presence`.
   - Test: 3 agents and 6 conversations give 2 each, and a concurrent test never double-assigns.
2. **Template submit conflict target.** Resolve the `TODO(account-sharing)` in `src/app/api/whatsapp/templates/submit/route.ts:71` so uniqueness is per account plus name plus language. Add a migration with a unique index. Test that two members of one account can't create duplicates.
3. **Public API broadcast durability.** Make `src/app/api/v1/broadcasts/route.ts` enqueue `broadcast.dispatch` before returning `202`, matching the dashboard path. Test that the API acknowledgement implies a queued job.
4. **Webhook settings UI and events.**
   - Add a Settings → Developer page: list, create, rotate secret, enable/disable, send test event, recent deliveries.
   - Add events: `contact.created/updated`, `conversation.assigned/closed`, `broadcast.completed`, `flow.completed`, `template.status_updated`.
   - Reuse `src/lib/webhooks/*`, so the SSRF guard and signing stay in one place.
5. **Remove** the empty `src/lib/supabase/` folder.

### Phase 1: Contacts, consent and segments (2–3 weeks)

Campaigns, flows and ads all depend on this, so it comes first.

1. **Schema (one additive migration):**
   - `contacts`: `opted_in boolean`, `opt_in_source text`, `opted_in_at`, `opted_out_at`, `blocked_at`, `last_seen_at`, `source text`, `first_message text`, `lead_stage text`.
   - New tables: `segments` (id, account_id, name, `filter jsonb`, created_by), `contact_lists` and `contact_list_members`, `workspace_attributes` (key, value, `is_secret`; encrypted at rest when secret, reusing `whatsapp/encryption.ts`).
   - `tags.category`.
   - RLS policies and `withTenant` repositories for each.
2. **One filter engine.** Create `src/lib/audience/filter.ts`. It compiles a typed filter tree (AND groups of conditions over tags, system fields, custom fields, segment, list, campaign-received and campaign-status) into a parameterized SQL `WHERE`, so there is no raw SQL from the browser. Replace `src/lib/broadcast-audience.ts` and the scheduled-audience filter with it. Add unit tests for each operator and a tenancy test showing account A's filter never returns account B's rows.
3. **Consent handling.**
   - Inbound STOP / UNSUBSCRIBE / START keywords (configurable in Settings → Opt-in) update consent and send a confirmation.
   - Every marketing send path skips opted-out and blocked contacts, enforced in the dispatch layer, not the UI.
   - Test that a broadcast never reaches an opted-out contact.
4. **Contacts page:** segment sidebar, "Save as segment", lists tab, bulk actions over the full filter result (server-side, queued as a job when large), CSV export (queued, emailed or downloadable), and opt-in/block toggles.
5. **Global attributes:** Settings → Workspace attributes. Owner/admin only. Secrets are never returned to the browser after creation and are only resolved server-side in flows and API nodes.
6. **Docs:** feature inventory and the public API (expose segments read-only through `/api/v1/segments`).

### Phase 2: Premium campaigns (3 weeks)

1. **Scheduling.**
   - Wizard step 4 gets "Schedule": date, time and workspace timezone.
   - `scheduleWork()` enqueues due broadcasts (`status=scheduled AND scheduled_at <= now()`) under a row lock, so each schedule fires exactly once.
   - Cancel and reschedule while still scheduled.
   - Tests: no double dispatch with two workers, and a cancelled schedule never sends.
2. **Lift the 1,000 cap.**
   - Materialise recipients in batches inside the worker, not in the request.
   - Pace sends by the number's tier and by Meta 429/131056 throttling responses.
   - Keep one worker replica until shared rate limiting exists. If you need throughput above one worker, build a Postgres-backed token bucket per `phone_number_id` first.
   - Test with 50,000 synthetic recipients against a mocked Meta API.
3. **Audience from segment, list or retargeting:** the wizard step 2 uses the Phase 1 filter engine. Add a "Campaign" condition: recipients of campaign X with status sent, delivered, read, replied, failed or not-read.
4. **Test send** to up to 3 saved numbers (shared with flow test numbers) before launch.
5. **CSV campaign type** with column-to-variable mapping and an "allow duplicates" option.
6. **API campaign type:** a named campaign with a template; the public API posts recipients plus parameters into it.
7. **Click tracking.**
   - URL buttons optionally rewritten to `https://<app>/r/<token>`.
   - A redirect route logs the click (recipient, campaign, time; IP hashed) and redirects with a 302 to an allow-listed original URL only, so it can't become an open redirect.
   - Add a `broadcast_clicks` table and a counter on the campaign.
8. **Auto-retry policy:** retry only error codes that are documented as retryable, at most N times with backoff. Never retry `unknown` intents; those surface for reconciliation.
9. **Campaign header** showing quality rating, tier and the remaining 24h quota, from a periodic `whatsapp.health` job.
10. **Campaign list:** tabs, search and pagination.
11. **TTL** on marketing template sends (P2).

### Phase 3: Template studio (2 weeks)

1. Extend the `message_templates` component model and `template-validators.ts` for **carousel** (cards, per-card media handles via the existing resumable upload), **authentication** (OTP copy code, expiry 1–90 min, disclaimer), **limited-time offer** and **location**. Add unit tests for every Meta limit listed in TM-17..26.
2. **Drafts:** a `draft` status, saved locally first. Draft templates are never sent to Meta until "Submit".
3. **Journey timeline** from status-webhook history: a `template_status_events` table.
4. **Duplicate**, **health column**, **filter tabs**, and the full language list (`languages.json` equivalent, written by you, not copied).
5. **Premade library:** 25–30 Bodhinox-written templates by industry, shipped as seed JSON, with "Use this" opening the editor prefilled.
6. **AI template writer** using the existing AI provider layer (`src/lib/ai/*`): prompt, tone and goal, returning a draft that passes the validators. Usage goes to `ai_usage_log`.

### Phase 4: Flow builder parity (4–5 weeks)

Follow `docs/research/bodhinox-flow-builder-blueprint.md` for editor details. Each new node needs:
- an engine handler in `src/lib/flows/engine.ts`
- validation in `validate.ts`
- a form in `components/flows/forms`
- a palette entry
- a run-log event
- tests

1. **Engine primitives first:**
   - Per-node `delay_seconds`, executed as a scheduled `flow.resume` job, not a sleep.
   - Per-node `timeout_minutes` with an `after_timeout` port, also handled by the job queue.
   - Both must survive worker restarts. Test by killing the worker mid-delay.
2. **Ask Question v2:** formats any/text/number(min, max)/date/boolean/email/regex, attempts, error message, skip button, and success/exhausted/timeout ports. Migrate existing `collect_input` nodes forward without changing behaviour.
3. **Set Attribute** (contact field, custom field or flow variable; literal or `{{vars.x}}`), then **Ask Media**, **Ask Location** and **Ask Address**.
4. **Condition v2:** exists, numeric comparisons, time-in window, date-in range (workspace timezone), and AND/OR groups.
5. **Send Template node** with a quick-reply port per button. Sends go through `dispatchOnce`.
6. **API Request node:**
   - Method, URL, params, headers, JSON body.
   - Values from variables, contact fields and workspace attributes.
   - Server-side "Test request" before save.
   - Dot-path response mapping into variables.
   - Up to 5 status-code ports plus a fallback.
   - Reuse `src/lib/webhooks/ssrf.ts` (block private IPs, re-check after DNS resolution), with a 10-second timeout, a response size cap, no redirects to private ranges, and secrets never logged.
   - Tests for SSRF bypass attempts and for a timeout.
7. **Connect Flow** (jump to another flow; the current run ends with an event) and an **Assign Agent / Team** node.
8. **Triggers:**
   - Regex with a case toggle.
   - Template quick-reply trigger (reply to a broadcast button starts a flow; needs the button payload stored on send).
   - Icebreakers (manage them in Settings → WhatsApp and sync to Meta).
   - Document the trigger precedence: active flow run, then template reply, then keyword/regex, then first message, then AI auto-reply.
9. **Test numbers and testing-only status:** draft flows run only for up to 3 test numbers, and publishing makes them live. This also gives safe testing on production numbers.
10. **Default fallback message** (text, image or video) when input doesn't match.
11. **Gallery:** 20–30 Bodhinox-written flow templates by industry. Duplicate flow, search, and a "created by" column.
12. **Canvas polish:** minimap, fit view, drop-to-create node picker, edge delete, lock, and a WhatsApp-style preview panel.
13. **Phase 4b (P2): WhatsApp Forms (Meta Flows).** This needs Meta Flow JSON authoring and `data_exchange` endpoint encryption, so it is a separate project.

### Phase 5: Inbox premium (2–3 weeks)

1. **Conversation notes:** a `conversation_notes` table with @mentions that create notifications. Notes are never sent to WhatsApp, and a test confirms that.
2. **Message search:** a Postgres full-text index on `messages.body` (generated `tsvector` column with a GIN index, added in an additive migration), search UI with jump-to-message, and tenancy tests.
3. **Lifecycle:** statuses bot / requesting / assigned / resolved, auto-resolve after N hours of inactivity (workspace setting, run by the worker), reopen on inbound.
4. **Routing rules:** by tag, keyword, working hours or team. Round-robin among eligible agents. Reassign if there's no first response within X minutes.
5. **Working hours and away message** (sent once per window, through `dispatchOnce`).
6. **Number masking:** a role or member setting that masks phone numbers in UI and API responses. Enforce it server-side in the repositories, not with CSS. Test that a masked agent's API response contains no full number.
7. **Media library:** reuse `media_objects` with a picker in the composer, a storage meter, and deletion that respects retention.
8. **Notifications:** new message in an assigned chat, mention, SLA breach, campaign finished, template rejected, quality drop; email digest via SMTP; a preferences page.
9. **Saved filters per agent; favourite quick replies.**

### Phase 6a: WhatsApp onboarding (2–3 weeks)

1. **Embedded Signup.**
   - Facebook JS SDK login with the embedded-signup config.
   - Exchange the code server-side for a business token, then fetch the WABA and phone number, register the number, subscribe the app and store the encrypted token.
   - Needs a Meta app with Tech Provider status and `whatsapp_business_management` / `whatsapp_business_messaging` permissions approved. **Start the Meta app review in week 1 of the project, because it takes weeks.**
2. **Business profile:** read and update the profile and photo through the Cloud API; the Settings → WhatsApp profile tab.
3. **Multiple numbers.**
   - Drop `@@unique([account_id])` in favour of `(account_id, phone_number_id)`.
   - Add `phone_number_id` to conversations, broadcasts, templates (by WABA) and flows (trigger scope).
   - Add a number switcher in the inbox and wizards.
   - This is the riskiest migration: backfill the existing single number, then switch reads, then writes, behind a flag.
4. **Health sync job** (quality, tier, display-name status) with notifications. Add a green-tick application checklist (it links to Meta; there is no API for submitting it).

### Phase 6: Commerce and payments (3 weeks)

1. **Catalogue:** connect the Meta catalogue ID, sync products into a `products` cache table, and send product, multi-product and catalogue messages from the inbox and flow nodes.
2. **Orders:** parse inbound `order` messages into `orders` and `order_items`, add an order trigger for flows (cart variables), an orders page, and an order-confirmation template.
3. **Payments:**
   - Razorpay payment links first (create a link, send it, a webhook updates the status, add a payment node in flows). WhatsApp Pay (India) after that.
   - Webhooks are signature-verified, idempotent (`webhook_receipts`) and reconciled. Never mark something paid on an ambiguous outcome.
4. **Shopify app:**
   - OAuth install, order/fulfilment/abandoned-checkout webhooks, mapped to templates per event with delay rules.
   - Opt-in is captured from Shopify's marketing consent.
5. **WooCommerce, Google Sheets** and a **Zapier recipe** (P2).

### Phase 7: AI agents (2–3 weeks)

1. **Knowledge ingestion:**
   - URL and sitemap crawler (robots-respecting, same-domain, page cap) plus PDF/DOCX upload, producing `ai_knowledge_documents` with source metadata.
   - Re-crawl on demand.
   - SSRF-guarded fetches.
2. **Agent onboarding wizard:** website, business type, instructions, greeting, and handoff rules.
3. **AI Reply flow node:** answer from the knowledge base with citations stored in run events. Confidence threshold goes to handoff. Reuse the existing auto-reply caps and the 24h window rules.
4. **AI learnings:** list questions the AI couldn't answer, edit an answer, then promote it to the knowledge base.
5. **AI flow generator and AI campaign agent (P2):** structured-output generation validated by `validate.ts` before insertion. They never auto-activate.

### Phase 8: Plans, entitlements and billing (3 weeks)

Build the entitlement layer early (it can ship right after Phase 1 if sales need it). Payments can come later.

1. **Entitlements:**
   - Tables `plans`, `plan_features` (limits and booleans) and `account_subscriptions`.
   - One server-side `can(account, feature)` and `limit(account, key)` helper, called in API handlers and the worker.
   - The UI shows upgrade badges.
   - Tests that a downgraded account can't exceed limits through the API.
2. **Billing:**
   - Razorpay Subscriptions for India (or Stripe abroad): checkout, webhooks, invoices with GSTIN and place of supply, upgrade/downgrade at term end, trial, grace period and suspension.
   - Webhooks are idempotent and verified.
3. **Usage meters:** seats, active flows, AI messages, storage and monthly active contacts.
4. **Add-ons:** extra seats, AI message packs, extra numbers.
5. **Downgrade handling:** choose which tags, segments and lists stay active, and archive the rest. Never delete.
6. **Google sign-in** (OIDC) and the session/device list.
7. **Teams/departments, per-feature permissions, and an audit-log viewer.**

### Phase 9: Analytics and reports (2 weeks)

1. **Dashboard:** conversations by status and source, first-response and resolution times, agent leaderboard, campaign funnel (sent → delivered → read → replied → clicked), flow completion and drop-off per node, AI resolution rate.
2. **Template analytics** by day.
3. **Reports:** day-wise or aggregated campaign CSV, a per-user campaign report and an agent report. Generated by the worker and emailed or downloadable. Size limits apply, with no customer content in logs.
4. **Cost estimate** per campaign from a configurable Meta rate card per category and country.

### Phase 10: Click-to-WhatsApp ads (4–6 weeks, last)

This needs Meta Marketing API access (`ads_management`, `ads_read`, `leads_retrieval`, `pages_*`) and app review.

1. Connect a Facebook ad account and page, then list ads with insights (metric cards and column presets).
2. **CTWA attribution:** read `referral` on inbound messages, store `ad_id` and the source on contacts and conversations, add an ad trigger in flows, and support filtering and retargeting by ad.
3. **Leads hub:** lead-form leads sync, CSV export, and broadcast to leads.
4. **Meta Conversions API node and events** (Lead, Purchase) with deduplication.
5. **Ad creation** (CTWA objective, targeting, budget, schedule, creative) and audiences. These are the largest items; ship them only if customers ask.

## 4. Suggested timeline

| Order | Phase | Duration (1 engineer) | Why this order |
|---|---|---|---|
| 1 | Phase 0: loose ends | 1 week | Removes known bugs |
| 2 | Phase 1: contacts, consent and segments | 2–3 weeks | Campaigns, flows and ads need it; consent is a compliance must |
| 3 | Phase 8.1: entitlements only | 1 week | Lets you gate premium features as they land |
| 4 | Phase 2: campaigns | 3 weeks | Highest revenue impact |
| 5 | Phase 4: flow builder | 4–5 weeks | Core of the AiSensy value |
| 6 | Phase 3: templates | 2 weeks | Needed by campaigns and flows |
| 7 | Phase 6a: WhatsApp onboarding | 2–3 weeks, but start Meta app review in week 1 | Self-serve signup is required to sell |
| 8 | Phase 5: inbox premium | 2–3 weeks | Agent productivity |
| 9 | Phase 8: billing | 2 weeks | Turns plans into revenue |
| 10 | Phase 7: AI agents | 2–3 weeks | Differentiator; builds on the existing AI layer |
| 11 | Phase 9: analytics | 2 weeks | Proof of value for customers |
| 12 | Phase 6: commerce | 3 weeks | Needed for e-commerce customers |
| 13 | Phase 10: ads | 4–6 weeks | Most expensive; only on demand |

Total: about 32–40 engineer-weeks for P0 and P1 scope. With two engineers working in parallel on independent phases (for example campaigns and flows), that is about 5–6 months.

## 5. Open questions to settle before Phase 1

1. **Target market and currency.** AiSensy prices are in rupees with GST. Is Bodhinox India-first (Razorpay, GSTIN, Hindi/Indian languages) or global (Stripe)?
2. **Plan structure.** Do you want AiSensy-style tiers (Basic/Pro/Premium) or usage-based pricing? This decides the entitlement keys.
3. **Meta Tech Provider status.** Is the Meta app already a Tech Provider? Embedded Signup and multi-number depend on it.
4. **Scale target.** How many messages per second do you need per number? Above about 80 msg/s you need shared rate limiting and more than one worker, which the runbook currently says not to run.
5. **Evidence gaps.** The Live Chat, Dashboard, Contacts, Settings, Team and Developer Hub screens were never captured. To claim parity there, capture them with `/reverse-engineer-anything` first. Otherwise this plan's own designs stand.
