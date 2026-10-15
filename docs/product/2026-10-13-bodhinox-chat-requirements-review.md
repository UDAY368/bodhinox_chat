# Bodhinox Chat — Step 1 requirements review and baseline record

Date: 13 October 2026  
Baseline: **PRD v1.0 — locked for planning**  
Review method: direct comparison of the complete master prompt, accepted roadmap and user correction; consistency/gap self-review; requirement ID/release/source traceability checks. No independent agent review was requested or performed.  
Implementation state: planning documents only; no application capability, provider approval or acceptance test is represented as complete.

## 1. User-confirmed decisions

- Exact name: **Bodhinox Chat**.
- The four workflows and overall project direction are accepted.
- Step 1 is authorized: finalize requirements/release scope, correct mistakes, fill gaps and lock the initial baseline.
- The work remains in the planning phase.

## 2. Corrections and resolved gaps

| Finding | Baseline correction | Result |
|---|---|---|
| Three spellings/category labels were being used as names | Bodhinox Chat is exact; CRM is a descriptor; source attachment preserved | Working documents aligned |
| Roadmap was still provisional after user confirmation | PRD v1.0 is the product baseline; roadmap is engineering sequence | Baseline status and change control recorded |
| Dynamic segmentation/costs/full node catalog appeared both in early phases and advanced release | B static lists; C dynamic segments/scoring, cost/expense estimates and complete node catalog; D extensions/authorized ad mutations | Release ownership unambiguous |
| Full WhatsApp workflows appeared before their booking/commerce dependencies | Domain services precede complete journeys; reliable runtime precedes visual editor | Dependency order retained/corrected |
| Free/paid journey payment behavior was unclear | Free consultation has no payment; WFH registration free initially; priced chiropractic can require verified advance payment | Journey-specific money rules recorded |
| Customer payment funds and SaaS billing were not fully separated | Tenant merchant owns customer collections; platform subscription billing separate | Initial money model locked |
| Contact identity could be conflated with opportunity or cross-channel name | One contact, multiple opportunities; trusted identity or audited merge only | Histories/attribution preserved |
| Staff handoff could race with bot messages | Takeover pauses bot conversation steps until explicit resume; separate transactional reminder rules apply | Send-time checks required |
| Reminder and feedback timing had undefined defaults | 24h/2h reminders, past times skipped, 24h post-completion feedback/staff task defaults | Configurable behavior explicit |
| Group joining, attendance and delivery could be overstated | Provider confirmed / staff confirmed / unknown evidence states | No fabricated observed outcomes |
| Pilot fulfilment was unclear while automatic providers were delayed | B audited staff operations allowed; C approved automatic adapters required | Pilot/full-release gate separated |
| Reservation expiry and delayed payment risk was not fully resolved | 15-minute configurable default hold; late payment rechecks stock and enters reconciliation if unavailable | No silent oversell/fulfilment |
| Refund/return work could be delayed after commerce launch | Basic cancellation/returns/refunds required in B; verified refunds and inspected restock | Financial integrity mandatory |
| Marketing consent could be inferred from a booking | Purpose-specific evidence/version/withdrawal; marketing and service permissions separate | Dispatch suppression and consent ledger required |
| Reporting formulas could use ambiguous populations or dates | Lead/opportunity cohort, distinct converters, verified money, refund restatement, net merchandise ROAS and cash-flow separation | Reconciliation basis defined |
| Attribution was provisional and could overwrite historical evidence | B fixed 30-day last eligible identifiable touch per conversion; C versioned configurable models | Unknown evidence remains unattributed |
| Role names lacked operational boundaries | Role matrix adds export/refund/clinic/credential/support restrictions and privileged MFA | Permissions testable |
| Customer access and UX lacked completion rules | Scoped expiring/revocable links; sensitive verification; functional controls and all screen states | User access/UI acceptance explicit |
| AI and SaaS subscription modules were easy to lose in the ten-phase source list | Both explicit required C scope, with safety/reconciliation gates | Full product coverage preserved |
| Business growth, team and calendar could be invented | Baseline measurement; setup inputs and owners tracked; no promised revenue/launch date | Missing facts kept honest |
| Performance/recovery and pilot success lacked measurable checks | Declared load profile, latency/recovery targets, live checks and 14-day monitored evaluation | Acceptance gates recorded |

The additional default choices and performance targets are architect decisions made under the user's instruction to fill gaps. They are visible in PRD Sections 5 and 10 and can be changed only through a recorded baseline revision. They are not facts supplied about a live business.

## 3. All 23 master sections accounted for

| Master section | Coverage in Step 1 | Later deliverable where relevant |
|---|---|---|
| 1 Role | Senior product/engineering/security quality carried into requirements and review | Module design/implementation reviews |
| 2 Vision | PRD purpose, market, users and lifecycle | Connected end-to-end application |
| 3 Modules | All eleven domains represented in release table and 70 requirement rows | Domain implementations |
| 4 Four WhatsApp journeys | J1–J4, defaults and WA/WFH/APT/COM/PAY/FUL IDs | Live eligible journeys and tests |
| 5 Instagram | IG-01/02 in C and central permission rules | Capability audit and official adapter |
| 6 Meta ads | ADS/ATT/REP IDs, read-only B and controlled D mutations | Account sync/insights and audited actions |
| 7 Commerce | COM/PAY/FUL IDs with B financial integrity | Catalog, orders, payments, returns |
| 8 Visual automation | AUT IDs; complete C node catalog; safe runtime first | Versioned editor/runtime contracts |
| 9 CRM | CRM IDs, role rules and shared contact/opportunities | CRM/inbox screens and services |
| 10 Segmentation | B static lists; C dynamic segments/audience eligibility | Segment/scoring services |
| 11 Analytics | Formulas, attribution/cost/expense basis and report IDs | Reconciled dashboards/exports |
| 12 Official APIs | WA/IG/ADS/PAY integration requirements and launch dependencies | Current capability/permission matrix |
| 13 Architecture | Required boundaries, performance and operational contracts; vendor stack stays architectural work | Architecture/API/event design |
| 14 Database | Ownership/isolation/transaction invariants reflected in product requirements | ERD, schema, indexes and migrations |
| 15 UX | Users, public access, role-based navigation and UX-01 | Screen designs/accessibility review |
| 16 Security | SEC/TEN/AI/OPS controls, privacy/setup gates | Threat model, security/policy evidence |
| 17 Events | AUT requirements and lifecycle/recovery semantics | Event/outbox/queue contracts |
| 18 Commercial SaaS | TEN/BIL/FUT requirements and separate funds models | Entitlements/subscriptions/admin |
| 19 Methodology | PRD, release backlog, dependency order and review process | Module plans and incremental releases |
| 20 Acceptance | Source checks mapped below plus pilot gates | Automated and live acceptance evidence |
| 21 Rules | Functional screens, server truth, no mock/live confusion, reliable effects and repeatable setup | Coding/review standards |
| 22 Deliverables | Deliverable ledger below | Artifacts produced with each module |
| 23 Execution | Requirements first; existing application absent; connected vertical slices | Provider/design work then requested development |

## 4. Source acceptance checks mapped

All evidence below is **planned**; mapping is not a claim that software tests passed.

| Source check | Owning requirement IDs |
|---|---|
| 1 Create/attribute lead | CRM-01, ATT-01/02 |
| 2 Returning customer without duplication | CRM-02 |
| 3 Four correct menu paths | WA-02, WFH-01/02, APT-01..04, COM-01..05 |
| 4 WFH registration/onboarding | WFH-01/02 |
| 5 Monday restriction | APT-02 |
| 6 Reminder status/timezone | APT-04, AUT-02, WA-03 |
| 7 Rescheduling replaces reminders | APT-03/04, AUT-02 |
| 8 Authorized channel messages | WA-03/04, IG-01/02 |
| 9 Idempotent ad metrics | ADS-01/02 |
| 10 Correct checkout total | COM-02 |
| 11 Verified payment confirmation | PAY-01/02 |
| 12 No duplicate webhook effects | PAY-02, AUT-01 |
| 13 Concurrent stock safety | COM-03 |
| 14 Authoritative delivery notification | FUL-01/02 |
| 15 Reconciled dashboard/formulas | REP-01..04 |
| 16 No unsupported confirmed ROI | ATT-01..03, REP-01/03/04 |
| 17 Tenant isolation | TEN-01/02, SEC-03 |
| 18 Opt-out suppression | WA-03, SEC-05 |
| 19 Inspect/retry failed automation safely | AUT-02/03/04 |
| 20 Audit critical operations | TEN-03, SEC-01/02, OPS-01/03 |

## 5. Required deliverable ledger

| Source deliverable | State after Step 1 | Owner / next point |
|---|---|---|
| 1 Product requirements document | Written and baseline locked | Product |
| 2 Architecture/data-flow diagrams | Planned | Architecture/design phase |
| 3 Schema/migrations | Planned | Database design and module development |
| 4 Frontend | Planned | Feature modules |
| 5 Backend/business services | Planned | Feature modules |
| 6 Auth/tenant isolation | Requirements locked; implementation planned | Foundation |
| 7 WhatsApp module | Requirements locked; implementation planned | Integration/messaging |
| 8 Instagram module | Required C; implementation planned | Integration/messaging |
| 9 Meta Marketing module | B read-only/C expanded/D authorized changes | Integration/analytics |
| 10 Runtime/visual builder | A/B runtime, C full editor; planned | Automation |
| 11 CRM/inbox | A/B then C expansions; planned | CRM/messaging |
| 12 Booking | Required B; planned | Appointments |
| 13 Commerce/payments | Required B; planned | Commerce/payments |
| 14 Attribution/analytics | A evidence/B fixed model/C expanded; planned | Analytics |
| 15 Reporting/exports | B essential/C scheduled and expanded; planned | Analytics |
| 16 Automated tests | Acceptance defined; tests planned | Every module/release |
| 17 Demo seed scripts | Planned; explicit labels required | Foundation/modules |
| 18 Environment template | Planned; secrets excluded | Foundation/operations |
| 19 API docs | Planned | Contracts/modules |
| 20 Setup/deployment docs | Planned | Foundation/operations |
| 21 Security/compliance checklist | Product gates defined; current provider/business review pending | Security/integrations |
| 22 Monitoring/operations instructions | Requirements defined; operational runbooks planned | Operations |
| 23 MVP backlog/dependencies/acceptance | Defined in PRD and roadmap | Product |

## 6. Initial risk register

| Risk | Impact | Required mitigation / gate | Accountable function |
|---|---|---|---|
| Meta account/review/product eligibility | Live messaging/ad sync delay or restriction | Current capability matrix, correct onboarding route, disabled/labeled blocked capabilities | Integrations + tenant owner |
| Cross-tenant leakage | Critical privacy/security failure | Adversarial tests across API, jobs, storage, streams, exports and later AI | Platform/security |
| Payment replay or late collection | Duplicate/incorrect financial effects | Verified events, deduplication, reservation exception flow and reconciliation | Payments/commerce |
| Overbooking/oversell | Broken paid/customer commitments | Atomic capacity/stock invariants with concurrency tests | Booking/commerce |
| Unsupported medical/product claims | Harmful content or provider/business-policy failure | Reviewed content, minimum sensitive data, scoped access and AI boundaries | Product/privacy + tenant owner |
| Missing operational setup | Fake availability, incorrect prices/reminders | Block incomplete journeys and assign setup tasks | Tenant admins |
| Incomplete attribution/costs | Misleading business decisions | Coverage/completeness labels, unknown state and documented formulas | Analytics |
| Handoff/opt-out races | Prohibited or competing bot messages | Send-time policy and version/status checks | Messaging/automation |
| Worker/provider outage | Delayed actions or uncertain sends | Visible failure states, controlled retry/reconciliation and runbooks | Operations/integrations |
| Unspecified team/budget/date | Unreliable launch commitments | Capacity-based estimation after architecture and provider findings | Product owner |

## 7. Review conclusion and baseline control

No product behavior is left as a blank “TBD” or an invented business fact. Unknown live configuration/commercial/provider facts are named prerequisites with owners and blocking points. Architecture/vendor decisions are deliberately assigned to the next planning stages.

The initial product baseline is frozen as v1.0 under the user's Step 1 instruction. All 23 source sections and 20 source acceptance checks are accounted for; all 23 required deliverables have a ledger entry; all 70 requirements have release, priority, owner-function and acceptance evidence.

Document validation result: PASS. The CSV parses with 70 unique IDs; the PRD contains the same 70 unique requirement-table IDs; release/priority/owner/acceptance fields are complete; all implementation states remain Planned; internal document links resolve; the PRD contains no unresolved TODO/TBD placeholders. Allocation is A: 13, B: 36, C: 19, D: 2 new requirements, with cumulative releases. These are document consistency checks, not software acceptance-test results.

Changes are recorded against PRD Section 13. Live readiness remains pending until actual integration approvals, tenant inputs, implementation and release evidence exist.

This review completes Step 1. It does not authorize application development, external account creation or production actions.

