# Bodhinox Chat — initial product requirements and release scope

**Version:** 1.0  
**Baseline date:** 13 October 2026  
**Status:** Locked initial product baseline for planning. All application requirements are currently planned; none are represented as implemented or tested.  
**Product owner:** Requesting project owner. Domain accountabilities below are functions; named engineering/operational owners are assigned before their work or live rollout.  
**Authority:** The complete 23-section master prompt, the accepted execution roadmap, and the user's instruction to finalize, correct, fill gaps and lock Step 1.  
**Exact product name:** **Bodhinox Chat**. “CRM” is a category descriptor, not part of the locked product name.

## 1. Purpose and baseline rules

Bodhinox Chat is a multi-tenant CRM and marketing automation SaaS platform for Indian businesses, beginning with the four specified healthcare/wellness journeys. One customer history connects source interactions, conversations, leads/opportunities, staff work, appointments, orders, verified payments, fulfilment, feedback and campaign attribution.

The business lifecycle is:

**Meta Ads / Instagram / WhatsApp / website → capture → qualification → CRM → appointment or purchase → verified payment when applicable → fulfilment → follow-up → feedback → reporting.**

Free consultations do not require a payment step. Paid chiropractic services can use the same verified payment services when the tenant enables a price/payment requirement. Work-from-home registration is free by default in the initial template; no employment/payment promise is inferred.

The four journeys and all eleven core modules in the master prompt remain in the complete product scope. The pilot is narrower by release, while data and security support multiple tenants from the beginning.

This document is the product source of truth for scope and defaults. The roadmap determines engineering order. Detailed architecture, schemas, API contracts, UI designs, vendors, credentials and provider approvals are subsequent work. If the roadmap and this PRD differ on product scope, this PRD controls and the roadmap must be updated.

“Locked” means baseline changes are recorded and assessed for release, dependency and acceptance impact. It does not mean that future business configuration, vendor selection, account eligibility or external approvals have been fabricated or completed.

## 2. Users, market and success

### Primary users

- Business owners/admins configure their workspace, integrations, services, catalog, team and reporting.
- Sales/support operators capture and qualify leads, handle conversations and follow up.
- Booking/clinic staff manage practitioner schedules, appointments and attendance.
- Commerce/payment staff manage catalog, stock, orders, reconciliation and permitted refunds.
- Analysts review permitted customer/funnel/campaign outcomes.
- Platform operators administer SaaS operations with scoped support access.
- Customers interact through permitted messages, public lead forms and scoped booking/store/order links. They do not need a staff SaaS account to book or buy.

### Initial market and experience

India is the initial commercial market. The pilot uses INR and Asia/Kolkata; schedules render in the tenant's configured business timezone. Architecture preserves currency/timezone information for later international support. Financial reports do not mix currencies through implicit conversion.

Pilot admin UI is English. Customer message copy is tenant-editable and can use the tenant's approved languages/templates. An automatically translated multilingual admin UI is later scope. Critical customer and staff flows must work on mobile and desktop.

Services, practitioner schedules, locations, products, prices, pipelines, registration questions and follow-up rules are tenant configuration. The healthcare/wellness templates are starter configuration rather than universal hardcoded behavior for every business.

### Pilot outcome

The pilot must demonstrate all four operational journeys, permitted WhatsApp messaging, safe multi-tenancy, verified commerce payments, evidence-based fulfilment, staff handoff, feedback and reconciled campaign reporting.

Use a 14-day monitored pilot as the initial evaluation period. Measure lead volume, qualification, appointment booking/attendance, paid orders, response/handoff time, automation failures, attribution coverage and feedback. Conversion/ROAS growth targets are set after observing a baseline; this specification does not promise business revenue improvement.

## 3. Release scope — cumulative and explicit

**A = internal alpha. B = controlled WhatsApp pilot. C = complete general-release scope. D = optional expansion.** Later releases include earlier requirements.

P0 is mandatory for the requirement's assigned release and its dependent live journey. P1 is also required for its assigned release but can follow P0 work. P2 is an expansion candidate requiring a separate scoped specification. Release dates and SaaS prices are not set by priority.

Safety constraints apply from the first implementation that uses the relevant capability. An A prototype cannot defer permission/signature checks merely because their complete product controls are listed for B.

| Capability | A: internal alpha | B: WhatsApp pilot | C: complete release | D: expansion |
|---|---|---|---|---|
| Tenants/auth/roles | Isolated test workspaces and secure access | Live team operations, sensitive controls, usage/entitlements | Self-service and platform administration | Agency/white-label extensions |
| CRM/inbox | Contacts, opportunities, capture, basic conversation history | Pipelines, tasks, merge controls, tags/custom fields, companies, lists, imports/exports, assignment | Dynamic segments, scoring and eligible audience synchronization | Advanced segmentation enhancements |
| WhatsApp | Official adapter or labeled simulator; WFH registration | All four live eligible journeys, templates, takeover and dispatch policy | Expanded channel capabilities as approved | More connected accounts |
| Appointments | Internal domain testing as available | Free consultation and chiropractic; capacity, Monday rule, reminders, changes, feedback | Automatic authorized meeting creation/attendance | Advanced scheduling extensions |
| Commerce/payments | Sandbox testing as available | Products/variants, cart, configured discounts, stock, verified gateway payments, orders, basic cancellation/returns/refunds | Richer retention/reviews and integrations | Advanced commerce extensions |
| Fulfilment | Test events | Audited staff-confirmed fulfilment; verified provider statuses if available | Automated approved courier adapter | Additional couriers |
| Automation | Reliable runtime and initial preset | Four presets; editable rules, versions, pause, logs, dry run, failure recovery | Visual editor and full documented node catalog | Advanced orchestration options |
| Meta/attribution | Preserve available raw touchpoints | Read-only campaign/ad spend and supported metrics; fixed pilot model; financial/funnel dashboard | Lead-form sync, richer reports/breakdowns, configurable attribution, cost/expense estimates | Explicitly authorized ad/campaign/budget mutation |
| Instagram | Adapter planning/simulation | Not required for B live gate | Eligible official messaging/comment workflows sharing CRM/inbox | Additional account types only if approved |
| AI | No customer-facing requirement | No AI dependency for pilot journeys | Reviewed summaries/replies, qualification, grounded knowledge/insights | Separately approved bounded autonomy |
| SaaS billing/reports | Config/data foundations | Controlled entitlements, usage, essential dashboard and CSV access | Monthly/annual billing, report scheduling, spreadsheet/PDF exports, marketing/onboarding | Partner/white-label commercial models |

B can use secure web booking/storefront links where eligible channel-native interactions are unavailable. A fallback must still obey provider/product rules.

B does not require automatic Zoom attendance or courier tracking to open the pilot if permitted manual operations are adequate. It must show “staff confirmed” or “unknown,” maintain audit evidence, and never label manual data as provider confirmed. C requires the approved adapters described in its scope. An external capability unavailable for the chosen provider/account is documented as unavailable with its permitted alternative; it cannot be counted as a successful live integration.

The following are outside the initial baseline: complete clinical records/diagnostic decision support, payroll/recruitment management, a regulated marketplace settlement system, native mobile applications and full accounting software. D is an extension boundary, not a promise to deliver every possible future feature.

## 4. Roles and access

A user may hold multiple granted roles in a tenant. Permissions are evaluated server-side and can be narrowed by assignment. Tenant roles cannot grant platform administration.

| Role | Allowed baseline responsibilities | Restricted unless separately granted |
|---|---|---|
| Tenant owner | Business/team/integration settings, delegated operational permissions, subscription access | No access to other tenants; ownership transfer is an audited operation |
| Tenant admin | Manage configured tenant operations and granted staff permissions | Ownership transfer and SaaS billing need explicit grants |
| Sales/support | Assigned conversations/leads, permitted profile fields, tasks, stage changes | Bulk exports, credentials, refunds, sensitive clinic notes |
| Booking/clinic staff | Assigned schedules/bookings, minimum relevant details, attendance and feedback | Campaign exports, merchant credentials; sensitive notes only with explicit grant |
| Commerce operator | Granted catalog/inventory/order/fulfilment actions | Refund approval/initiation needs a specific finance permission |
| Finance/billing | Granted reconciliation/refunds/receipts; SaaS billing only if granted | Unnecessary clinical content and integration secret display |
| Analyst | Granted aggregate reports and source definitions | Raw contact export/sensitive customer detail |
| Platform administrator | SaaS health, plans and authorized support operations | No standing unrestricted tenant customer-data browsing |

Privileged owner/admin/platform accounts require MFA before B production use. Raw integration secrets are never redisplayed as ordinary settings data. Every export, refund initiation, permission change, contact merge, important stock adjustment and platform support access is audited.

## 5. Shared business rules and defaults

The choices below are architect-defined defaults authorized by the instruction to fill gaps. They are initial behavior, not claims about a particular tenant's actual schedules, inventory or policies.

| Decision | Locked initial behavior |
|---|---|
| Brand | Bodhinox Chat |
| First complete pilot channel | WhatsApp; Instagram is required in C |
| Tenant foundation | Multi-tenancy from A; first business pilot followed by a second isolated tenant |
| Customer identity | Tenant-scoped observed/verified identifiers; no same-name/username merge; audited manual merge with history |
| Contact versus opportunity | One contact may have multiple opportunities; repeated events within the same enrollment cannot silently create duplicate opportunities |
| Human handoff | Taking over pauses bot conversation messages until explicit resume; separately governed transactional reminders can continue |
| Offline free consultation | Monday-only enabled in the starter template and configurable per service/tenant |
| Appointment reminders | 24 hours and 2 hours before the current booking; past scheduled times are skipped |
| Work-from-home session reminders | Starter preset uses 24-hour/2-hour offsets and permits tenant configuration |
| Feedback | Default scheduled 24 hours after recorded completion/delivery; send only when the channel/purpose permits; duplicate requests prevented |
| Staff follow-up | Default task due 24 hours after completed session/visit/delivery; automatic marketing follow-up stays disabled until explicit tenant configuration and consent checks |
| Initial paid-product checkout | Prepaid gateway-confirmed payment; gateway methods configured by tenant |
| Merchant funds | Tenant-owned merchant connection; SaaS subscriptions use a separate platform billing flow |
| Delivery/attendance | Separate evidence labels: provider confirmed, staff confirmed, unknown |
| Pilot attribution | Last identifiable eligible marketing touch within 30 days before conversion, stored per conversion |
| Pilot analytics | INR; explicitly labeled local reporting dates; no silent FX conversion |
| Inventory reservation | B default hold is 15 minutes, adjustable by tenant; late payment after hold expiry requires stock recheck/reconciliation |
| Public customer access | Opaque scoped links, expiry/revocation and server validation; sensitive details require additional verified access |
| Pricing/tax/availability gaps | Unconfigured paid checkout or booking is blocked with staff next steps; no invented prices, zero-tax assumption or available slots |
| Marketing opt-out | Immediately suppress new prohibited marketing and recheck already scheduled sends; service messages follow their separate permitted purpose |
| Dashboard data | Persisted business records; demo/simulator data marked and excluded from production metrics |

Booking/checkout/customer-access link lifetime is configured by purpose in the next security/API design. The invariant locked here is scope, revocation, expiry and verified access for sensitive information; an unauthenticated link never opens an entire customer profile.

Tenant configuration changes affect new transactions by default. Existing order price snapshots and attributed conversion records retain their historical basis; current booking changes explicitly replace dependent reminders.

## 6. Four complete journeys and recovery paths

### J1 — Work From Home

**Entry → menu → registration → welcome → onboarding/invitation → session → attendance/outcome → follow-up.**

Collect full name, WhatsApp phone, city, state and communication preferences. Use the inbound phone identity where trusted; corrections requiring identity changes must be verified. Required fields must be valid before marking registration complete.

Record the opportunity, source evidence, selected session and enrollment once. Send configured welcome, invitation instructions and authorized session link/details. Session capacity and date must exist before offering enrollment. Record invitation sent; group joined remains unknown unless reliably observed. Session attendance may be authorized staff confirmed in B or provider confirmed in C.

Create follow-up tasks and progress the lead using observed outcomes. A missing session/link, refused consent, unobservable membership, interrupted registration or handoff is an explicit state with staff resolution.

**Acceptance:** registration, source retention, permitted onboarding, session reminders, evidence-labeled outcome, staff follow-up and takeover are demonstrated. Registration conveys no guaranteed employment or earnings claim.

### J2 — Online / Offline Free Consultation

**Entry → menu → mode/service → registration → available slot → confirmed booking → reminders → consultation outcome → feedback/follow-up.**

Capture name, phone, city/state, consultation mode, selected service/location/practitioner as applicable, slot and required consent. Free means configured customer price is zero; no gateway payment is required.

Offline free consultation is Monday-only when its rule is enabled, interpreted in business local time. Available slots respect working hours, holiday exceptions, service duration, capacity and conflicts. Online appointments use a configured authorized meeting link in B; automatic meeting creation is C.

Confirmation is sent only after the booking transaction succeeds. Provide cancellation/rescheduling management and staff notification. Completed/no-show/cancelled status controls later actions.

**Acceptance:** a valid booking succeeds, a prohibited day/full slot fails, rescheduling frees/replaces the slot, old reminders cannot send, and completed bookings receive eligible feedback/follow-up.

### J3 — Chiropractic Treatment

**Entry → menu → registration → practitioner/location/service → available slot → booking → optional configured payment → reminders → visit outcome → feedback/rebooking.**

Reuse appointment services rather than a separate booking implementation. Service price and payment requirement are tenant-configured. If advance payment is required, confirmation/completion rules must check verified payment status; if not, the booking can be confirmed without payment.

Minimum booking details are collected. Clinical details are excluded from marketing and visible only to expressly permitted staff. The system does not perform diagnosis or prescribe treatment.

**Acceptance:** practitioner/resource conflicts and changes are enforced; pricing/payment requirement is displayed; staff can record outcome and trigger permitted follow-up without leaking sensitive details.

### J4 — Ayurvedic Products

**Entry → menu → categories/catalog → cart → details/address → priced checkout → pending order/reservation → verified payment → fulfilment → delivery evidence → feedback/follow-up.**

Capture name, phone, required address fields, city, state, postal code and optional delivery instructions. Show reviewed descriptions/disclosures, live availability, quantities, item totals, configured discounts/delivery/tax and final payable amount.

Create the pending order and stock reservation before gateway checkout. Retry-safe authoritative payment processing verifies merchant, amount, currency and order association. Payment authorization/pending state is not successful collection. A timed-out payment result remains pending/uncertain until reconciled.

Late payment after reservation expiry cannot silently cause negative inventory. Recheck stock, then route an unavailable-stock case for approved resolution/refund. Fulfilment waits for a valid paid order and stock readiness. Returns follow tenant policy, gateway-verified refunds and inspected stock disposition.

**Acceptance:** full purchasing journey works; invalid/replayed payment callbacks cannot duplicate effects; concurrent purchases cannot oversell; order/financial histories and feedback are traceable.

### Common recovery

Invalid input prompts correction with preserved draft progress. Customers may request staff help at any point. Missing approval/account/template/schedule/stock produces an actionable blocked state, not fabricated success. Duplicate/inconsistent events are recorded and reconciled. Current opt-out/takeover/job/version conditions are checked before customer effects.

## 7. Required lifecycle semantics

These are business states; detailed database enums/transitions belong to architecture.

- Opportunities have configurable stages; default stages are New, Contacted, Qualified, Appointment Booked, Appointment Completed, Product Interested, Converted, Follow-up and Lost. Converted needs a recorded business outcome, distinct from verified payment collection.
- Appointments distinguish confirmed, rescheduled history, cancelled, completed and no-show. Pending paid booking is distinct when a tenant requires advance payment.
- Orders distinguish pending payment, paid, fulfilment ready/processing, shipped, delivered and cancelled; return/refund states are tracked independently.
- Payments distinguish created/pending, authorized where applicable, captured/succeeded, failed and refund outcomes. Multiple attempts may relate to one order without duplicate collection credit.
- Workflows distinguish draft, published, paused and archived; individual executions retain their published version, run state and completed effects.
- Integration status distinguishes disconnected, configuring, sandbox/simulated, awaiting approval, connected, degraded and revoked/expired.
- Message submission, provider acceptance, delivery and read are distinct where exposed; absent delivery evidence stays unknown.
- Changing a critical status generates activity/audit evidence and the relevant internal event without promising any unsupported external event.

## 8. Reporting definitions

All reports show timezone, date basis, freshness, source, currency, attribution model where relevant and unavailable data. Date ranges are inclusive of the local start and exclusive of the next local day after the end.

| Metric | Locked definition |
|---|---|
| Leads | Distinct lead/opportunity records created in the stated cohort; contacts and messages have separate counts |
| Qualified leads | Distinct cohort leads with a recorded qualification event; repeated transitions count once |
| Appointment conversion | Distinct eligible cohort leads with at least one confirmed booking / eligible cohort leads × 100 |
| Attendance rate | Completed/attended appointments / completed-or-no-show appointments due in the period × 100; future/cancelled appointments excluded |
| Purchase conversion | Distinct eligible cohort leads with at least one verified paid product order / eligible cohort leads × 100 |
| Gross merchandise sales | Paid-order item amounts before discounts/refunds; tax and shipping reported separately |
| Net merchandise revenue | Paid item amounts less discounts and completed item refunds, excluding tax and shipping |
| Collected payments | Verified successful/captured gateway amounts, including separately identifiable components; refunds displayed separately and net collections also shown |
| Average order value | Net merchandise revenue / number of distinct verified paid orders in the stated order cohort; later refunds restate that cohort |
| CTR | Clicks / impressions × 100 using consistent provider metric definitions |
| CPC | Ad spend / clicks |
| CRM CPL | Ad spend / attributable CRM-created leads for the stated period/basis; provider CPL is separate |
| Observed acquisition cost | Defined included acquisition cost / observed first-time paying customers; incomplete historic customer data is disclosed |
| Campaign ROAS | Attributed net merchandise revenue / campaign ad spend on the stated conversion-period basis; unavailable denominator/evidence is N/A |
| Gross profit | Net merchandise revenue less recorded COGS; missing required COGS makes the complete metric unavailable |
| Estimated campaign contribution | Attributed net merchandise revenue less included advertising and variable costs with completeness label |
| Estimated operating result | Declared net-revenue basis less the declared included business costs/expenses; do not claim actual net profit without complete inputs |

A conversion is attributed using eligible evidence available before that conversion, not a customer's most recent campaign at report-read time. Bookings use booked time; paid orders use the first authoritative successful collection time. Completed order refunds retain their original order/campaign attribution.

Order-cohort reports restate the original cohort using refunds known as of the report timestamp. Cash-flow reports show collections/refunds on their actual event dates. These views are labeled and must not be silently mixed. Historical attribution recalculation in C is versioned and explicit.

Provider reach/frequency and other non-additive metrics cannot be summed across advertisements as if they were unique totals. Platform-reported conversions and CRM-observed conversions are separate. An attributed sale is a documented model allocation, not proof of causal advertising impact.

## 9. Traceable functional and cross-cutting requirements

Each row below has a unique ID, target release, accountable function and an observable acceptance result. All are currently **planned**. Source sections and requirement status are additionally recorded in the companion CSV.

| ID | Requirement | Release / priority | Accountable function | Acceptance evidence required |
|---|---|---|---|---|
| TEN-01 | **Isolated organizations:** Organization creation, membership, invitations and organization switching enforce server-side tenant access. | A / P0 | Platform | Two tenants cannot read or change each other's records through altered IDs or organization selectors. |
| TEN-02 | **Roles and permissions:** Role checks apply to screens, APIs, jobs, files, reports and sensitive fields. | A / P0 | Platform | A role denied an operation cannot perform it through another interface. |
| TEN-03 | **Secure access and audit:** Secure sessions, recovery, privileged MFA and audit records protect administrative and sensitive operations. | A / P0 | Platform | Revoked sessions fail; privileged changes and controlled exports have actor, tenant, timestamp and outcome. |
| TEN-04 | **Configurable business setup:** Tenant settings control service/product journeys, schedules, timezone, templates and integration health. | B / P0 | Platform | An unconfigured journey is unavailable and creates a staff task rather than presenting invented availability. |
| CRM-01 | **Shared customer and lead records:** Contacts support separate leads/opportunities, sources, channel identities, owners and activity histories. | A / P0 | CRM | A returning customer can open a new opportunity without losing earlier appointments, orders or source evidence. |
| CRM-02 | **Capture and safe identity resolution:** Manual and inbound capture normalize phone numbers; merges require trusted evidence or audited staff review. | A / P0 | CRM | Same-name Instagram and WhatsApp users are not automatically merged; approved merges preserve histories. |
| CRM-03 | **Pipelines and tasks:** Configurable pipelines, stage transitions, notes, tasks and follow-up dates support all four journeys. | B / P0 | CRM | A lead can be assigned and progressed; unauthorized stage changes fail and valid changes appear in its timeline. |
| CRM-04 | **Tags, fields and contact organization:** Contacts support tags, custom fields, companies, filtering, saved views and static lists. | B / P1 | CRM | Filters select matching records within the tenant; field and company updates persist. |
| CRM-05 | **Import, export and assignment:** Controlled CSV import/export validates rows and supports manual or configured round-robin assignment. | B / P1 | CRM | Bad rows have actionable errors; repeated import does not silently duplicate contacts; export requires permission. |
| CRM-06 | **Dynamic segments and scoring:** Saved rules dynamically segment contacts and explain deterministic lead scores; eligible audience sync follows provider approval. | C / P1 | CRM | Changed facts update segment membership; a score exposes its rule and inputs; audience sync requires explicit permission and consent. |
| INB-01 | **Operational inbox:** Conversations provide ownership, unread state, history, internal notes and permitted replies. | A / P0 | Messaging | An assigned operator can work a conversation; internal notes are never sent to the customer. |
| INB-02 | **Human takeover:** Takeover pauses customer-facing bot conversation steps until an authorized operator explicitly resumes automation. | B / P0 | Messaging | A queued bot reply is blocked after takeover; permitted transactional reminders continue under their own rules. |
| INB-03 | **Media and status:** Supported attachments, saved replies and provider-reported message states are stored with evidence. | B / P1 | Messaging | Provider acceptance is distinguished from delivery/read; unsupported status remains unknown. |
| CAP-01 | **Website and external lead capture:** Tenant-specific website forms and authenticated external ingestion create leads with source and consent evidence. | B / P1 | CRM | Valid repeated submissions reconcile safely; unauthorized ingestion and spam controls are enforced. |
| WA-01 | **Official WhatsApp connection:** Official adapter validates callbacks, protects credentials and surfaces account connection state. | A / P0 | Integrations | Valid inbound events reach the correct tenant; invalid signatures do not create records. |
| WA-02 | **Four-option routing:** The menu routes to Work From Home, Online/Offline Free Consultation, Chiropractic Treatment and Ayurvedic Products through eligible formats. | B / P0 | Messaging | All four choices reach the intended workflow; a numbered-text fallback and invalid-input recovery work. |
| WA-03 | **Dispatch policy and opt-out:** Every send checks current permission, consent purpose, channel restrictions, template status and business status. | B / P0 | Messaging | An opt-out after scheduling blocks prohibited marketing at dispatch; blocked sends show a reason and staff next step. |
| WA-04 | **Templates, health and reconnection:** Supported templates/statuses, account errors and credential expiry/revocation have sync and reconnection flows. | B / P0 | Integrations | A rejected template cannot be sent; disconnect does not erase CRM history or claim messages were delivered. |
| WFH-01 | **Registration and onboarding:** Collect full name, observed/validated phone, city, state and communication preferences before completing registration. | A / P0 | CRM | Missing fields prompt correction; completion creates/updates CRM, sends permitted welcome and records available source. |
| WFH-02 | **Session, invitation and follow-up:** Provide configured invitation/session details, reminders, attendance evidence, pipeline updates and staff follow-up. | B / P0 | Appointments | Invitation sent does not imply joined; unavailable attendance stays unknown or staff recorded; duplicate input does not enroll twice. |
| APT-01 | **Services and availability:** Configure consultation mode, practitioner/location, durations, capacity, working hours, holidays, price and timezone. | B / P0 | Appointments | Only configured available slots are offered; both resource and customer conflicts are checked. |
| APT-02 | **Monday-only offline free consultation:** The pilot offline free-consultation template enables a tenant/service-configurable Monday-only rule. | B / P0 | Appointments | A non-Monday date in the business timezone fails while an eligible Monday slot can be booked. |
| APT-03 | **Safe booking and lifecycle:** Atomic capacity checks support confirmed bookings, cancellation, rescheduling, attendance and no-show with customer management links. | B / P0 | Appointments | Concurrent requests cannot exceed capacity; rescheduling preserves history and releases the old slot. |
| APT-04 | **Reminders and feedback:** Schedule 24-hour and 2-hour reminders, staff notifications and post-completion feedback using current appointment version. | B / P0 | Automation | Past reminder times are skipped; cancelled/replaced bookings send no obsolete reminder; staff can inspect blocked sends. |
| APT-05 | **Online meeting integration:** Authorized meeting adapters create/update sessions and ingest supported registration/attendance events. | C / P1 | Integrations | Provider success is verified; booking changes update meetings where supported and failures create actionable tasks. |
| COM-01 | **Catalog and product information:** Products support categories, SKUs, variants, images, search, prices, availability and reviewed disclosures/claims. | B / P0 | Commerce | Only published purchasable stock appears; price/SKU changes do not alter past order snapshots. |
| COM-02 | **Cart and checkout:** A tenant storefront supports quantity changes, addresses, item-level totals, configured coupons, delivery fees and tax inputs. | B / P0 | Commerce | Server totals recompute correctly; manipulated client prices and unauthorized cart links are rejected. |
| COM-03 | **Stock consistency:** Reservations, expiry, stock movements, low-stock alerts and adjustments form one inventory source of truth. | B / P0 | Commerce | Concurrent checkout cannot oversell; retries do not deduct twice; delayed payment after expiry enters an exception. |
| COM-04 | **Order lifecycle and customer access:** Orders have unique identifiers, immutable item/price snapshots, status history and scoped customer access. | B / P0 | Commerce | A customer link cannot expose another order; cancelled/returned states retain history and financial evidence. |
| COM-05 | **Cancellations, returns and refunds:** Staff can apply configured cancellation/return rules, initiate approved refunds and record condition-based stock restoration. | B / P0 | Commerce | Refund success requires gateway evidence; pending/failed refunds remain visible and resalable stock is not assumed. |
| COM-06 | **Reviews and retention:** Verified order feedback/reviews, low-stock notification configuration and consent-aware product retention workflows are supported. | C / P1 | Commerce | Feedback is linked to the appropriate order; opt-outs prevent remarketing; stock alerts reflect actual movements. |
| PAY-01 | **Merchant ownership and UPI checkout:** Each tenant connects an authorized merchant account; configured UPI-capable checkout and payment links pay that tenant. | B / P0 | Payments | Payment attempts reference the intended tenant, merchant, order, amount and currency; no raw card data is stored. |
| PAY-02 | **Verified financial outcomes:** Validate trusted gateway events/responses and prevent duplicate/out-of-order payment effects. | B / P0 | Payments | Invalid signatures, wrong merchant/amount/currency and replay cannot mark an order paid or duplicate transactions. |
| PAY-03 | **Reconciliation and receipts:** Payment attempts, captures, completed refunds, gateway references and configured receipts/invoices reconcile to orders. | B / P0 | Payments | A paid order has trusted payment evidence; missing/conflicting events produce reconciliation exceptions. |
| FUL-01 | **Evidence-based fulfilment:** Staff record dispatch/delivery with audit and evidence; automated status uses verified provider events when connected. | B / P0 | Commerce | No notice claims provider-confirmed delivery from an unverified event; staff-confirmed events are labeled. |
| FUL-02 | **Courier integration:** An approved courier adapter creates shipments, normalizes tracking and reconciles later corrections. | C / P1 | Integrations | Reordered/repeated tracking cannot send duplicate notices or move delivered shipments backward without reviewed correction. |
| AUT-01 | **Reliable events and preset workflows:** Business events publish reliably with idempotent consumers, durable execution history and preset workflows. | A / P0 | Automation | Duplicate delivery and worker restart do not repeat completed domain effects. |
| AUT-02 | **Scheduling and failure recovery:** Timezone-aware delays, cancellation, retry backoff, dead letters, loop limits and eligible replay support the four journeys. | B / P0 | Automation | A stale queued reminder is blocked at dispatch; repeated failure is inspectable; replay skips completed effects. |
| AUT-03 | **Publishing and dry run:** Preset configuration has draft/published/paused/archived states, immutable versions and a no-side-effect test mode. | B / P0 | Automation | Runs retain their starting published version; dry run cannot send messages, change stock or charge money. |
| AUT-04 | **Visual workflow editor:** Business users author validated trigger/condition/action graphs, branches and delays using implemented node types. | C / P0 | Automation | Disconnected/invalid or unbounded-loop graphs cannot publish; permissions govern publication and replay. |
| AUT-05 | **Full node catalog and extensibility:** Support the master prompt's triggers, conditions and actions through versioned domain contracts and authorized external webhooks. | C / P1 | Automation | Every exposed node executes its documented action or reports a capability block; external calls cannot access restricted network destinations. |
| IG-01 | **Official Instagram onboarding and messaging:** Eligible professional accounts connect with approved authorization and supported messaging/webhooks. | C / P0 | Integrations | Live tests pass for the selected route and permissions; disconnection/revocation has an actionable state. |
| IG-02 | **Shared workflows and eligible comments:** Supported keyword/private-reply/comment workflows reuse CRM, handoff, appointments and commerce with channel-specific dispatch checks. | C / P0 | Messaging | Unavailable events remain unavailable; current restrictions and reliable identity matching are enforced. |
| ADS-01 | **Read-only ad synchronization:** Connect eligible ad accounts and sync campaign/ad-set/ad hierarchy, daily spend and supported metrics with freshness status. | B / P0 | Integrations | Pagination/retries/backfill do not duplicate snapshots; failed/stale sync is visible. |
| ADS-02 | **Detailed insights and reports:** Campaign/ad comparisons, supported breakdowns, date ranges, budgets and spend alerts distinguish unavailable metrics. | C / P1 | Analytics | Values agree with the selected provider basis; non-additive metrics such as reach are not blindly summed. |
| ADS-03 | **Controlled campaign changes:** Authorized campaign creation/publishing or budget edits need explicit user confirmation, permissions, configured safeguards and audit. | D / P1 | Integrations | Read-only users cannot mutate ads; no AI recommendation or workflow silently increases spend. |
| ATT-01 | **Touchpoint evidence:** Capture available referrals, source IDs, timestamps and consent evidence when leads arrive. | A / P0 | Analytics | Missing evidence is unknown; subsequent conversations do not overwrite original touchpoint history. |
| ATT-02 | **Pilot attribution model:** Use last identifiable eligible marketing touch within 30 days before conversion; store model/version and conversion-specific decision. | B / P0 | Analytics | Out-of-window or absent evidence leaves conversions unattributed; refunds retain the original attribution allocation. |
| ATT-03 | **Expanded attribution controls:** Tenant-controlled windows and documented first-touch/last-touch model choices support versioned report recalculation. | C / P1 | Analytics | Historical model changes are explicit; a report states model, window, currency, coverage and time basis. |
| REP-01 | **Pilot funnel and financial metrics:** Report leads, qualification, bookings, attendance, orders, verified collections, refunds, spend and attributed net merchandise revenue. | B / P0 | Analytics | Totals reconcile to source ledgers; gross sales, collections and attributed revenue are labeled separately; zero denominators show N/A. |
| REP-02 | **Exports and scheduled reports:** Daily/weekly/monthly/custom reports, CSV/spreadsheet exports, PDF reports and controlled sharing respect tenant/role restrictions. | C / P1 | Analytics | Scheduled generation and file download both check authorization; shared links are scoped and expire. |
| REP-03 | **Costs and estimated contribution:** Record actual product, gateway, fulfilment, advertising and included variable costs with completeness indicators. | C / P1 | Analytics | Missing required cost inputs prevent a complete-profit claim; estimated contribution states included/excluded costs. |
| AI-01 | **Agent assistance:** Provide summaries, suggested replies, intent detection, qualification assistance and lead prioritization with staff review. | C / P1 | AI | Suggestions show relevant source context and do not become customer messages without operator action. |
| AI-02 | **Grounded knowledge and insights:** Permission-aware tenant knowledge retrieval and defined report queries support answers with evidence and freshness. | C / P1 | AI | Cross-tenant prompts/retrieval fail; unsupported answers abstain or hand off; financial claims reconcile to reporting. |
| AI-03 | **Safety, evaluation and usage:** Evaluate leakage, hallucination and instruction attacks; enforce usage limits, retention and medical/product-claim restrictions. | C / P0 | AI | AI cannot diagnose, invent cure claims or independently confirm payment/attendance/delivery. |
| BIL-01 | **Entitlements and metering:** Configurable contact/user/integration/workflow/message limits and exactly-once business usage records govern plan access. | B / P0 | Billing | Retries do not double-meter; quota exhaustion pauses eligible new actions without preventing payment reconciliation. |
| BIL-02 | **SaaS subscription billing:** Monthly/annual billing, subscription changes, billing records and grace states are separate from customer commerce payments. | C / P0 | Billing | Subscription webhooks reconcile independently; no tenant purchase funds are counted as platform subscription revenue. |
| BIL-03 | **Onboarding and platform administration:** Self-service signup, marketing website, setup wizard and audited platform support/tenant administration are available. | C / P1 | Platform | Support has no standing unrestricted tenant-data access; temporary scoped access is authorized and audited. |
| SEC-01 | **Sensitive data and lifecycle:** Minimize health details; enforce field/role controls, consent purpose, retention, export, deletion and disconnection workflows. | B / P0 | Security | Sensitive notes never enter marketing content; verified data requests complete through policy-aware audited processing. |
| SEC-02 | **Application and credential protection:** Server validation, secret protection, secure sessions, rate limits, applicable CSRF protection, upload safety and webhook authentication apply. | A / P0 | Security | Hostile input/upload, forged callbacks and secrets in application outputs fail security checks. |
| SEC-03 | **Isolation beyond database rows:** Tenant isolation extends to cache, search, storage, queues, streams, reports and future AI retrieval. | B / P0 | Security | Adversarial cross-tenant tests cover every listed surface with no successful unauthorized access. |
| SEC-04 | **Governance and provider eligibility:** Current provider/account and product-policy review is a live gate; privacy/disconnection disclosures and responsible business review are required. | B / P0 | Security | Restricted capabilities stay disabled; a mock or pending approval is never shown as a live permission. |
| OPS-01 | **Operational recovery:** Monitoring, failure alerts, backups, restore drills, incident ownership and rollout/rollback runbooks protect the pilot. | B / P0 | Operations | A restore meets documented recovery targets; queue/provider failures are visible and have an assigned response owner. |
| OPS-02 | **Performance and accessibility:** Responsive critical flows support keyboard use, labeled controls and declared load/latency targets. | B / P1 | Operations | Critical tasks work on desktop/mobile; measured results pass the PRD performance profile without affecting financial invariants. |
| OPS-03 | **Repeatable delivery and evidence:** Migrations, automated checks, API/config/setup docs and labeled seeds ship with modules; track implemented/tested/simulated/live separately. | A / P0 | Operations | A clean environment starts using documented setup; tests and release evidence are reproducible. |
| FUT-01 | **Future extensibility:** Reserve extension paths for multiple connected accounts, agencies, white label and additional industries without immediate pilot UI. | D / P2 | Platform | Later scope is separately specified; pilot data/contracts do not assume one universal business account. |
| UX-01 | **Functional and complete screen states:** Every exposed control performs its authorized action; screens provide loading, empty, validation, success, error and disconnected states with responsive accessible layouts. | A / P0 | Product design | Available controls persist/perform their intended action; unavailable capabilities are hidden or explicitly disabled with a reason; critical forms work by keyboard. |
| SEC-05 | **Purpose-specific consent evidence:** Consent records retain purpose, channel, source, timestamp, notice/version and withdrawal; service communication and marketing permission are evaluated separately. | B / P0 | Security | Missing or withdrawn marketing consent cannot be inferred from booking/purchase; exports and send decisions preserve the relevant evidence. |
| ADS-04 | **Eligible Meta lead forms:** Approved lead-form events and authorized lead retrieval create CRM records with available form/campaign evidence. | C / P1 | Integrations | Only eligible authorized forms are synchronized; duplicate events do not duplicate leads and missing permissions are visible. |
| REP-04 | **Expenses and operating estimates:** Record other included business expenses and show estimated operating results only with a declared revenue/cost basis and completeness. | C / P1 | Analytics | Missing expense categories are disclosed; taxes, gross profit, campaign contribution and estimated operating results are distinct. |

## 10. Pilot quality and release gates

### Engineering validation profile

Architect-defined initial performance profile: two isolated tenants; 10 concurrent staff users and 10,000 seeded contacts per tenant; 100 accepted webhook events per minute across both tenants. These are staging validation inputs, not tenant quotas or a provider throughput promise. Real deployment capacity is declared after architecture/load testing.

- Common CRM/booking API operations target p95 ≤ 2 seconds under the declared profile, excluding separately measured upstream provider latency and asynchronous reporting/export work.
- Accepted inbound messages target p95 ≤ 5 seconds to inbox visibility under healthy nominal processing.
- Due reminders target dispatch within 60 seconds of their eligible scheduled time under healthy operation; provider restrictions/outages are measured and surfaced separately.
- Pilot service-availability target is 99.5% over a full measured month; a 14-day pilot cannot by itself demonstrate a monthly SLO.
- Initial recovery targets: RPO ≤ 24 hours and RTO ≤ 4 hours, with a documented staging restore drill before B. Architecture may improve these; reducing them requires a baseline change.
- No successful cross-tenant unauthorized access, unverified paid confirmation, duplicated financial effect or oversell is acceptable in release testing.

### Pilot go-live gates

1. Every B P0/P1 requirement has passing acceptance evidence; applicable A requirements still pass.
2. All four journeys have both success and recovery demonstrations. At least one consented live interaction per journey is verified on eligible WhatsApp assets.
3. At least one real permitted ad-origin lead with available source evidence is linked to an observed business outcome; any missing metadata cases remain explicitly unattributed.
4. A live commerce purchase and ledger/report reconciliation are verified. Gateway sandbox/test mode additionally exercises replay, incorrect amounts and approved refund paths without requiring wasteful live fault transactions.
5. Two tenants pass adversarial isolation checks, including APIs, jobs, files, streams, exports and permissions.
6. Concurrency checks demonstrate booking-capacity and inventory invariants.
7. Opt-out after enrollment, human takeover, stale reminder dispatch, provider timeout and worker recovery pass their tests.
8. Financial/funnel dashboard fixtures reconcile exactly to defined source records and formulas.
9. The required account/template/merchant/product permissions and tenant setup inputs for B are complete. Pending integrations remain disabled/labeled.
10. Backup restore, monitoring/alert delivery, deployment/rollback and incident ownership are demonstrated.
11. There are no unresolved critical/high-severity security findings or defects that break a mandatory journey or financial invariant.

The broader C release additionally requires passing C acceptance evidence, approved Instagram/provider live checks, visual-builder dry-run/version checks, AI evaluations, subscription reconciliation and report access checks.

## 11. Prioritized pilot backlog

This is the product backlog; detailed source files, contracts and test commands are created in later module implementation plans.

| Epic | Priority | Dependencies | Required outcome / requirement references |
|---|---|---|---|
| E01 Tenant and access foundation | P0 | Architecture/provider feasibility | TEN-01..03, SEC-02, OPS-03; isolated usable workspace |
| E02 Shared CRM and capture | P0 | E01 | CRM-01..05, CAP-01, ATT-01; safely matched/assigned leads |
| E03 Inbox and official WhatsApp adapter | P0 | E01, E02; account route | INB-01..03, WA-01..04; permitted operator/customer messaging |
| E04 Reliable workflow runtime | P0 | E01, E02 | AUT-01..03; durable presets and safe scheduled effects |
| E05 WFH onboarding | P0 | E02, E03, E04; configured session | WFH-01..02, WA-02; complete enrollment and follow-up |
| E06 Appointments and service journeys | P0 | E02, E03, E04; configured schedules | APT-01..04; free consultation and chiropractic work end to end |
| E07 Product checkout and payments | P0 | E02, E03, E04; merchant/catalog setup | COM-01..05, PAY-01..03; verified paid order without oversell |
| E08 Fulfilment and feedback | P0 | E05..07 | FUL-01, APT-04; evidence-labeled outcomes and follow-up |
| E09 Read-only ad reporting | P0 | E02, E06, E07; ad permissions | ADS-01, ATT-02, REP-01; reconciled observable outcomes |
| E10 Controlled SaaS pilot operations | P0 | E01..09 | TEN-04, BIL-01, SEC-01/03/04, OPS-01/02; release evidence and runbooks |

P1 features within an epic are still required before its B release gate. Epics may have overlapping engineering work once shared interfaces are agreed; this document does not start implementation or delegate work.

## 12. Setup inputs and dependencies — not invented product facts

These inputs do not prevent freezing the product behavior. They do prevent the dependent feature from going live until the responsible function supplies them.

| Input | Responsible function | Needed before |
|---|---|---|
| Named pilot business, business owner, staff and pilot participants | Product owner + tenant owner | Tenant setup and live pilot |
| Team capacity, budget and desired launch date | Product owner | Committed estimates and development scheduling |
| Actual service duration, practitioner hours, capacity, locations, holiday/cancellation rules | Tenant booking owner | Offering live bookable slots |
| WFH session date/time/capacity, invitation and authorized meeting link | Tenant session owner | Live WFH enrollment/reminders |
| Catalog/SKUs/stock/prices, reviewed descriptions/disclosures and shipping/return policies | Tenant commerce owner | Product publication and checkout |
| Applicable tax/receipt/invoice configuration and business approval | Tenant finance owner | Paid checkout/receipt production |
| Meta assets, account eligibility, permissions, app review and approved templates | Integration owner + tenant owner | Live affected Meta capabilities |
| Gateway provider/merchant eligibility, account credentials, refund permission | Finance + integration owners | Live customer payments/refunds |
| Meeting/courier provider and permitted credentials | Integration + operations owners | Automatic C integrations |
| Consent text/purposes, retention settings, privacy contact, deletion/hold policy and review | Product/privacy + tenant owners | B production personal-data processing |
| Domain, authentication/hosting vendors, support/incident owner, tested capacity and alerts | Architecture + operations owners | Production rollout |
| Plan prices, usage caps, overage/grace policies and SaaS merchant setup | Product + billing owners | C self-service subscription launch |

Choosing a gateway/auth/hosting vendor is Step 2/architecture work; this PRD locks the required behavior rather than an unverified commercial supplier. Work involving current laws or provider policies requires current official evidence in that step; this document asserts no completed legal or account approval.

## 13. Scope change control

Maintain version 1.0 as the baseline. Record each requested change with an ID, date, requester, affected requirements/releases, dependency/risk/cost impact, acceptance update and product-owner decision.

Normal tenant edits to already-supported schedules/prices/templates are configuration changes. Changing money ownership, adding autonomous advertising spend, expanding sensitive medical data, changing attribution basis, removing safety controls or moving a required feature between releases is a product baseline change.

The source attachment is preserved unchanged. Future working specifications use Bodhinox Chat. The roadmap is aligned to this PRD; historical wording in the source is not a new product-name decision.

## 14. Step 1 completion and next work

Step 1 is complete as a reviewed, locked planning baseline: requirements, release boundaries, roles, four journeys, default rules, priorities, measurable acceptance, dependency/setup inputs and change control are documented.

Product-owner instruction confirms the name and accepted workflows. Added architect defaults are explicitly visible in Sections 5 and 10. External prerequisites remain tracked rather than described as fulfilled.

Step 2 has now been authorized: the [integration setup guide](../../integrations/2026-10-13-bodhinox-chat-integration-setup-guide.md), capability matrix and account tracker document researched prerequisites and the existing-number coexistence path. Actual account eligibility, policy decisions and approvals remain pending. Architecture/database/API and UI design follow. Development starts only when requested and the relevant planning artifacts are reviewed. No source code, migrations, application shell or external accounts are part of this planning work; the v1.0 product baseline is unchanged.

