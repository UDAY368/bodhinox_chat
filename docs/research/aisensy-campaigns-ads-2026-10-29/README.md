# AiSensy Campaigns and Ads Manager — extracted research

Research captured 29 October 2026; organized 30 October 2026. Research only: no application implementation. This is a bounded extraction of the accessible account UI and retained frontend code, not a claim that every server-side or gated feature has been recovered.

## Files and evidence

- `catalog.html`: searchable local research index, feature details, evidence links and screenshot gallery. It is a document viewer, not a replica.
- `feature-catalog.json` / `.csv`: categorized capability records with evidence and limitations.
- `ui-elements.json`: source-linked UI text/control occurrences from captured accessibility/DOM snapshots. Occurrences are not unique components or features.
- `endpoint-candidates.json`: static URL/path candidates and source lines; not captured network requests.
- `evidence/`: original browser observations and screenshots.
- `static-modules/`: eight inert module extracts from the previously retained `main.01f91df0.js`; `manifest.json` maps them to `main-readable.js` lines.
- `rea-static-modules.json`: REA analysis, evidence `ev_b369f92989bfadfb69d5360e2860b8f670d5940e982c231fbf2368d3cda404a9`.
- `evidence-manifest.json`: file sizes and SHA-256 fingerprints.

Live observations are stored separately from static findings. REA inspected local, derived module extracts; it did not capture this browser's network or prove execution of every module. Graph/semantic coverage is partial; semantic retention limits apply; eight JavaScript files were parsed with zero parse failures. The complete page-specific lazy chunks were not acquired in this pass. Original retained bundle: `C:/Users/uday/Desktop/BODHINOX_CHAT/.reference/aisensy-full-2026-10-29/source/main.01f91df0.js`. Use the manifest and local source files rather than treating the extraction as original source code.

## Scope and observed account state

Targets were `/campaigns/all` and `/advertisement/ads-manager` under the user's selected project. The Ads Manager submenu also exposed Ads Agent, Leads, Forms, Audiences, Events, and Setup; these are included.

Campaigns, ads, forms, audiences, and events had empty states. The API campaign template picker returned **No options**. Setup showed Facebook connection/page steps completed and WhatsApp linking pending. Campaign scheduling opened a plan-upgrade dialog. These conditions materially limit deeper inspection.

No campaign was launched or set live; no ad was published; no credits were bought; no AI generation was requested; no report email was generated; no contacts were uploaded; no audience/event was created; no connection, terms, or verification setting was changed. Temporary unsaved form values were discarded through navigation. The final navigation returned to Ads Manager.

## Campaigns

### Overview and navigation

The header displays quality rating, messaging tier and remaining quota. At capture these were High, Tier 0 (250 per 24 hours), and 250 remaining. These are account values, not universal limits. Search filters campaign names; Refresh reloads the collection. Tabs are All, Campaign Agent, Broadcast, API, and Scheduled with a Pro badge. The table exposes Campaign, Type, Created At, Status, Audience, pagination and an empty state. Analytics was disabled with no campaigns.

Launch opens five choices: Campaign Agent; Broadcast Campaign using existing audience; API Campaign using approved templates and API integration; CSV Broadcast using uploaded audience; Meta Ads. The overview also promotes AI Agent creation, AI template generation, WhatsApp Status ads and Lead Form ads. Promotional claims are not proof of their runtime implementation.

Evidence: `campaigns-overview.txt`, `campaign-types.txt`.

### Broadcast audience editor

Three steps: Campaign Details → Create Message → Test & Preview. The first step has campaign name, audience selection, audience contact preview and disabled Next controls until prerequisites are met. The audience builder has searchable filters grouped into:

- Quick filters: Tags, Created Date, Last Seen, Opted In, Blocked, Segment, List.
- Attributes: Name, Mobile Number, Source, First Message, Campaigns, Intervened, Closed, Requested, Intervened By Agent, Lead Stage, MAU Status, WhatsApp Conversation Status.
- Account-specific custom attributes, including Location, phoneno, name in this account. These are dynamic, not a fixed global schema.

Tag filtering exposes `has` and `not has`. After adding a filter the builder showed default `Opted In is Yes` and `Blocked is No`, an AND separator, a missing-value condition, Add filter group, Save as Segment, Apply Filters, and Discard. Apply Filters was disabled for an incomplete condition. Do not assume every attribute uses the same operators. Nested group semantics and the complete operator matrix remain unverified.

The message and final preview steps could not be opened directly without satisfying audience prerequisites. No audience was manufactured or uploaded to bypass this. Template/regular-message support is stated by the launch chooser; their complete editor fields, scheduling UI, retry controls, personalization and test-send flow were not recovered here.

Evidence: `broadcast-details.txt`, `broadcast-filter-types.txt`, `broadcast-tags-operators.txt`, `broadcast-filter-builder.txt`.

### API campaign

Name field, searchable approved WhatsApp template selector, and Set Live action. Set Live stays disabled without required inputs. The template picker was empty, so template-dependent variable fields and the resulting integration instructions were not observed. Existing frontend modules also contain campaign fetching and daily-template-quota state (see static section).

Evidence: `campaign-api.txt`, `campaign-template-empty.txt`.

### CSV broadcast

Four steps: Campaign Name → Upload CSV → Create Message → Test & Preview. Entering an unsaved name enabled advancement to upload. Upload exposes drag/drop or click-to-select, Prev and Next at top/bottom, with Next disabled before upload. The DOM file input reported `multiple: true`; this does not establish that multiple files are accepted by backend validation. Column mapping, row limits, duplicate handling and parsing error UI were not exercised.

Evidence: `campaign-csv-upload.txt`. The plan dialog advertises CSV scheduling and Premium duplicate-contact messaging, recorded as advertised/gated capabilities rather than validated behavior.

### Campaign Agent

An editable agent name, four numbered stages with Goal active, available WCC balance, Save & exit, natural-language goal input, Ctrl+Enter hint and Next (who gets it) appear. The next action requires a name. The screen accepts English/Hinglish and offers example goals for dormant-customer re-engagement, product launches and subscription renewals. Introductory text describes audience selection and message assistance. No goal was generated or saved; later planning, execution and optimization behavior is unknown.

Evidence: `campaign-agent-goal.txt` and screenshot.

### Reports, scheduling and plan gates

Three distinct dialogs:

| Action | Inputs | Stated output | Gate |
|---|---|---|---|
| Download Report | From / To | Combined analytics CSV | Premium badge |
| User Report | From / To | Per-user campaign analytics by email | Premium badge |
| Overview Report | From / To | Consolidated campaign CSV, delivered as ZIP by email | Premium badge |

The Scheduled tab triggered Upgrade Plan on this Basic account. The upsell advertises Pro campaign scheduling, CSV scheduling, click tracking, budget/analytics and automatic failed-message retry; Premium report downloads, template TTL and duplicate CSV contact messaging. These are UI marketing/gate evidence, not verified algorithms, quotas or server enforcement. Purchase prices are time/account-specific and must not be hardcoded into a future replica.

Evidence: `campaign-download-report.txt`, `campaign-user-report.txt`, `campaign-overview-report.txt`, `campaign-schedule-plan-gate.txt`.

## Ads Manager

### Dashboard, filtering and reporting

Header: credit balance, Buy Credits, Create Ad, AI Assistant. Main tabs separate AiSensy Ads and Fetched Ads. Search by ad name, status multi-selection with search (All, Active, Paused, Draft), date picker, Sync, Download Report, Customize Metrics and Columns. Date presets: Today, Yesterday, 7/30/90 days, Maximum, Day wise, Custom range. The calendar has month navigation and disabled future dates in the observed state.

Fetched Ads adds an ad-account selector, account/insight Sync and Fetch Ads (disabled without an account), described as importing click-to-WhatsApp ads from Facebook Business Manager. No sync/import was triggered by the inspection.

Table base columns: Actions, Ad Name, Start Date, Status, Ad Type, Daily Budget. Default metric columns: Impressions, Reach, Clicks, Spend, CTR, CPC, CPM. Default page size 25, previous/next and zero-results state. With no rows, row actions and populated insights could not be exercised.

Evidence: `ads-overview.txt`, `ads-status.txt`, `ads-date-presets.txt`, `ads-fetched.txt`.

### Metric cards and configurable columns

Metric chooser offers Number of Leads, Click-Through Rate, Cost Per Lead, Total Spend, Total CAPI Signals, Impressions, Reach, Frequency, Clicks, Unique Clicks, Inline Link Clicks, CPM, CPC, Outbound Click, Messaging conversations started. It states select six, with Cancel/Apply; at capture it said 6/6 although only five selected checkbox labels/cards were exposed. Preserve this discrepancy rather than inventing a sixth metric.

Column customization has search, expandable groups, selection counts, chosen-column removal/reordering by drag-and-drop, Save as column preset, Cancel, Apply. No preset was saved and no column preference was applied.

- Key Metrics: Impressions, Reach, Frequency, Clicks, Unique Clicks, Inline Link Clicks, CTR, Spend, CPC, CPM, Outbound Click, Messaging conversations started.
- Results Breakdown: Cost Per Result, Results ROAS, Result rate, Results value, Results.
- Actions Breakdown: Link Click, Omni Add To Cart, Page Engagement, Landing Page View, Add To Cart, Omni Landing Page View, Onsite Web App Add To Cart, Onsite Web View Content, Onsite Web Add To Cart, Post Engagement, Post Interaction Gross, View Content, Post, Onsite Conversion Post Save, Onsite Conversion Post Net Like, Onsite Conversion Post Net Save, Onsite Web App View Content, Offsite Content View Add Meta Leads, Video View, Omni View Content, Offsite Conversion Fb Pixel View Content, Offsite Conversion Fb Pixel Add To Cart, Post Reaction.
- Video Breakdown: 25%, 50%, 75%, 100% watched, Video Plays, Video Avg Time Watched (seconds).

Evidence: `ads-metrics.txt`, `ads-columns.txt` (complete captured option lists).

### AI ad generation and Ads Agent

Prompt composer contains editable business name, website URL and target audience slots. Options include Shopify products, added media, automatic/type selection, image/video, aspect ratio and image count controls. Image count showed three with increment disabled. Five free generations were displayed in the overview, while the creative editor showed three free image generations; treat these as separate observed counters, not a single universal entitlement.

AI ad type choices: Let AI decide, Click to WhatsApp, Website to WhatsApp, Website, Status. Image ratios: 9:16, 2:3, 3:4, 16:9, 3:2, 4:3, 1:1. The 3:4 selector displayed 900 × 1200. Video duration choices: 30, 45, 60 seconds. The initial video choice displayed ₹150 Ad Credits; no deduction occurred and other durations' prices were not checked.

Ads Agent has the same composer and tabs All, Click to WhatsApp, WhatsApp Status, Website to WhatsApp, Website. Generation results/history states were not populated. Static code adds list/status polling, generation payloads, update/delete candidates, product lookup, setup and create-ad calls; these are not proof that generation completed.

Evidence: `ai-ad-types.txt`, `ai-aspect-ratios.txt`, `ai-video-options.txt`, `ads-agent.txt`, module `14876.js`.

### Ad creation: destination and objective

Five destination cards: Click to WhatsApp, WhatsApp Status, Website to WhatsApp, Website, Lead Form. WhatsApp-related cards show number-verification prerequisites. Default CTWA setup exposes Traffic, Engagement, Sales objectives. Traffic goals observed: maximize link clicks, daily unique reach, conversations, impressions.

Website selected Sales / maximize conversions and exposed Pixel selector plus Create New Pixel. Lead Form selected fixed disabled Leads objective and maximize leads. Destination-specific objective matrices are not exhaustive. Do not assume every objective is valid for every destination.

Evidence: `ad-create.txt`, `ad-objectives.txt`, `ad-performance-goals.txt`, `ad-website-objective.txt`, `ad-leadform-objective.txt`.

### Targeting and placements

Saved audience selector; multi-select custom/lookalike audience; create-audience shortcut; audience exclusions; geographic include/exclude selectors; gender (default ALL); min/max age (defaults 18–65); advanced interests/demographics/behaviors; Meta audience expansion switch; Save Audience (disabled until valid); Next.

Instagram placements: Feed, Stories, Explore, Explore Home, Reels, Profile Feed, Search, Profile Reels. Facebook: Feed, Right Column, Marketplace, Video Feeds, Stories, Search, In-Stream Video, Reels, Reels Overlay, Profile Feed, Notification. Both platforms have a checkbox and Clear All controls. WhatsApp Status placement exists in the static constants; it was not exercised in targeting.

Evidence: `ad-targeting.txt`, static module `22494.js`.

### Budget and timing

Daily or Lifetime Budget selector, numeric amount (daily default ₹500), start date, optional end-date control, lifetime total/daily summary, and custom weekly schedule. Attempting scheduling on Daily Budget showed a tooltip that scheduling requires Lifetime Budget. The schedule is described as click-and-drag time blocks. Actual grid serialization, timezone, minimum spend, scheduling validation and delivery were not verified.

Evidence: `ad-budget.txt`, `ad-lifetime-budget.txt`, `ad-schedule-gate.txt`.

### Creatives and previews

Ad name counter 255; primary text 2,200; headline 40; description 30. Counters are observed UI limits, not verified server limits. Formats Image, Video, Carousel; media URL or Media Library; AI creative section with prompt, product image, brand logo, aspect ratio, target audience, CTA and View History. Generate disabled while inputs are missing.

Website ads add CTA and destination URL. Lead-form ads add a form selector/create entry and CTA; Create New was disabled in this account. The observed form did not permit inspection of the full Meta lead-form editor.

Carousel starts with two of ten cards, supports drag reorder, add images/videos, AI images, expand/collapse cards, remove card, media picker or URL, per-card headline/description and Apply to all cards. Preview shows multiple cards and CTA elements. Ten is the observed editor cap, not asserted as a universal platform rule.

Ad preview includes business image/name, sponsored label, caption, media region, destination label, headline, CTA, Like and Share. Website/lead previews changed their label/CTA according to destination. Lead mode exposed estimated daily reach/impressions/leads, all zero here. The screen also showed a broad monthly active-user reach label and a disclaimer about estimates; this is not a reliable campaign forecast. Actual mobile/feed rendering and responsive breakpoints were not tested.

Evidence: `ad-creative-image.txt`, `ad-carousel.txt`, `ad-website-creative.txt`, `ad-leadform-creative.txt`, `ad-create.png`.

### Icebreakers and flow connection

Optional CTWA step with saved-icebreaker search, Create New, name, required greeting, message count 0/80, flow selector, Choose Block, Add New Icebreaker and Save Icebreakers. Empty flow selection disabled routing controls. A WhatsApp phone-style preview shows the business, conversation region, composer/icons and a note about prefilled customer text. Static fields include iceBreakerText, flowId, blockId, blockHandle and iceBreakerId. No icebreaker was saved.

Evidence: `ad-icebreakers.txt`, `ad-icebreakers.png`, module `81766.js`.

## Other Ads Manager modules

### Leads

Summary counters for total leads, form submissions and CTWA leads. Name/email/phone search; form selector; ad selector; date filter; All Leads / Lead Form Submissions / CTWA Leads tabs. Selected-lead Broadcast, Export CSV and Sync from Meta (described as recovering webhook-missed leads). Empty lists disable export/broadcast. Static API code supports contact submission history, form-answer filtering, date/timezone handling, select-all with exclusions and selected-only exports. No contact data was exported or broadcast.

Evidence: `ads-leads.txt`, module `22877.js` lines 351–531.

### Forms

Total/active/archived forms and response counters; search; sort Newest, Oldest, Most leads, Fewest leads; Automation All/On/Off filter; Sync forms; empty state. Static methods fetch form details and date-filtered overview. Actual automation editor, question types and populated response previews remain unknown.

Evidence: `ads-forms.txt`, `ads-form-sort.txt`, `ads-form-automation-filter.txt`; module `22877.js` lines 399–455.

### Audiences

AiSensy / Fetched audience tabs, All/Website/Custom/Lookalike type filters, name search, Sync, pagination, create actions and empty-state CTA. Custom creation has name counter 50 and optional description 100. Sources: Customer List CSV (UI states hashing/matching by Meta), Website/Pixel, From Contacts.

Website rules: ALL criteria selector, data source/pixel, events selector default All website visitors, retention default 30 days, Narrow Further, Exclude people, Back, Create. Missing pixel disables creation and shows a validation message. Full operator/event sets depend on a pixel and were unavailable.

Lookalike: name, description, source custom audience, audience-size slider, presets 1% Very Similar, 2% Balanced, 5% Broader Reach, 10% Maximum Reach. Creation stays disabled without prerequisites. Static code supports asynchronous custom creation, combined custom+lookalike creation, uploads, contact filters/exclusions, sync and differentiated validation/duplicate/server errors. UI hashing claims were not independently verified.

Evidence: `ads-audiences.txt`, `audience-create-custom.txt`, `audience-pixel-rules.txt`, `audience-lookalike.txt`; module `91506.js`.

### Events

Search by event name, Sync Pixels from Meta, Create Event, empty state. Create dialog: event name counter 100, description 1,024, Cancel and disabled Create before required inputs. Static module includes pixel list/details/stats/sync/create. No event was created, so event detail charts, installation instructions and test-event behavior were not visible.

Evidence: `ads-events.txt`, `ads-create-event.txt`; module `91506.js` lines 528–692.

### Setup and credits

Setup progression: connect Facebook; choose Facebook ad page; link WhatsApp. The connected state has Disconnect, Create Page, Sync, Lead Form terms link/acceptance controls, WhatsApp number field and Verify. Creating ads depends on prerequisites. The terms checkbox/acceptance and verification actions were disabled; nothing was accepted or verified. A troubleshooting/demo link and setup tutorial are present.

Buy Credits opens an amount input (minimum ₹1,500 displayed), quick additions +2,500/+5,000/+10,000/+50,000, and Purchase Now. Scope text says credits run AiSensy-managed ads. Payment provider, taxes, refunds, fulfillment and checkout screens were not inspected. The ₹1,000 displayed balance and advertised reward are account/capture state.

Evidence: `ads-setup.txt`, `ads-credit-dialog.txt`.

## Static architecture and contracts

All paths below are frontend call sites, not a captured API contract or permission to call them. Exact candidates with source lines are stored in `endpoint-candidates.json`.

| Source module | Recoverable behavior |
|---|---|
| 86983 | Campaign collection state, loading/error, name search, page/skip/rowsPerPage, list request with assistantId and tabType, optional Campaign Agent filtering, local campaign status action |
| 55940 | Fetch campaigns keyed by name and retrieve dailyTemplateLimit / consumedTemplateLimitQuota |
| 14876 | AI ad template listing, generation parameters (prompt/count/aspect/creative format/video duration/type/product inputs/layout), product lookup, ad creation and account setup/lead-form permission check |
| 22877 | Ad insights/preview, ad and lead sync, account insights, export, status update, contacts/forms and historical leads |
| 22494 | Ad type/status helpers, objective/placement and preview-format constants |
| 91506 | Custom/lookalike audience operations, upload flows, pixels and errors |
| 81766 | Assistant/account flags, ad credits, icebreaker routing fields and AI creative parameter state |
| 2579 | Additional extracted shared module; retain as evidence without assigning unverified behavior |

Campaign list request has assistantId, skip, rowsPerPage, nameQuery, tabType; responses contain campaigns/newSkip/totalCampaigns. New pages reuse cached items where available. Lead queries include type, search, formId, adId, startDate/endDate, page/limit, answer JSON and timezone. CSV export distinguishes all/form-submissions/ctwa-leads and selectedNums versus unselectedNums under selectAll. Missing assistant/form IDs are checked before relevant exports.

Audience custom creation requires assistantId/name/subtype; WEBSITE needs a nonempty rule; CUSTOMER_LIST needs fileUrl or dbQuery unless skipUpload. Payload maps dbQuery to allFilters and includes unSelected. Lookalike includes origin_audience_id and lookalike_spec. Combined creation checks ratio; HTTP 400/409/500 map to validation/duplicate/server messaging. These are client checks, not complete server validation.

## Coverage and remaining gaps

| Requested area | Result |
|---|---|
| Visible feature inventory | Captured across Campaigns and seven Ads submenu entries |
| UI controls and option sets | Stored snapshots plus searchable inventory; not every conditional state |
| Previews | Actual ad/icebreaker screenshots; destination/carousel DOM observations; broadcast final preview blocked |
| Capabilities and integration clues | Frontend modules and REA evidence retained; server behavior unverified |
| Every possible feature | **Partial**: impossible to establish from this empty, gated account and selected code alone |

Outstanding: populated campaign/ad detail actions; broadcast message construction and final test/preview; schedule and retry execution; CSV parsing/mapping/errors; approved-template variable flows; Campaign Agent stages beyond Goal; generated AI ad history/results; media uploads; exact CTA/objective matrices; lead-form editor and automation; audience import jobs; event detail/testing; billing checkout; actual server validations, delivery receipts, attribution formulas, webhook processing, retries, permissions and rate limits. Backend replication requirements must be designed separately rather than invented from frontend labels.

Original asset binaries, icon/font packs and page-specific lazy bundles are not included. Prior research's asset-download permission refusal was not worked around. This package uses existing local source and browser-visible evidence. The screenshot gallery contains real captured images, not invented screens.

