# Bodhinox Chat — Step 2 integration setup guide

Prepared: 13 October 2026. Scope: planning and account preparation; no application development or external account changes performed.

Starting point supplied by the product owner: starting from zero, with an existing WhatsApp Business app number for the pilot. The account has not been inspected. Its eligibility, owner, business category, current provider connections and Meta approvals remain unconfirmed.

Read with the [locked PRD v1.0](../superpowers/specs/2026-10-13-bodhinox-chat-product-requirements.md), [capability matrix](bodhinox-chat-integration-capability-matrix.csv), and [setup tracker](2026-10-13-bodhinox-chat-integration-setup-tracker.md).

## 1. Understand what we are connecting

| Term | Plain meaning |
|---|---|
| Meta business portfolio | The business container holding assets and access permissions. Older screens may call it Business Manager. |
| Meta developer app | The registered integration called Bodhinox Chat. It is separate from the WhatsApp phone app and from our future SaaS application. |
| Messaging account / WABA | The WhatsApp business messaging account. Meta currently uses Messaging account terminology; integrations still return identifiers such as `waba_id`. |
| Phone number ID | Meta's identifier for a connected sender; different from its actual phone number and the WABA ID. |
| Cloud API | Meta's official interface through which our server sends and receives WhatsApp messages. |
| Coexistence | An eligible existing WhatsApp Business app number connected to Cloud API while retaining supported phone-app use. |
| Embedded Signup | The official connection flow through which a business authorizes its WhatsApp assets. |
| Tech Provider | The platform route through which Bodhinox Chat can onboard other businesses into WhatsApp. |
| OAuth | A provider's permission screen that allows a business to connect its account without giving us its login password. |
| Webhook | An automatic notification sent by a provider to our server, such as a new message or captured payment. |
| Business verification | Meta checking the legal business and its connection to the applicant. It is separate from reviewing app permissions. |
| App Review / Advanced Access | Approval for particular capabilities, especially access to unrelated customers' assets. |
| Test / live | A test proves only the tested environment. Live requires the correct real account, authorization, billing and production evidence. |

There are two ownership tracks. The company operating Bodhinox Chat owns the developer app, platform portfolio, domain and SaaS subscription merchant account. Each customer business owns its own WhatsApp, Instagram, ad, customer-payment, meeting and shipping assets. Customers grant scoped access; their assets and customer funds are not transferred into the platform owner's portfolio. If the same company runs the first pilot business, record both roles explicitly.

## 2. Recommended connection decisions

1. Use official WhatsApp Cloud API and Embedded Signup **v4**. Meta's current documentation says v2/v3 retire on **15 October 2026**, two days after this guide's date. Recheck supported versions before implementation; avoid tutorials built around v2/v3. [Meta Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4).
2. For your existing business-app number, try the official **coexistence** route after eligibility and technical readiness are confirmed. Keep the current phone account active during preparation. Do not delete it or run ordinary Cloud API registration against it now. [Meta coexistence onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).
3. Develop initially using Meta's provided test sender. An existing personal/business WhatsApp number can be an authorized test recipient without becoming the API sender.
4. Work toward Bodhinox Chat's own Tech Provider onboarding for the multi-tenant product. An approved Solution Partner that explicitly supports coexistence is a possible pilot accelerator, but no partner is selected. Compare webhook access, asset ownership, exports, portability, fees and compatibility with our future direct adapter before contracting.
5. Keep Meta Ads read-only for B; prepare Instagram for C. Use audited manual meeting links and fulfilment for B; add provider automation in C.
6. Razorpay, Zoom and Shiprocket are setup examples/candidates. They are not an approved commercial purchase or a change to the locked requirement that each tenant receives its own commerce funds.

## 3. Step-by-step setup

### Step 2.1 — Prepare identities, documents and account security

**You can do this now.**

1. Identify the real legal operator of Bodhinox Chat and the real pilot merchant. The product brand is **Bodhinox Chat**; legal-name fields must match the applicable business records, even if the brand differs.
2. Prepare a business contact email you control, a support contact, business address, phone and website/domain information. Choose an owner responsible for provider notices and billing.
3. Gather the documents each provider actually requests for your business type. Keep identity/PAN, registration, address and bank documents in a private location; submit them only inside the provider's official flow. GST details are supplied where applicable rather than invented.
4. Enable two-factor authentication on the account owners. Store credentials and recovery information in a password manager. Add a second authorized administrator where appropriate, with individual access rather than a shared personal password.
5. Record ownership and setup status in the tracker. Do not put passwords, app secrets, tokens, bank details or identity documents into that file or this chat.

**Evidence:** identified owners, controlled contact email, private document checklist and secured accounts. Actual account verification remains pending.

### Step 2.2 — Prepare a domain and public business pages

**Prepare the content now; publish when you have a chosen domain and hosting.** No domain has been checked, purchased or published here.

Prepare a simple public website with the product name, real operating business identity, contact/support details and an honest description. It does not need the complete SaaS application. Prepare privacy, terms, support and data-deletion instructions. The privacy notice must cover customer conversations, business integrations, payments, sharing, retention, disconnecting accounts and deletion requests as applicable.

For the pilot merchant's paid services/products, also prepare the actual catalog/service descriptions, cancellation/refund, shipping/returns and merchant contact pages required by its gateway and business model. Platform legal pages and merchant checkout disclosures serve different owners.

Illustrative paths only: `/privacy`, `/terms`, `/support`, `/data-deletion`; merchant paths might include `/refunds` and `/shipping`. There are no verified live URLs yet. App callback URLs will be chosen in architecture and configured only when functioning HTTPS endpoints exist.

**Evidence:** owned domain when acquired, working contact email, accessible required pages. Publishing a website does not establish WhatsApp product-policy eligibility or gateway approval. [Meta Tech Provider prerequisites](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers), [Razorpay API-key prerequisites](https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/).

### Step 2.3 — Create the platform's Meta business portfolio

**You can do this now.**

1. Sign in using your authentic authorized Facebook profile at [Meta Business Suite](https://business.facebook.com/).
2. Open the portfolio dropdown near the upper left and select **Create a business portfolio**.
3. Enter the business-facing name, your real name and controlled business email; confirm the email.
4. Open [Business settings](https://business.facebook.com/latest/settings) and check the legal business information, people/access and security settings. Record the **Business Portfolio ID**.
5. Add a Facebook Page owned by the applicable business if needed for its presence and Click-to-WhatsApp advertising. Add existing assets only when that business owns them. For other customer businesses, use authorized partner/OAuth access rather than claiming ownership.

**Evidence:** the correct portfolio is visible, you have full control, email is confirmed and its ID is recorded. An ad account, verified business, Instagram integration and WhatsApp approval are separate steps. [Official portfolio creation guide](https://www.facebook.com/business/help/1710077379203657).

### Step 2.4 — Register as a Meta developer and create Bodhinox Chat's app

**You can do this now.**

1. Complete [Meta developer registration](https://developers.facebook.com/async/registration/) with the authorized profile.
2. Open the [App dashboard](https://developers.facebook.com/apps) and choose **Create App**.
3. Enter **Bodhinox Chat** as the app name and the controlled contact email.
4. Select the current WhatsApp use case, **Connect with customers through WhatsApp**. Select the platform portfolio and follow the dashboard's requirements.
5. Record the **Meta App ID**. Add the appropriate icon/category and public privacy/support details when ready.
6. Keep initial work limited to your own authorized development assets. Being able to create the app does not authorize arbitrary customer businesses.

Meta screens can vary by account. If the named option is absent, record the displayed requirement instead of selecting unrelated permissions to force the flow. [Current Meta WhatsApp getting-started guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started).

### Step 2.5 — Send a first message using Meta's test sender

**You can do this now once the developer app exists.** This dashboard test does not require building Bodhinox Chat.

1. In the WhatsApp use case, open **Customize use case → Connect on WhatsApp → Quickstart**.
2. Choose **Start using the API** to reach **API Setup**.
3. Use Meta's provided test sender/account. Record the test messaging-account/WABA ID and test Phone Number ID separately.
4. Add a consenting test recipient under **To**, complete the displayed recipient verification and generate the dashboard's temporary access token when needed.
5. Use **Send message** to send the provided test template. Confirm that the recipient actually receives it and can reply.
6. Record the test date and result. Keep the token private; it is temporary and not a production credential.

**Do not register your existing WhatsApp Business number as the sender here.** Receiving a test message on that number does not alter its current registration.

**Evidence:** an actual received test message. Receiving a reply on the phone is not proof that our future CRM ingests it; the server webhook is a later development check. [Meta test-message setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started).

### Step 2.6 — Assess your existing number for coexistence

**Inspect and plan now; complete the connection later.**

1. Update the WhatsApp Business app to a current supported version. Confirm the real business owns the number and can access the app/required verification mechanisms.
2. Record whether the number already has another provider/platform connection or credit-line relationship. Resolve any existing-provider constraint through the provider's supported process.
3. Confirm that the chosen Tech Provider/Solution Partner route supports coexistence for this business, country and account. Availability in documentation is not proof that your particular number qualifies.
4. Review the actual feature changes with staff before connecting. Current Meta documentation describes limits on broadcasting, linked devices and certain app message features. Existing broadcast lists become read-only; linked devices are unlinked and must be reconnected where supported. Groups and app catalogs/labels do not automatically become CRM records.
5. Plan how existing chat data will be handled. Supported one-to-one history can be synchronized subject to the official limits and consent; complete app history and group history are not guaranteed imports.
6. Wait until the webhook, v4 connection flow, secure token handling, app-message echo handling and history synchronization are working before onboarding the real number. Meta requires the supported history/contact synchronization within its **24-hour onboarding window**; do not open that window before we can process it.
7. In the supported connection flow, follow the app confirmation/QR instructions shown. Coexistence onboarding already registers the number; the developer must skip ordinary additional phone registration.
8. Prove that supported manual phone replies and API messages both reach the intended conversation and do not cause the bot to answer over a staff member.

If coexistence is unavailable, use Meta's test sender or a separate dedicated development number while investigating. Migrating the current number is a separate operational decision requiring its own history, feature-impact and downtime plan.

**Evidence:** account eligibility observed, staff accept the documented impacts, connection confirmed, supported data sync and manual-reply handling tested. [Meta coexistence requirements and behavior](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).

### Step 2.7 — Start business verification and map customer-onboarding approval

**Start administrative preparation now; submit app demonstrations when the required evidence exists.**

1. Open [Meta Security Center](https://business.facebook.com/settings/security) for the correct portfolio. Start verification when Meta makes the business eligible or directs you through the WhatsApp Tech Provider use case.
2. Enter legal name, address, phone and HTTPS website that match the real business records. Complete the connection check and submit the accepted documents/method offered for your business.
3. If **Start verification** is unavailable, check the dashboard's eligibility requirements and use-case onboarding. Record the requirement; approval cannot be assumed or obtained by buying the Meta Verified badge.
4. In the WhatsApp use case's **Tech Provider onboarding**, follow the dashboard checklist. Meta currently requires business verification before this route's App Review.
5. Prepare Advanced Access requests for `whatsapp_business_messaging` and `whatsapp_business_management`, with the required message-send/receipt and template-management demonstrations. Follow the reviewer instructions; Meta documents dashboard/API Setup demonstration options for these use cases, so a finished SaaS is not always necessary for the first evidence.
6. When developing customer connection, create the appropriate **Facebook Login for Business → Configurations → Embedded Signup** configuration using v4 and the necessary Cloud API product. Record its configuration ID. Do not select ad-creation products merely to obtain read-only reporting.
7. Configure the actual approved domains/redirects, webhook subscriptions, account subscription and token lifecycle when the backend exists. Select `business_management` only where the chosen API/onboarding route requires it.

Verification, App Review, permission access, customer asset authorization and number/template eligibility are separate gates. App “Live” mode alone does not satisfy them. There is no committed approval date.

**Evidence:** actual provider confirmation and permission status, plus successful onboarding of an authorized second business before declaring multi-tenant onboarding live. [Business verification](https://www.facebook.com/business/help/2058515294227817), [Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers), [Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4).

### Step 2.8 — Review messaging, product eligibility and WhatsApp billing

**Review now; apply provider decisions before live use.**

Collect permission for the actual communications and provide opt-out handling. A customer message normally opens/resets a **24-hour customer-service window** for non-template replies. Reminders and other messages sent later require the eligible approved template and current consent. Prepare welcome, appointment/session confirmation, reminder, order/payment status and feedback template content; final classification and approval belong to Meta. Promotional content must not be disguised as transactional content.

The actual Ayurvedic catalog and WFH model are unconfirmed. Review product classifications, claims, licensing and the business model against current policies before enabling those journeys. WhatsApp restrictions include medical/healthcare goods and multi-level marketing. Limited regulated-vertical messaging exceptions, including qualifying OTC promotion in India, do not authorize commerce for those regulated products. A web store or payment link cannot be used to bypass restrictions. An ordinary employment/training journey must be assessed on its actual behavior, not assumed to be MLM because of its label.

Prepare a WhatsApp billing method for the actual messaging account/route and document who pays Meta and any partner. As of **1 October 2026**, Meta's published pricing includes a monthly free tier of **1,000 service messages per business phone number**, then charges apply, with defined exceptions. Do not budget on the older assumption that every service reply is free. Rate/category/market and any partner fee must be checked at activation. Platform SaaS charges and merchant payment-gateway charges are separate costs.

**Evidence:** an eligibility decision for actual products/WFH content, approved templates, required consent, functioning billing and a recorded current cost basis. [WhatsApp Business Policy](https://whatsappbusiness.com/policy/), [Current WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).

### Step 2.9 — Prepare Facebook assets and read-only ad reporting

**Inventory/create necessary owned assets now; reporting authorization and proof later.**

1. Identify the pilot business's Facebook Page and ad account. If none exist, create the applicable owned business assets through Business settings; have the owner choose billing currency/timezone carefully.
2. Record Page ID, Ad Account ID, owner and permission status. Do not create a paid campaign just to complete this checklist.
3. Plan reporting with `ads_read` and the **Marketing API Access Tier** feature. Permissions' Standard/Advanced Access and the Marketing API's Limited/Full Access tiers are separate concepts.
4. For customer accounts, satisfy required Advanced Access and production feature-tier criteria shown in the dashboard. Limited development access does not prove production suitability. Do not manufacture API traffic to satisfy upgrade requirements.
5. Later compare an authorized real account's spend/campaign metrics with Ads Manager for the same dates, currency, timezone and attribution/reporting basis. A new account with zero data proves access only, not spend reconciliation or conversion attribution.

B does not request `ads_management` for campaign changes. Campaign/budget mutations remain separately authorized D scope. Phase 10 (click-to-WhatsApp ads, November 2026) follows this: it reads insights, leads and sends Conversions API events, and ad creation stays out of scope; the Ads page links to Ads Manager instead. Its Login for Business configuration and Page webhook steps are in the [Railway runbook](../deployment/railway.md). [Meta Marketing API authorization and feature tiers](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization).

### Step 2.10 — Prepare Instagram for Release C

**Account preparation can happen now; implement after the WhatsApp pilot foundation.**

1. Create or identify the business's Instagram account and make it an eligible professional Business/Creator account. Verify owner access and business contact settings.
2. Recommended messaging route: **Instagram API with Instagram Login**. This route does not require a linked Facebook Page. A Page can still be useful for other Meta business/advertising functions.
3. If Facebook Login is selected instead, that route requires the professional Instagram account to be linked to a Facebook Page. Document the selected route; don't mix the two routes' scopes, identifiers or API hosts.
4. For the recommended route, messaging needs `instagram_business_basic` and `instagram_business_manage_messages`. Add comment permission only for the reviewed comment/private-reply features; avoid publishing permissions without a product need.
5. Prepare external-customer Advanced Access, App Review, webhook and token-refresh/revocation handling. Later test user-initiated messaging and eligible comment/private-reply behavior against the current rules. Human-agent exceptions are not permission for automated follow-ups.

**Evidence:** actual connected professional account, required permissions, working inbound/outbound events and reviewed restrictions; account creation alone is preparation. [Instagram route comparison](https://developers.facebook.com/documentation/instagram-platform/overview), [Instagram Login Messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api).

### Step 2.11 — Prepare the pilot merchant's payment gateway

**Test-account setup can happen now; live activation follows merchant and website review.** Razorpay is a candidate, not a locked vendor.

1. Open the candidate's [official setup guide](https://razorpay.com/docs/payments/set-up/) and sign up with the pilot merchant's controlled email/mobile.
2. Enter its actual business type and legal/merchant information. Supply requested identity, bank and business evidence through the provider. Supply GST details where applicable; do not create fictitious registration data.
3. Explore **Test Mode**. In Razorpay, **Account & Settings → API Keys → Generate Key** provides test credentials when prerequisites are met. Save secrets securely and record only the existence/mode in the tracker.
4. Prepare the merchant's genuine website/app, service/product descriptions, support and cancellation/refund/shipping disclosures. Live keys require the relevant activation and website/app verification.
5. The developer later implements order/payment binding, gateway-supported test checkout, signed webhooks, amount/currency/merchant verification, duplicate protection, reconciliation and refunds. A browser success screen is not sufficient payment evidence.
6. After activation, use the enabled live UPI/payment methods for a controlled payment/refund check with the merchant's authorization. Confirm settlement and refund outcomes against the merchant dashboard.

Each tenant's commerce payment must reach that tenant's merchant account. For the SaaS, validate the gateway's supported merchant-connection authorization model before offering self-service connections; platform test keys do not authorize other merchants. Bodhinox Chat's own subscription merchant configuration is a separate C workstream. [Razorpay setup](https://razorpay.com/docs/payments/set-up/), [API-key prerequisites and modes](https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/).

### Step 2.12 — Prepare meetings, group invitations and shipping

**Use the approved manual pilot path first.**

- **Meetings:** identify the session/consultation host and create an appropriate meeting link in its authorized account. Staff enter the actual link and attendance evidence for B. In C, Zoom is a candidate: its Server-to-Server OAuth app is for the account owner's internal integration; an external customer connection needs the appropriate user/account OAuth distribution route and review. For an internal Zoom adapter, Marketplace → Developers → Build an app → Server-to-Server OAuth; add only required scopes and activate when its backend is ready. [Zoom internal app setup](https://developers.zoom.us/docs/internal-apps/create/), [external distribution](https://developers.zoom.us/docs/distribute/).
- **WhatsApp groups:** staff can supply an authorized ordinary invitation link. Invitation sent is not evidence of joining. Meta now has a Groups API, but current documentation excludes WhatsApp Business app/coexistence numbers and imposes separate eligibility including Official Business Account requirements. Do not plan automatic group/member tracking for this existing-number pilot. [Meta Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups).
- **Shipping:** staff record real dispatch/tracking/delivery evidence for B. For C, evaluate a courier such as Shiprocket, including merchant eligibility, pickup addresses, serviceability, packaging/weights, fees and tracking support. Its official setup describes **Settings → API → Configure → Create an API User**. Give that user only needed access and keep credentials private. Production API requests can affect real account data; confirm any sandbox or safe test arrangement before creating shipments. [Shiprocket developer setup](https://www.shiprocket.in/developers/), [Shiprocket API and live-data warning](https://apidocs.shiprocket.in/?version=latest).
- **Implemented in Phase 9 (provider-gated, both off by default):** Zoom uses one General (user-managed OAuth) app with PKCE, connected per workspace by an admin; the deployment needs `ZOOM_ENABLED=true`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` and `ZOOM_WEBHOOK_SECRET_TOKEN`, redirect `<APP_URL>/api/integrations/zoom/callback` and event endpoint `<APP_URL>/api/integrations/zoom/webhook` (see the [Railway runbook](../deployment/railway.md)). Shiprocket uses each workspace's own API user (Settings → Meetings & shipping), adhoc order create, AWB assignment, pickup request, label, cancel before pickup, tracking by AWB, and a webhook with a per-workspace token stored only as a digest; `SHIPROCKET_DISABLED=true` stops every call. Scope names, response shapes and the public tracking URL are coded defensively and listed as unconfirmed in the runbook; confirm them before a live pilot.

### Step 2.13 — Prepare the remaining C and architecture-dependent services

**Prepare owners and decisions now; obtain credentials when the service is selected.**

For Meta lead forms in C, inventory the relevant Page/forms and who has access to lead data. Meta's current leadgen webhook guide lists additional permissions including `leads_retrieval` and, for that documented route, `ads_management` alongside Page permissions. This is separate from B's read-only ad reporting. If the approved C lead-retrieval route needs a broader provider scope, Bodhinox Chat must still deny ad mutations outside the separately authorized D functionality. Later prove Page subscription, authorized lead retrieval and duplicate prevention. [Official Meta leadgen setup](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration).

For AI assistance in C, no vendor/model is selected. Architecture must evaluate account/project setup, API eligibility, data retention/sharing, region, costs, usage controls and the product's healthcare/tenant-isolation requirements before connecting real conversations. Keep AI disabled until the selected provider and evaluation requirements are met; human-reviewed assistance is the locked initial behavior.

Hosting, database, storage, queues, authentication and transactional email are selected during architecture. Prepare the domain, controlled sender/contact and budget inputs now. We will verify the selected vendors' current prerequisites then. No hosting subscription, AI API key, email service or database has been provisioned by this planning work.

### Step 2.14 — Hand the developer a readiness packet, not passwords in a document

**Prepare non-secret facts now. Implement endpoints in the development phase.**

The packet should contain asset owner, relevant non-secret IDs, selected routes, required permission/approval states, environment, cost basis, policy decision, and contact responsible for failures. Store secret values in the appropriate secure vault/environment when needed.

The developer must implement and validate:

1. Public HTTPS webhook endpoints and provider-specific verification/signature checks; acknowledge promptly and process through reliable queues.
2. Authorized OAuth redirects/state, asset-to-tenant binding, token exchange/refresh, disconnect/revoke and reconnection.
3. For WhatsApp coexistence, message/account events and `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` as required by the selected flow; prevent repeated bot replies when staff reply from the phone.
4. For production Meta credentials, authorized system-user/business permissions or the correct customer-onboarding token model for the route. Temporary test tokens are not production configuration; even long-lived tokens can be revoked.
5. Separate test/staging/live credentials and ownership records. Do not put secrets into browser code, logs, CSVs, screenshots or Git.
6. Observable states: not configured, test connected, awaiting verification/review, approved, live verified, disconnected and failed. Show actual evidence rather than inferring approval from a successful test sender.
7. Provider limits, template/windows/consent checks at send time, retry/backoff, duplicate/out-of-order handling, billing visibility and outage recovery.

Architecture will choose the actual URLs and contracts. Entering a invented callback URL in a provider dashboard now does not complete webhook setup.

### Step 2.15 — Track account feasibility and later live-readiness gates

The research and setup plan are prepared. Actual account feasibility remains pending where owner evidence is absent. Architecture can proceed with documented routes and blockers while account preparation and reviews continue; the checks below are required before the affected capabilities are declared live, rather than all being prerequisites to start architecture:

| Check | Required evidence |
|---|---|
| Platform identity | Correct portfolio/app owners, controlled domain/contact and required public pages |
| Meta test | Received test message; then verified CRM ingestion when the backend exists |
| Existing number | Coexistence eligibility, accepted feature impacts, successful connection and supported app/API synchronization |
| Customer onboarding | Required Tech Provider/partner approvals and authorized isolated second-business connection |
| Business policy | Real catalog/WFH review and permitted enabled journeys |
| Messaging | Approved templates, opt-in/opt-out, window enforcement, app/manual takeover and current billing |
| Ads B | Authorized read access, production tier readiness and reconciled real metrics or explicitly unavailable data |
| Payments B | Eligible tenant merchant, verified test outcomes, live UPI/payment/refund and reconciliation proof |
| Meetings/fulfilment B | Valid supplied links and staff evidence with accurate labels |
| Instagram/automatic providers C | Account-specific permissions, review and live tests before those features launch |
| Operations | Secure credentials, disconnection, expired/revoked access, retries and cross-tenant isolation tested |

## 4. What to do first

Work in this order: prepare owners/contact/documents → create the Meta portfolio → register/create the WhatsApp developer app → send a Meta test message → prepare public pages/business verification → confirm coexistence/Tech Provider route → prepare the pilot merchant's gateway Test Mode. Prepare the remaining provider accounts according to release needs.

Do not attempt to activate every integration in one sitting. Meta test messaging and payment Test Mode let us make progress while verification and later development are pending. Optional Zoom/courier API credentials, paid ads and full Instagram integration are not prerequisites for the first test message.

## 5. Sources and freshness

Official pages were consulted on 13 October 2026. Dashboard availability and eligibility must still be checked in the user's accounts. Product-policy classification, gateway commercial terms, partner fees and final live rates are unconfirmed; no approval, purchase or processing of live money was performed.

Key change-sensitive source dates observed: WhatsApp pricing updated 30 September 2026 with changes effective 1 October; Embedded Signup v4 updated 3 September 2026; Instagram overview/messaging updated 28 September 2026; WhatsApp Business Policy updated 23 September 2026. Recheck these before implementing or activating integrations.

The Firecrawl fetch of the dynamic Shiprocket API page returned a loading shell; its setup/live-data guidance was confirmed through official developer documentation and search-index excerpts of the official API page. No private dashboard was inspected. This guide documents research-supported feasibility, not a completed integration test.
