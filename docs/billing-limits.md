# Plan limits: what each limit does at and over its value

Plans are edited in the platform console (Plans & prices) and published as numbered
versions. Every limit is a key in a plan's `limits`; a missing key or JSON `null` means
unlimited. A workspace with no subscription row resolves to `enterprise`, which is
unrestricted and cannot be given a finite limit or lose a feature (`plan_locked`). A
suspended, cancelled or incomplete subscription resolves to `free`. A subscription is
held to the plan version it was pinned to when the plan was applied; renewals keep the
pin, and moving subscribers to a newer version is a separate, previewed, audited admin
action.

The source of truth is `LIMIT_POLICY` in `src/lib/billing/entitlements-catalogue.ts`
(a unit test checks that this page names every key).

## Policies

| Policy | At or over the limit |
|---|---|
| `hard` | New additions are refused with 402. Existing items are kept. |
| `hard_inbound_exempt` | Manual creates, CSV imports and public-API creates are refused; anything customers create by writing in is always accepted (the workspace may go over). |
| `hard_addon` | Refused before the AI provider is called; add-on packs raise `ai_messages`. Manual agent replies are never affected. |
| `hard_per_campaign` | Checked per campaign when it is created, not as a running total. |
| `soft` | Shown on the usage meters and warned about; never blocks anything. |

## Limits

| Key | Policy | Counted as |
|---|---|---|
| `seats` | hard | Members plus open invitations. |
| `segments` | hard | Saved segments that are not archived. |
| `lists` | hard | Contact lists that are not archived. |
| `campaign_recipients` | hard_per_campaign | Recipients of one campaign. |
| `active_flows` | hard | Active flows plus draft flows with test numbers. |
| `active_automations` | hard | Active automations. Already-active automations are never deactivated. |
| `ai_messages` | hard_addon | AI replies this month (India time). |
| `ai_tokens_monthly` | hard_addon | AI tokens this month across every AI feature; a workspace's own monthly token cap also applies (the lower one wins). |
| `monthly_active_contacts` | soft | Distinct contacts with any message this month. |
| `messages_monthly` | soft | Outbound messages this month (display only). |
| `storage_bytes` | hard | Member uploads; mirrored inbound customer media never counts. |
| `whatsapp_numbers` | hard | Connected numbers and numbers mid-setup; a removed number frees its slot. |
| `instagram_accounts` | hard | Instagram accounts that are not disconnected. |
| `appointment_staff` | hard | Practitioners who are not archived. |
| `contacts` | hard_inbound_exempt | Every contact row. |
| `integrations` | hard | Connected Razorpay (commerce), Shopify, WooCommerce, Zoom, Shiprocket and Meta Ads connections. Reconnecting or updating never checks. |

Monthly keys reset on the 1st of each month, India time (Asia/Kolkata).

## Where each limit is enforced

Every gate resolves the plan limit first. An unlimited limit returns at once, with no
lock and no count, so workspaces without a subscription stay on the old path. For a
finite limit the gate takes a per-workspace advisory lock, counts, and refuses with 402
`plan_limit` in the same transaction as the write.

| Key | Where it is checked | Notes |
|---|---|---|
| `seats` | `POST /api/account/invitations` (`requireSeatRoom`, insert in the same transaction) | members plus open invitations |
| `active_automations` | `activateWithLoopLock` (`src/lib/automations/activation-lock.ts`), under the per-account activation lock | an active automation is never refused or turned off; a new automation refused by the cap is removed, as for a loop; an edited one keeps its saved changes and stays inactive |
| `active_flows` | `publishFlow`; `moveToDraft` and `PUT /api/flows/:id` adding test numbers, under `lockAccountPublishing` | testing drafts count |
| `contacts` | contact form (`src/lib/repositories/crm.ts`), CSV import (`src/lib/contacts/import.ts`), `POST /api/v1/contacts` | inbound-created contacts (WhatsApp, Instagram, storefront, booking, webhooks, sends to a number) are never refused and may exceed the limit; an import batch counts every new number it adds, and a refused batch stops the import |
| `integrations` | first connection of Razorpay (commerce), Shopify, WooCommerce, Zoom, Shiprocket, Meta Ads | reconnecting, replacing keys or swapping the store never checks |
| `ai_messages`, `ai_tokens_monthly` | `reserveAi` before every provider call (auto-reply, flow AI step, assistant tasks, inbox draft, playground, campaign assistant, flow generator, template drafts) | see Metering |
| workspace `monthly_token_cap` | `reserveAi` with `workspaceCap` (assistant tasks only: summaries, suggested replies, assessments, insights) and the `requireAiBudget` pre-check | auto-replies, flow AI replies, Draft, the playground and the generators are counted in `ai_tokens` but never stopped by it |
| `storage_bytes`, `whatsapp_numbers`, `segments`, `lists`, `appointment_staff`, `instagram_accounts` | unchanged since Phase 8, now through `gateLimit` / `gateWithinLimit` so a refusal records the 100% notice | |
| `campaign_recipients` | unchanged since Phase 8 | a per-campaign size, so it sends no usage notice |
| `monthly_active_contacts`, `messages_monthly` | display only (`soft`) | |

A unit test (`src/lib/billing/limits-policy.test.ts`) fails when a limit that is not
`soft` has no gate in the server code.

## Warnings

When a finite limit reaches 80% and 100%, owners and admins get one `billing`
notification (and the billing email) per limit, period and threshold. Unlimited keys
never warn, so nothing fires for workspaces without a finite limit. Reaching 100% at
once sends only the 100% notice. AI limits are checked when usage settles, and a plan
refusal in `reserveAi` / `requireAiBudget` records the 100% notice (the workspace's own cap
sends none); every count gate sends the 100% notice when it refuses.

`messages_monthly` counts outbound messages (agent and bot) since the 1st of the IST
month, read live from `messages` and cached for 10 minutes per process. Display only.

## Metering

AI usage is metered once per source event (an inbound message, a flow step, an assistant
task, or one API request): a replay of the same event never meters twice, even if the
provider is called again after a crash. A reservation is taken before the provider call
and stops counting by itself after 15 minutes; a crash between the provider call and
settling therefore under-meters (absorbed by the platform), never over-charges.

- Source keys: an inbound message (`inbound:<message id>`), a flow AI turn (its outbound
  intent key), an assistant task (`task:<job id>` for the assessment job, `insight:<run
  id>` for insight runs, otherwise a fresh id per call), a route request (`req:<uuid>`; a
  corrective retry inside the request reuses it and counts one AI message).
- After the call the actual tokens are settled once and the `ai_usage_log` row is
  written. A timeout or 5xx settles the prompt estimate (characters / 4) and no AI
  message; any other failure releases the hold.
- Unlimited workspaces reserve nothing: usage is recorded once per source event after the
  call. Playground turns count their tokens but write no `ai_usage_log` row.

## Expiry, cancellation and suspension

- When a paid plan ends or is cancelled, the workspace drops to `free` at the end of the
  paid period. What no longer fits (segments, lists, flows, automations) is archived,
  never deleted; an owner can choose what to keep. Other items stay but no more can be
  added until usage is under the limit.
- A billing suspension (unpaid after grace) or an admin suspension pauses sending.
  Inbound messages, opt-outs (STOP), delivery receipts, payment webhooks and
  reconciliation keep working in every plan and state.
- Nothing is ever deleted automatically. A workspace deletion request has a 30-day grace
  period and is listed in the platform console as "purge due" afterwards; the purge
  itself is not automated.
