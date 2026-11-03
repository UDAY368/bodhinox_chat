# Bodhinox Chat: user guide

This guide describes the application as implemented in this repository on 15 October 2026. It distinguishes features visible in the application from connections that still need credentials and live testing. Bodhinox Chat uses the **official Meta WhatsApp Cloud API**. WasenderAPI is not connected.

## 1. What works today, and what is still required

| Item | Current state | What you can do |
| --- | --- | --- |
| Login | Implemented with password, JWT sessions, and optional TOTP/recovery code | Sign in with an **existing verified** account |
| Create account | `/signup` exists, creates an owner workspace, and requires email verification | Resend SMTP is configured for local development and Railway production with `no-reply@bodhinox.com`. Complete a real signup/delivery test before onboarding users. |
| Invite a teammate | Settings → Team members offers one-time invitation links | An existing verified user can accept; a new user first needs working signup/email verification. Copy the link when created; it is not displayed again. |
| CRM, flows, automations, AI settings | Screens and backend are implemented | Configure in an authenticated workspace; actual WhatsApp/AI delivery needs the providers and worker |
| WhatsApp | Official Cloud API integration is implemented | Needs a Meta app, token, WABA/phone-number IDs, public HTTPS webhook, `META_APP_SECRET`, and an end-to-end test |
| AI | OpenAI, Anthropic, or an OpenAI-compatible provider can be configured | Needs a provider key and an explicit test before enabling automatic replies |
| Background jobs | Dedicated worker implemented | Run `npm run worker` alongside the web app for incoming events, broadcasts, scheduled/delayed work, and webhook deliveries |
| Production | Railway web and worker report successful online deployments | Resend SMTP is configured on the web service; verify HTTP health and the full signup flow before onboarding real users |

The earlier local preview used an **isolated synthetic test account**, not a production owner account. Do not use its data or credentials for your real workspace. Check that a local server is running before opening `http://localhost:3001`; it is not guaranteed to remain running between sessions.

## 2. Start locally and create the first real account

1. Follow the [README local setup](../README.md) to install Node.js 24.11+ and dependencies, populate `.env.local` from `.env.local.example`, and configure the constrained Railway PostgreSQL role URLs. Do not put passwords, tokens, or signing keys in Git or browser code.
2. Set `APP_URL`, `NEXT_PUBLIC_SITE_URL`, and `AUTH_JWT_ISSUER` to the exact local origin you use (`http://localhost:3000` by default, or `http://localhost:3001` if running on port 3001). Use the same origin in verification links.
3. Keep `SMTP_URL` and `AUTH_EMAIL_FROM` in the ignored `.env.local` for local development and in the Railway web service environment for production. The current setup uses Resend SMTP and `no-reply@bodhinox.com`. **Railway disables outbound SMTP on Free, Trial and Hobby plans**, so those deployments require an HTTPS email-API adapter before real signup can work. Railway Pro can use SMTP. See [Railway's outbound networking policy](https://docs.railway.com/networking/outbound-networking).
4. In one terminal, run `npm run dev` (or `npm run dev -- --port 3001`). In another, run `npm run worker`. Open the matching local URL. A database connection and migrations must already be in place.
5. Go to `/signup`, enter full name, email, and a password of at least 12 characters. The application creates your owner workspace and emails a 24-hour verification link. Follow it, then sign in at `/login` with email and password. If privileged MFA is required, complete `/mfa` and save recovery codes securely.
6. An existing verified user goes straight to `/login`; use **Forgot password** only after SMTP is working. Your session uses JWT access and rotating refresh cookies; the UI does not require you to copy a token.

For a new Railway production workspace, deploy and verify the web/worker first, configure a working email delivery method for your Railway plan and the exact production `APP_URL`, then sign up through the **production** `/signup`. The isolated preview owner is not a production account. The deployment sequence and current approval state are in the [Railway runbook](deployment/railway.md).

### Email delivery choices

- **Local development, free and open source:** [Mailpit](https://mailpit.axllent.org/docs/install/docker/) captures mail on your own computer. With Docker installed, run `docker run --rm --name bodhinox-mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit`. Set `SMTP_URL=smtp://127.0.0.1:1025` and `AUTH_EMAIL_FROM=Bodhinox Chat <no-reply@example.test>` in `.env.local`, restart Next.js, then inspect the verification email at `http://localhost:8025`. Mailpit does **not** deliver mail to real inboxes; use it only for local testing.
- **Railway Pro:** the current deployment uses Resend SMTP and `Bodhinox Chat <no-reply@bodhinox.com>`. Both `bodhinox.com` and `bodhinox.in` are verified in Resend, but the app currently has one `AUTH_EMAIL_FROM` sender. Keep the real SMTP URL/key only in Railway's web-service variables or local ignored environment files. Railway says SMTP is available only on Pro and above. Follow the [Railway Pro SMTP setup](deployment/smtp-on-railway.md).
- **Railway Free/Trial/Hobby:** use a provider's **HTTPS email API**, not SMTP. [Resend's free tier](https://resend.com/pricing) currently lists 3,000 transactional emails per month, capped at 100 per day; [Brevo's free tier](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans) lists 300 emails per day. This repository **does not yet have an HTTPS email adapter**, so adding a provider API key alone will not enable signup. The application email-sending code must be extended, deployed, and tested first. Provider limits and terms can change.
- **Self-hosted production mail:** [Docker Mailserver](https://docker-mailserver.github.io/docker-mailserver/latest/) is an open-source SMTP/IMAP stack. It needs a suitable server/network, domain/DNS records, TLS, SPF/DKIM/DMARC, anti-abuse controls, monitoring and backup. It does not bypass Railway's outbound SMTP restriction on the non-Pro plans. It is more operational work than the small amount of account email this app currently sends.

## 3. Find your way around the application

| Page | Purpose | First useful action |
| --- | --- | --- |
| Dashboard `/dashboard` | Conversation, contact, message and deal overview | Review activity after adding data |
| Inbox `/inbox` | Read/reply, assign conversations, mark unread/status, use media/templates and human handoff | Open an incoming conversation; assign it to a teammate |
| Notifications `/notifications` | Work alerts | Review new items; enable browser notifications if desired |
| Contacts `/contacts` | Customer records, CSV import, search, tags and custom fields | Add one test contact with an authorized phone number |
| Pipelines `/pipelines` | Sales stages, deal cards, values and analytics | Add a deal linked to that contact |
| Broadcasts `/broadcasts` | Template campaign wizard, delivery status and retries | Start with one opted-in test recipient |
| Automations `/automations` | Event/keyword/schedule rules and logs | Clone a starter automation, then review its steps |
| Flows `/flows` | Multi-step conversation journeys and run history | Clone Welcome menu or build a keyword flow |
| Agents `/agents` | **AI** Setup, Playground, and Usage | Test a provider before enabling auto-reply |
| Settings `/settings` | Profile/security, WhatsApp, templates, tags/fields, deals/currency, team, API keys | Configure owner security and WhatsApp |

Owner and admin can manage account-wide settings and team members. Agent can work on operational records, messages, deals and workflows. Viewer is read-only. The **Team members** page is for human agents; the **Agents** page is for AI configuration. Owner-only operations include ownership transfer and account deletion. In production, privileged owner/admin access requires MFA.

## 4. Connect the official WhatsApp Cloud API

The browser app does not connect directly to WhatsApp. Meta sends events to Bodhinox's webhook; the server verifies them and stores work; the worker processes them. Bodhinox sends outbound messages through Meta's Cloud API.

1. In [Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started), create/select a business app with WhatsApp, a WhatsApp Business Account (WABA), and a sending phone number. Start with Meta's test sender and an authorized test recipient. Keep the **Phone number ID** and **WABA ID** distinct from the visible phone number.
2. Obtain an appropriate access token for the app/business and grant the required WhatsApp messaging/management permissions. Temporary dashboard tokens are suitable for initial testing, not long-term production operation. Store the Meta **App Secret** as `META_APP_SECRET` in the web service environment; it validates the `X-Hub-Signature-256` on incoming POSTs. Never put it in the WhatsApp settings form.
3. As an owner/admin, open **Settings → WhatsApp**. Enter **Phone Number ID**, **WABA ID**, **Access Token**, and a strong **Webhook Verify Token** that you choose. Supply the six-digit two-step PIN **only when required for registration of your real number**; do not invent one for Meta's test number. Save, then use **Test API Connection** and, where shown, **Verify with Meta**. The page reports whether the WABA app subscription is present.
4. After a publicly reachable HTTPS web deployment exists, copy the **Webhook URL** shown in Settings. It is `<your-app-origin>/api/whatsapp/webhook`. `localhost` cannot serve as Meta's production callback. In the Meta app's WhatsApp webhook settings, set this callback URL and the **exact same Verify Token** entered in Bodhinox; subscribe to the `messages` field. A successful GET challenge verifies the token. Receiving actual messages also requires the WABA/app subscription to be active.
5. Send a WhatsApp message from the authorized test recipient to the sender number. Check that it appears in **Inbox**. Reply from Inbox and confirm delivery on the recipient's phone. Test one delivery/read status update and a media message if you plan to use media. Verify the worker is running and inspect any job failure before treating the integration as live.
6. For an existing WhatsApp Business **app** number, first check Meta's current coexistence eligibility and onboarding route. Do not remove or register the current number just to try this app. The current settings form is credential-based; it is **not** a finished customer-facing Embedded Signup/coexistence wizard. Multi-tenant customer onboarding remains later product work. See the [integration setup guide](integrations/2026-10-13-bodhinox-chat-integration-setup-guide.md).

Meta's [Cloud API documentation](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) describes the Meta-owned sender, WABA, access-token model and API examples. Meta's [webhook setup guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/cloud-api/webhooks) covers public callbacks and field subscriptions. Review Meta's current policies, customer opt-in, template approval, sender limits and pricing for your business before a real campaign. A free-form reply is normally tied to an open customer-service window; business-initiated/out-of-window sends need an approved template.

**If connection testing works but Inbox stays empty:** verify public HTTPS reachability, the exact verify token, `META_APP_SECRET`, `messages` subscription, WABA subscription, correct sender IDs, a running worker, and whether Meta is sending events for that app/number. A green token check alone does not prove inbound delivery.

## 5. Set up contacts, team and a sales pipeline

1. In **Settings → Fields & tags**, create `New lead`, `Qualified`, and `Follow-up`. Add any custom fields you need, such as `Product interest`.
2. In **Contacts**, add one test contact (for example, *Asha Rao*) with the correct country-code phone number. Add `New lead`; optionally import a small, consented CSV. Search and phone identity matching help prevent duplicate records.
3. In **Pipelines**, the first workspace can seed a default pipeline with **New lead → Qualified → Proposal sent → Negotiation → Won**. Owner/admin can use pipeline settings to rename, add, reorder or remove empty stages. Choose a currency in **Settings → Deals & currency**.
4. Choose **Add Deal**, for example `Asha — Annual plan`, value `₹25,000`, link Asha's contact, select **New lead**, assign an agent and add an expected close date. Move the deal across the board as sales work advances; open it to edit value, notes, outcome or linked conversation. Pipeline analytics summarize the board.
5. In **Settings → Team members**, create a one-time invitation link for an `agent`, `admin` or `viewer`; choose expiry (1, 7 or 30 days). Copy/share it immediately. The invitee must have a verified Bodhinox account. An agent can take the conversation, manually reply, and update the deal. Manual sending pauses bot/flow replies for that conversation until someone explicitly resumes automation.

## 6. Create a visual Flow

A **Flow** is a structured WhatsApp conversation with nodes and branches. It starts on a keyword, a contact's first inbound message, or a manual trigger. A Flow is different from an **Automation**, which is a general event rule with a sequence of actions.

1. Open **Flows → Create**, or clone a starter: **Welcome menu**, **FAQ bot**, or **Lead capture**. A new blank flow starts as a draft.
2. Give it a name and trigger. For example, set trigger **Keyword** to `pricing`.
3. In the builder, connect **Start → Send buttons** with the text `Which plan would you like?` and buttons `Basic` and `Enterprise`. Route each button to a different **Send message** node. Optionally add **Collect input** (`company_size`), **Condition**, **Set tag**, **Send media**, or **Handoff**, then an **End** node. Pick an entry node and configure fallback/timeout behavior in the builder.
4. Save and resolve issues in the validation panel, then **Activate**. Open **Runs** after testing to inspect what happened. Pause the flow when editing a live journey.
5. Test from a permitted phone: send `pricing`, tap a button and check the resulting messages, tag, run log and handoff. A human can take over in Inbox; bot sends should remain paused until explicitly resumed.

Example journey: `pricing` → buttons `Basic` / `Enterprise` → `Enterprise` asks for company size → adds `Qualified` tag → handoff to a human agent. Configure the exact nodes/links in the editor; this example is not preloaded as a complete production journey.

## 7. Create an Automation

An **Automation** runs when a trigger fires and performs steps. The builder supports message received, first inbound, keyword match, interactive reply, new contact, assigned conversation, added tag, and time-based triggers. Steps include message/buttons/list/template, add/remove tag, assign conversation, update contact field, create deal, wait, condition, signed outbound webhook, and close conversation. Scheduled/delayed work requires the worker.

1. Open **Automations → New**, or start from **Welcome message**, **Out of office**, **Lead qualifier**, or **Follow-up reminder**. Give the rule a clear name.
2. Example **Lead qualifier**: choose **Keyword match**, keywords `pricing` or `demo`, and a match mode. Add **Send message**: `Thanks for your interest. Which plan are you considering?`; optionally **Wait** 10 minutes; **Add tag** `Qualified`; **Create deal** in the sales pipeline; **Assign conversation** round-robin. Save and switch the rule **Active**.
3. Send a test keyword from a permitted phone. Confirm the message, contact tag, deal and assignment. Open the automation's **Logs** to inspect failures or partial outcomes. Pause the rule before changing it.
4. For an after-hours reply, clone **Out of office** and configure its time-of-day condition. For a periodic task, choose **Time based**, a five-field schedule/timezone, and an explicit contact audience if the actions affect contacts; use an approved template for recipients outside the service window.

Keep one active responder for a given trigger while testing. A Flow, Automation and AI auto-reply can all react to incoming messages; coordinate their triggers and handoff rules to avoid duplicate responses.

## 8. Configure AI Agents

The current **Agents** page configures an **account-level AI assistant**, not a gallery of independent named bots.

1. Open **Agents → Setup**. Choose OpenAI, Anthropic, or OpenAI-compatible; enter the model and API key (plus base URL for a compatible provider). Set a clear system prompt and, if using knowledge search, its embedding credential and knowledge documents.
2. Use **Test** to check the provider credentials, then **Save**. Open **Playground** and ask a sample customer question, for example `What is your annual plan?` Verify the draft against your approved business facts.
3. Start with human-reviewed drafts. Only then enable the **Active** and **Automatic replies** options if desired, set a per-conversation reply maximum, and choose a human handoff teammate/queue. Keep the worker and WhatsApp connection healthy. **Usage** is visible to owner/admin.
4. Example: add a knowledge document describing Basic and Enterprise plans. Asha asks `What is included in Enterprise?`; the AI may draft an answer for an agent to review. Automatic sending is a separate switch and should be enabled only after real test conversations and clear escalation rules.

No AI vendor credentials are preconfigured. The model can only answer accurately from material you provide and approve.

## 9. Templates and Broadcasts

1. In **Settings → Templates**, create a WhatsApp template with name, language, category, body and any variables/media, then submit it to Meta. You can also **Sync from Meta**. Wait for an **approved** status before using it for business-initiated or out-of-window sends.
2. In **Broadcasts → New**, choose an approved template. Select **All**, **Tags**, **Custom field**, or **CSV** audience, then exclude unsuitable tags and map template variables to static/contact/custom-field values. Start with one opted-in test contact and review the estimated reach.
3. Name and confirm the broadcast. Watch its detail page for recipient, delivery/read/reply state and retry controls. The current wizard labels its last stage **Schedule / Send**, but it **does not expose a future-date scheduler**; confirmation starts the send. Campaigns are limited to 1,000 recipients per campaign in this foundation.
4. Do not use broad audiences until Meta, opt-in, template variables, worker processing, and a one-recipient send have all passed on the real sender. An uncertain provider result must be reconciled before retrying to avoid duplicates.

## 9a. Click-to-WhatsApp ads

The **Ads** page (sidebar) collects what happens after someone taps a click-to-WhatsApp ad.

1. **Not enabled yet.** Until the platform's Meta app is approved for ads and an administrator turns ads on for the deployment, the Ads page and **Settings → Ads** say so. Nothing on these screens contacts Facebook while they are off. Conversations that customers start from your ads are still recorded from the WhatsApp messages themselves; they show as **Started from an ad** in **Analytics → Overview** under conversations by source.
2. **Connect (admins).** When ads are enabled, open **Settings → Ads**, choose **Connect with Facebook**, sign in, then pick one ad account and one Facebook Page for the workspace. The card lists any permission you did not grant and which feature it blocks. **Disconnect** stops lead delivery for the Page and removes the stored tokens.
3. **Ads tab.** Campaigns and ads with spend, clicks, conversations started (Meta's figure) and conversations that actually reached your inbox, plus purchases. **Retarget** opens the segment builder with a "clicked this ad" condition; save the segment and use it as a campaign audience. Opt-out and consent rules apply as for any campaign.
4. **Leads tab.** Leads from your Facebook lead forms, filterable by form, ad and date. A lead with a phone number is matched to an existing contact or creates one, but it is **not** opted in to WhatsApp: ask for consent in the lead form. **Broadcast to these leads** (agents and above) saves a lead-form segment and opens a new campaign with that segment already chosen as the audience. Admins can export the list as CSV (needs the contact export plan feature) and delete a lead when a person asks to be erased. Members whose phone numbers are masked see lead phone answers masked too.
5. **Conversions tab (admins).** Purchases (paid payment links and orders), lead-form submissions on WhatsApp and the **Conversion event** flow step (any event except Purchase, which is always reported from the order or payment link) are reported to Meta for customers who came from an ad in the last 7 days, once each, when the Conversions API is switched on for a WhatsApp number in Settings → Ads. If a send's outcome is unknown (for example a timeout), it waits under **Outcome unknown**: check Meta Events Manager and record whether it arrived. It is never re-sent automatically.
6. **Flows and automations.** The trigger **A customer messages you from an ad** starts a flow (or automation) when a message arrives from an ad, optionally only for listed ad IDs. A flow that is already running for that customer keeps running.

Creating or editing ads is done in Meta Ads Manager; Bodhinox does not create ads or spend budget.

## 9b. Appointments and booking pages

The **Appointments** page (sidebar) books consultations, confirms them on WhatsApp and follows up after the visit.

1. **Set up (admins).** Add **Locations** (each with its own time zone), **Services** (duration, buffer, capacity, price, in person or online with a meeting link, and the days it can be booked: the *Offline free consultation: Monday only* preset allows Mondays only, judged on the location's local date), and **Staff & hours** (weekly hours per practitioner and location). A service at a location is either a shared calendar or offered by named practitioners, not both. Add **Holidays & exceptions** for closed days or changed hours.
2. **Booking page.** Under **Booking pages**, choose a slug, the services, optionally a location and the WhatsApp number, and share the link `/book/<slug>`. Visitors choose a service, place, practitioner (or any available), a date and a time (always shown in the location's time zone), optionally their name, city and state, and get a code. The slot is held for 15 minutes; it becomes a booking when they send `BOOK <code>` to your WhatsApp number from their own phone. The page never asks for a phone number.
3. **Customer link.** Confirmed customers receive a link to their booking. It shows the service, practitioner, place, time and price (and the meeting link from 24 hours before an online visit), and lets them cancel or move the booking until the cutoff set in settings (default 2 hours before). It never shows their name or phone, so it is safe if forwarded.
4. **Reminders.** Sent 24 hours and 2 hours before the visit when the toggles are on; a reminder that would be late is skipped, never sent late, and a booking that was moved or cancelled never gets the old reminder. Outside the 24-hour WhatsApp window you need approved **Utility** templates in settings.
5. **After the visit.** Mark **Completed** or **No-show** (recorded by staff). A no-show creates a follow-up task; a completed visit can send a feedback message and creates a rebooking task when the service has those settings. Do not record clinical details in the staff note.
6. **Flows and automations.** The **Book appointment** flow step lets customers book inside a WhatsApp conversation; the triggers *Appointment booked / cancelled / rescheduled / completed / no-show* start automations.

**Paid consultations**: in Appointments → Services, set a price and turn on **Require advance payment** (needs Razorpay connected under Payments and a plan with the storefront). Customers booking online see "Pay in advance"; after they send the WhatsApp code they receive a payment link, and the booking is confirmed automatically once the payment is verified. Bookings you make yourself are confirmed straight away and are not charged online.

## 9c. Store, orders and payments

Commerce in the sidebar holds **Orders**, **Catalogue**, **Meta catalogue** (the products mirrored from your WhatsApp catalogue), **Payments** and **Store settings**.

### Catalogue

Commerce → Catalogue lists the products you sell. Admins add a product by name, then on its page fill in the
description, the disclosure (usage or regulatory notes shown with the product), the category, images (https links,
up to ten) and one or more variants. Each variant needs a SKU; add a price in your store currency (set the currency in
Store settings first), an optional tax rate (leave empty to use the store default), HSN code and weight. Untick
"Track stock" for made-to-order items. "Review and publish" makes the product available to storefront links and
records you as the reviewer; "Unpublish" takes it off the storefront, and "Archive" hides it for good while keeping past
orders intact.

Categories can be nested one level (for example Ayurveda → Oils).

The "Meta catalogue link" tab shows which variants match your WhatsApp (Meta) catalogue by SKU and content ID. You can
import Meta products you do not have yet as drafts; review their price before publishing.

### Inventory

The Inventory tab shows on hand, reserved (held for orders waiting for payment) and available stock. Use "Adjust
stock" to record received goods, write off damaged or expired units (a reason is required) or correct a count. If the
stock changed while the dialog was open, the change is refused and the list reloads, so check the count and try
again. Every change appears in the stock history with who made it. Agents can see stock; only admins whose role keeps
the "Adjust stock" permission can change it.

### Store settings

Commerce → Store settings holds the store currency, tax, how long a placed order holds stock while the customer pays,
the online checkout switch, the seller details printed on receipts, shipping rates and coupons. Only admins can change them.
The currency cannot change once any variant has a price. If no tax rate applies to an item, or no shipping rate covers an
address, checkout refuses rather than charging zero.

### Storefront links

In a conversation, open the composer menu and choose **Send storefront link**. Pick whether the link opens the store or the
customer's latest order and how long it stays valid, then send. The customer must have written in the last 24 hours. Only
that customer can use the link; it never shows their other orders or details, and sending a new store link replaces the old
one. The customer adds items, enters a delivery address, sees tax and shipping, and pays on a secure Razorpay page. Their
items are held for the store's hold time; an unpaid order expires and releases its stock. An order becomes paid only after
the store verifies the payment, never because the customer reached the success page.

When a customer sends a WhatsApp cart while online checkout is on, they receive a checkout link for that cart automatically;
it is priced from your catalogue, not from the prices Meta shows.

### Orders

- **Orders.** An order is marked paid only when the payment gateway confirms it, or when an admin records an
  offline payment. The status menu no longer offers "Paid". A storefront order moves Awaiting payment → Paid →
  Dispatched → Delivered (staff recorded). Older orders without store pricing can still go Confirmed → Delivered.
- **Flows.** Add a "Storefront link" step to send the store (or the customer's latest order) from a flow. On a
  "Payment link" step, turn on "Charge the order from this flow" in flows started by an order to ask for exactly what
  the order still owes.
- **Permissions** (Settings → Permissions): "Adjust stock", "Refund customer payments" and "Record offline payments"
  are for admins and above; "Send storefront links" is for agents and above. Each can be turned off per role.
- **Dispatch / Deliver**: on a paid order, enter an optional tracking note and choose *Mark dispatched*; later *Mark delivered*. These are recorded by your team. The customer gets a WhatsApp notice when their 24-hour window is open.
- **Feedback**: after delivery, record the customer's score (1-5). Bodhinox asks the customer a day after delivery when it can.
- **Cancel and refund** (admins with the Refunds permission): refunds what is left on the order's payments and cancels it. Stock returns when Razorpay confirms the refund.
- **Returns**: open a return on a dispatched or delivered order, mark it received, choose restock or discard for each item, then refund it or close it (admins may close with restock).
- **Receipts**: each paid order gets a numbered receipt (Tax invoice when your GSTIN is set in Store settings); refunds get credit notes. Open them from the order's Documents list and print from the browser.

### Payments → Customer payments
Every payment Razorpay confirmed (after Bodhinox checked it with Razorpay itself) and every offline payment recorded by staff. "Needs review" means it was not credited automatically; see Exceptions. Admins can refund from the row (Refund): choose the amount, a reason and, for an order not yet dispatched, whether to put the items back in stock. The refund shows "Pending at Razorpay" until Razorpay processes it. A refund shown as "Needs check" was sent but Razorpay's answer was unclear: use "Check with Razorpay"; it is never sent twice automatically. "Send again" appears only when Razorpay definitely did not make it.

### Record offline payment (order page)
For cash, UPI to a personal handle, bank transfer and similar. The amount must be exactly what the order still owes. Any open payment link for the order is cancelled first. The order shows the payment as recorded by you. Requires the "Record offline payments" permission (admins by default).

### Payments → Exceptions (admins)
Payments that arrived late (after the stock hold ended), for a cancelled order, twice, for the wrong amount or currency, or under old Razorpay keys, and refunds that failed or have an unknown outcome. Resolve held payments by refunding them in full and then "Mark refunded"; a late payment that found no stock can instead be accepted after adding stock ("Restock and accept").

### Payments → Reconciliation (admins)
Per day: money captured, refunds (including ones made in the Razorpay dashboard) and net, to compare with Razorpay's settlement report.

### Templates and analytics

- **Ayurvedic store template**: Flows → templates → "Ayurvedic store".
- **Commerce revenue**: Analytics shows net merchandise revenue, average order value, money collected (online and recorded by staff), refunds (including Razorpay dashboard refunds) and net collections for the chosen dates.

## 10. Other functionality and where to go next

**Inbox:** use quick replies from Settings, send permitted text/media/templates or interactive choices, assign conversations, mark status/unread, and deliberately pause/resume bot handoff. **Contacts:** edit profile, tags, custom fields and notes. **Settings:** profile, password/security/MFA, appearance, browser notifications, account/team, WhatsApp, templates, quick replies, fields/tags, deals/currency and API keys. **Integrations:** public scoped API keys, outbound signed webhooks and an MCP API client are implemented for later integrations; use minimal scopes and test delivery. **Live updates:** authenticated server-sent events refresh the UI, while a separate worker handles durable jobs.

An end-to-end pilot in sensible order is: configure email and create the owner → enable MFA → invite one agent → connect Meta's **test** sender and webhook → receive/reply to one message → add/tag the contact → create and move a deal → activate one keyword Flow → inspect run logs → test one Automation → connect/test AI in Playground → submit/approve one template → send a one-recipient broadcast. Only then repeat with a real business number after Meta eligibility and policy checks.

For implementation detail and feature acceptance boundaries, see the [functionality matrix](architecture/bodhinox-functionality.md), [README](../README.md), [Railway runbook](deployment/railway.md), and [integration plan](integrations/2026-10-13-bodhinox-chat-integration-setup-guide.md).
