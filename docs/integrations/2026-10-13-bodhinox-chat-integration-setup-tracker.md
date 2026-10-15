# Bodhinox Chat — Step 2 account and approval tracker

Updated: 13 October 2026. This tracker contains no credentials or personal identity documents.

User-confirmed facts: starting from zero for Meta setup; pilot uses an existing WhatsApp Business app number. Provider accounts have not been inspected or changed. All other account/approval states below require owner evidence.

Status vocabulary: **User reported**, **Not started**, **Unconfirmed**, **Test verified**, **Awaiting review**, **Approved**, **Live verified**, **Blocked**, **Deferred to C**. Do not mark a provider live from its documentation or a different account's test.

## Account ownership and identifiers

Fill identifiers only after checking the applicable official dashboard. Keep secret values in a password manager/credential vault; record only whether they have been secured. Avoid unnecessary personal details.

| Item | Owner role | Current status | Non-secret identifier / evidence |
|---|---|---|---|
| Bodhinox Chat legal operator | Product owner | Unconfirmed | Not supplied |
| Pilot business / merchant | Tenant owner | Unconfirmed | Not supplied |
| Business contact and support access | Platform owner | Unconfirmed | Not supplied |
| Domain and public policy pages | Platform owner | Not started | No verified URLs |
| Meta business portfolio | Platform owner | Not started | Portfolio ID not supplied |
| Bodhinox Chat Meta developer app | Platform owner | Not started | App ID not supplied |
| Meta-provided WhatsApp test sender | Integration owner | Not started | Test account / Phone Number ID not supplied |
| Existing WhatsApp Business app number | Tenant owner | User reported | Number intentionally omitted |
| Existing-number provider / billing relationships | Tenant owner | Unconfirmed | Not inspected |
| Real WhatsApp messaging account / WABA | Tenant owner | Unconfirmed | Messaging account / WABA ID not supplied |
| Real API Phone Number ID | Tenant owner | Unconfirmed | Not connected |
| Embedded Signup v4 configuration | Integration owner | Not started | Configuration ID not supplied |
| Meta business verification | Platform owner | Not started | No approval evidence |
| Tech Provider / selected partner route | Platform owner | Unconfirmed | Direct route recommended; no partner selected |
| WhatsApp permissions and App Review | Integration owner | Not started | No granted-access evidence |
| Coexistence eligibility and feature-impact review | Integration + tenant owners | Unconfirmed | No account-level check |
| WhatsApp account billing | Tenant + finance owners | Unconfirmed | Method/rates not inspected; do not record card details |
| Actual catalog eligibility | Tenant commerce + policy owners | Unconfirmed | Product classes/claims not supplied |
| Actual WFH business-model eligibility | Tenant + policy owners | Unconfirmed | Opportunity model not supplied |
| Facebook Page | Tenant owner | Unconfirmed | Page ID not supplied |
| Ad account | Tenant marketing owner | Unconfirmed | Ad Account ID not supplied |
| ads_read and Marketing API feature tier | Integration owner | Not started | No access/tier evidence |
| Professional Instagram account | Tenant owner | Unconfirmed | Route recommended: Instagram Login; account ID not supplied |
| Instagram customer permissions/review | Integration owner | Deferred to C | No granted-access evidence |
| Merchant gateway account | Tenant finance owner | Unconfirmed | Razorpay candidate; merchant ID not supplied |
| Gateway test credentials securely stored | Tenant finance + integration owners | Not started | Record yes/no and mode only |
| Gateway live activation and methods | Tenant finance owner | Not started | No activation/UPI/refund evidence |
| SaaS subscription merchant | Platform finance owner | Deferred to C | Separate from tenant commerce |
| Meeting host / supplied link | Tenant session owner | Unconfirmed | No session/link supplied |
| Zoom automatic integration | Integration owner | Deferred to C | Own-account S2S vs customer OAuth decision pending |
| Courier account / supplied tracking | Tenant operations owner | Unconfirmed | No courier selected |
| Courier automatic integration | Integration owner | Deferred to C | Shiprocket candidate; sandbox/safe test arrangement unconfirmed |

## Actions you can do before development

- [ ] Identify the platform operator and pilot merchant owners.
- [ ] Secure owner accounts and prepare private provider document checklist.
- [ ] Prepare domain/contact/public-page content and plan publishing.
- [ ] Create the correct Meta business portfolio and confirm email/control.
- [ ] Complete Meta developer registration and create Bodhinox Chat's WhatsApp app.
- [ ] Send and receive a dashboard test message using Meta's test sender.
- [ ] Record the correct test App/Portfolio/WABA/Phone Number IDs without tokens.
- [ ] Check verification eligibility and begin the official business-verification flow when available.
- [ ] Inspect existing phone-app/provider ownership and coexistence eligibility with the selected route.
- [ ] Review coexistence feature impacts; retain the current account during preparation.
- [ ] Describe actual catalog product classes/claims and WFH model for eligibility review.
- [ ] Inventory Facebook Page, ad account and Instagram professional-account needs.
- [ ] Prepare the merchant's gateway Test Mode and private KYC checklist if that candidate is selected.
- [ ] Prepare actual meeting/session, invite, service schedule and manual fulfilment inputs for B.
- [ ] Record current message/gateway/partner/shipping cost terms when available.

## Actions needing a working backend or provider approval

- [ ] Publish and test actual HTTPS webhooks and OAuth redirects.
- [ ] Validate signatures, event deduplication, tenant binding and secret protection.
- [ ] Prepare/submit required permission-specific App Review evidence.
- [ ] Confirm actual granted permissions, Tech Provider/partner route and provider feature tiers.
- [ ] Implement Embedded Signup v4 and coexistence echo/history handling.
- [ ] Connect the real number only after immediate supported synchronization is ready.
- [ ] Test both manual phone-app and API messaging with correct human takeover.
- [ ] Approve and test the necessary templates/consent/windows/billing behavior.
- [ ] Test customer onboarding with an authorized second isolated business.
- [ ] Test read-only Ads reconciliation with a real authorized data basis.
- [ ] Verify gateway-supported test payments, invalid/repeated events and refund/reconciliation behavior.
- [ ] After merchant activation, complete an authorized controlled live payment/refund/settlement check.
- [ ] Keep pending/restricted integrations clearly disabled/labeled.
- [ ] Complete C Instagram, external Zoom and courier reviews/live evidence before launching those capabilities.

## Evidence log

Add one row per actual check. Record a redacted dashboard reference or private evidence location; do not paste credentials, customer chats or identity documents.

| Date | Asset/environment | Check performed | Result/status | Owner | Evidence reference / next action |
|---|---|---|---|---|---|
| 2026-10-13 | Planning only | Official provider requirements researched | Guide and capability matrix prepared; accounts unverified | Planning | See setup guide; no live test performed |

## Step 2 decision record

| Decision | Current disposition |
|---|---|
| Exact product name | Bodhinox Chat, locked in PRD v1.0 |
| Existing phone number | Preserve active business-app account; evaluate eligible coexistence |
| Development sender | Meta test sender first |
| Embedded Signup version | v4; recheck supported version at implementation |
| External customer onboarding | Own Tech Provider route recommended; approved partner route remains a evaluated alternative |
| Ad changes | Read-only B; mutations remain separately authorized D scope |
| Customer money | Each tenant's merchant account; platform subscriptions separate |
| Policy-sensitive journeys | Eligibility unconfirmed; no bypass through website/payment links |
| Meeting/fulfilment pilot | Supplied links and audited manual evidence supported |
| Step 2 completion | Research/setup guidance delivered; real account approval and live proof pending |
