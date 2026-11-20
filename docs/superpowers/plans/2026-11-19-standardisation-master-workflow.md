# Bodhinox Chat: standardisation master workflow

Date: 19 November 2026. Baseline: live `main` at commit `71ef4c2d`.

This is the single working document for making Bodhinox a standard, simple, connected product. It summarises the work and decisions so far, sets the rules, and lists every batch in build order.

Companion documents:
- Full findings, module by module: `docs/research/full-module-review-2026-11-19.md` (about 230 gaps).
- Earlier audit: `docs/research/product-improvement-audit-2026-11-10.md`.

---

## 1. Goal and limits

**Goal.** Bring every existing module up to the standard of the best products in its field, connect the modules to each other, and make every screen clear and simple in Apple's way.

**Limits set by the owner.**
- No new modules. Only standardise, connect and fill gaps in what exists.
- UI and UX follow Apple's design approach: clear, simple, few choices per screen.
- Appointments become the best simple booking system, connected to WhatsApp, Instagram and every module that needs it.
- Fable 5.2 designs and decides. Opus 5.5 builds.
- The owner sees the exact change list for each batch before any building starts.

**What "no errors" means here.** No design removes every error. The target is that an error stays in one place, someone is told, and a retry is safe.

---

## 2. Where things stand

**Shipped to live on 15–19 November**
- Store Phase 4: richer products, collections, CSV and Shopify/WooCommerce import, full WhatsApp catalogue sync.
- Store Phase 5: buyer accounts, order tracking, pincode check, zone and weight shipping, GST invoices, order edits, split shipments, more couriers.
- Store Phase 8: quotes, pickup, stock locations, purchase orders, pre-orders, bundles, digital products, price lists, store credit, loyalty, returns, wishlist, email campaigns, referrals, reports, counter sale.

**Analysed, not built**
- Adding one product takes about five separate saves.
- The six shop templates are one layout in six colour sets.
- A full review found about 230 gaps. Ten of the most serious were re-checked by hand and all held.
- Most of the 57 findings from the 10 November audit are fixed. Thirteen are open or partly fixed.
- Duplicate screens and status words were mapped (section 6).

**Built and waiting**
- Branch `claude/review-batch-1` from live main, holding only the tested Next.js 16.4.5 security upgrade.

**Not verified**
- Nobody has clicked through the Phase 4, 5 and 8 screens on the live site.
- Delhivery and Shipway have never been run against the real services.
- The review was done by reading code. Nothing was run on a phone.

---

## 3. How the work is done

### Roles

| Role | Who | Does |
|---|---|---|
| Owner | You | Approves each batch list. Says "ship". Confirms the database backup. Supplies outside accounts and keys. |
| Brain | Fable 5.2 (main session) | Writes the batch specification and the change list. Splits it into briefs. Reviews every diff. Runs the final checks. Decides what is ready. |
| Builders | Opus 5.5 (subagents) | Build one brief each, with tests, in their own working copy. Report what was done and what was not verified. |

Rules for builders:
- One builder per set of files. Two builders never edit the same file.
- Every brief names the files, the behaviour wanted, what "done" looks like, and the project rules.
- Code that touches money, message sending, tenancy or concurrency gets a line-by-line review by Fable before it is accepted.

### The loop for every batch

1. **Specify.** Fable writes the exact change list.
2. **Approve.** The owner approves or edits the list. Nothing is built before this.
3. **Build.** Opus builders work in parallel on a branch cut from live main.
4. **Review.** Fable reads every diff against the specification.
5. **Check.** Typecheck, lint, the full local test run, and the build.
6. **Look.** Fable clicks through every changed screen in the browser, at desktop and phone width, in light and dark.
7. **Show.** The owner gets a summary and screenshots.
8. **Ship.** On the owner's "ship": tag the current live version, confirm the Railway backup, merge, let CI apply the database changes, deploy.
9. **Verify live.** Health check, the changed screens, and the logs.
10. **Record.** Update the feature inventory and the deployment guide.

### Rules that never bend

- Every database read and write runs inside the workspace check.
- Database changes only add. Deployed migrations are never edited.
- A message send or a payment is recorded before it goes out, and is never re-sent blindly after an unclear result.
- Customer content and secrets stay out of logs.
- Each batch ships on its own and has its own rollback tag.

---

## 4. The standard each module is measured against

| Module | Measured against | The bar |
|---|---|---|
| Inbox | Intercom, Front, WATI | Reply, assign and resolve in one screen. Everything about the customer is beside the chat. |
| Contacts | HubSpot | One record per person, one timeline, no duplicates. |
| Automation | ManyChat, HubSpot workflows | One builder. Any event in the product can start it. |
| Campaigns | AiSensy, Klaviyo | Send in three steps. Never message someone twice by accident. See the revenue. |
| Pipelines | Pipedrive | Drag a deal. Money and bookings move it automatically. |
| Appointments | Calendly, Cal.com, Fresha | Book in under 30 seconds without leaving the chat. |
| Orders and payments | Shopify admin, Razorpay | One order screen with a clear next step. |
| Store | Shopify, Dukaan | One page to add a product. A shop that looks finished on day one. |
| AI agents | Intercom Fin | Answers from real data: products, stock, orders, bookings. |
| Analytics | Shopify analytics | One definition per number. Every chart opens the records behind it. |
| Platform | — | One slow job never delays another workspace. Nothing fails silently. |

Comparisons come from general knowledge of these products, not from a fresh walkthrough of each.

---

## 5. Target architecture

Keep the present shape: one application, one database, one background worker. Add four shared pieces.

1. **One event feed.** Every module writes a short record when something happens. Flows, rules, the contact timeline, notifications, webhooks and reports all read from it. Appointments already work this way and are the pattern to copy.
2. **One set of shared actions.** "Send a message", "tag", "assign", "create a deal", "send a payment link" and "book a slot" exist once. Flows, rules, the AI and the chat screen all call the same one.
3. **Separate worker lanes.** Inbound messages and AI replies get their own lane with several slots, in order per conversation. Timers and clean-up get another. Campaigns keep theirs.
4. **Nothing fails silently.** Alerts on failed jobs and stuck sends. One "needs review" list for uncertain sends. An error and Retry state on every screen.

House rules:
- One way to read and write data in new code.
- Each module has one front door. Other modules call its functions and never read its tables.
- Counts come from the database. Lists load a page at a time.
- Every action that sends a message or moves money carries a request id.

Not doing: microservices, a new queue product, or a rewrite.

---

## 6. The design standard: Apple's way

### Principles

- **Clarity.** One job per screen. One main button. Plain words.
- **Deference.** The content is the screen. Chrome, borders and colour stay quiet.
- **Depth.** Sheets slide over the page for a task and slide away when done.

### Rules every screen follows

| Area | Rule |
|---|---|
| Title | One large title per screen. The top bar is a breadcrumb only. |
| Main action | One primary button, top right. Other actions sit in a "more" menu. |
| Navigation | A grouped sidebar. Five tabs or fewer inside a section. |
| Lists | Grouped rows separated by space, with few lines. No card inside a card. |
| Forms | One page, one "Done". Switches apply at once. Advanced fields sit in closed sections. |
| Tasks | Creating or editing opens a sheet over the page. |
| Confirming | A sheet with the risky choice in red. No browser pop-ups. |
| Tap size | 44 points minimum on touch screens. |
| Choices | Two to four options use a segmented control. More use one menu style. |
| Loading | Placeholders shaped like the content. No bare spinners on a whole page. |
| Empty | One icon, one line, one action. |
| Errors | What happened, then a Retry button. |
| Motion | Short and soft. Respects "reduce motion". |
| Materials | See-through sidebar, toolbar and sheets. Content areas stay solid for reading. |
| Search | One box finds pages, people, orders, products and bookings. |

### One word for one meaning

| Meaning | Word |
|---|---|
| Chat needs a reply | Open |
| Chat finished | Resolved |
| Customer is waiting on you | Waiting |
| Hidden until a set time | Snoozed |
| Customers can see it | Live |
| Customers cannot see it | Hidden |
| A switch | On / Off |
| Task finished | Done |
| Order or booking finished | Completed |
| Stopped | Cancelled |

"Pending" is never shown on its own. The screen says what is being waited for.

### Shared pieces to build once

Page header, sheet, confirm dialog, grouped list, segmented control, menu, contact picker (name and phone), empty state, loading placeholder, inline error, money and date formatters.

---

## 7. Batches

Seven batches. Each one has its own list, approval, build, checks and release.

| # | Batch | Rough size |
|---|---|---|
| 1 | Quick fixes and clean-up | 2–3 days |
| 2 | Design foundation | about 1 week |
| 3 | Appointments | 1–2 weeks |
| 4 | Daily use | about 1 week |
| 5 | Architecture core | 1–2 weeks |
| 6 | Store | 1–2 weeks |
| 7 | Remaining gaps | 2 weeks or more |

The sizes are rough estimates.

### Batch 1: quick fixes and clean-up

**Security and reliability**
1. Upgrade Next.js to 16.4.5 (already tested).
2. Limit sign-up, login and password reset per IP address.
3. Alert on failed jobs and on sends stuck longer than 10 minutes.
4. Stop a campaign being created twice by a retry or a second tab.
5. Apply the monthly AI token cap to auto-replies and flow AI.
6. Retry the AI provider once or twice when it is busy.

**Bugs**

7. Show payments and refunds on the order page.
8. "Delete pipeline" says plainly that it permanently deletes all deals.
9. Fix the six pages titled "Dashboard".
10. Set the base web address so shop links preview correctly.

**Error and Retry instead of fake empty screens**

11. Inbox list and open chat, flows, orders, contacts, templates, dashboard, notifications, and the campaign reach count.

**Removals and duplicates**

12. Hide the "Pending" chat status; show old ones as Open.
13. One word, "Resolved", for a finished chat.
14. Templates under Settings opens the Campaigns screen.
15. The separate audit-log page opens the Settings tab.
16. Campaign list: Failed and Cancelled tabs become a status filter.
17. Remove the "Beta" badge on flows.
18. Remove the fake campaign progress bar.
19. Campaign wizard: skip the Details step with one channel; ask for the name once.
20. Contacts tabs move into the shared tab bar.
21. Fix the setup checklist's old `/flows` link.
22. One spelling: "Cancelled".
23. Product visibility becomes one control: Live / Hidden.

**Small fixes**

24. New keyword rules default to "whole word".
25. Contact search waits 300 ms after typing.
26. Template editor warns before closing with unsaved changes.
27. Campaigns are scheduled in the workspace time zone.
28. Orders can be found by the reference shown on screen.
29. Order export uses every filter and warns when cut at 5,000 rows.
30. Pipeline cards scroll on phones.
31. AI: "hand off when nothing in knowledge matched" becomes a switch.
32. Contact pickers search by phone as well as name.

### Batch 2: design foundation

1. Design tokens for type, spacing, colour, radius, motion and materials, in light and dark.
2. The shared pieces listed in section 6.
3. Sidebar regrouped. Sales splits into Sales (pipelines, appointments, orders, payments), Products, and Store.
4. Home gets its own entry, outside Analytics.
5. The word list from section 6 applied across all four languages.
6. Browser confirm pop-ups replaced by the shared confirm sheet (about 30 places).
7. One search box that finds people, orders, products and bookings.
8. First screens converted as the reference: Inbox, Contacts, Orders.

Every later batch converts the screens it touches. A final sweep in batch 7 converts the rest.

### Batch 3: appointments

**Aim.** A customer books in under 30 seconds without leaving the chat. Staff run the whole day from one screen.

**What exists today.** Services, staff, locations, hours, holidays, group sessions, a public booking page confirmed by a WhatsApp code, booking inside a WhatsApp flow, no double booking, customer cancel and change links, WhatsApp reminders, outcome marking, Razorpay prepayment on the booking page, Zoom (built, switched off), five rule triggers, five webhook events.

**A. Customer side**
1. Booking page: price on every service card, and three steps only (service, time, confirm).
2. The page confirms on screen as soon as the WhatsApp code arrives.
3. "Add to calendar" file and Google Calendar link on the confirmation, the manage page and the WhatsApp message.
4. Direct links per service and per staff member.
5. Reminders carry Confirm, Reschedule and Cancel buttons that work inside the chat.
6. A paid service can be booked inside a flow: the slot is held, the payment link is sent, and the booking confirms on payment.
7. Booking page restyled to the design standard, phone first.

**B. WhatsApp and Instagram**

8. Instagram booking: the "Book appointment" flow step works in Instagram DMs.
9. Instagram reminders inside the 24-hour window, falling back to WhatsApp when a number is known.
10. Ready-made automations: "book" keyword, story reply and comment reply each open booking.
11. A "Book now" button on campaign templates opens the booking page, and the booking is credited to the campaign.
12. A booking made after an ad click is credited to the ad.

**C. Staff side**

13. One Appointments screen with Today, Week and List views.
14. Tabs reduced to four: Schedule, Services, Team (people, hours, holidays, locations) and Settings (booking pages, messages).
15. The appointment sheet shows payment state (Paid, Pending payment, Refunded) with a link to the payment.
16. Cancelling a paid booking offers "Refund this payment".
17. The sheet links to the contact, the chat and the deal.
18. Reschedule by dragging in the Week view.
19. Notice when a list is cut at its row limit.
20. Zoom switched on once its keys are set (owner step).

**D. Connected to every module**

| Module | Connection |
|---|---|
| Inbox | Upcoming and past bookings in the chat side panel. "New booking" in the composer menu, with the contact filled in. |
| Contacts | Bookings list on the profile. Booking events on the timeline. |
| Pipelines | A booking can be linked to a deal. A completed booking can move the deal's stage. |
| Payments | Booking payments open the booking, and the booking opens the payment. |
| Flows | Booked, cancelled, rescheduled, completed and no-show start a flow, as they already start a rule. |
| Forms | An intake form can be sent automatically after a booking. |
| AI agent | Sees the customer's own upcoming booking. Can offer free slots and send the booking link. |
| Campaigns and ads | Bookings credited to the campaign or ad that produced them. |
| Notifications | New booking, cancellation and no-show in the bell, with a dot on the Sales section. |
| Analytics | "Bookings today" on Home. Reports for show rate, no-show rate and booking revenue. |
| Search | Bookings found from the one search box. |

**E. Left for a later decision**

Google and Outlook calendar sync, website embed, deposits, packages and memberships, waitlist, SMS and email reminders. Each needs an outside account or a pricing decision from the owner.

### Batch 4: daily use

1. One-page Add product with one save: photos, name, price, old price, stock, category. Variant and SKU are created automatically.
2. Advanced product fields in closed sections on the same page.
3. Options builder: type sizes and colours once and get a table with price and stock per row.
4. Photos: drag in, save automatically, reorder, first is the cover.
5. Price and stock editable in the product list. Bulk Live, Hidden, archive and category.
6. Chat side panel: orders, payments and deals, each linked. (Bookings arrive in batch 3.)
7. "New order", "New quote" and "New deal" from the composer menu.
8. Contact profile: payments list, and deals that open the deal itself.
9. One order view replacing the separate page and drawer, with a clear next step.
10. Orders: payment and date filters, a returns queue, a quotes list, bulk dispatch.
11. Store settings split into sections with a side list.

### Batch 5: architecture core

1. Event feed: order created, paid, shipped, delivered and returned; payment received; form submitted; deal stage changed; cart abandoned.
2. Those events available as triggers in flows and rules, and as outbound webhooks.
3. Contact timeline fed from the event feed.
4. Shared actions module. Flows and rules both use it. Adds "create deal" and "move deal stage" to both.
5. Inbound worker lane with several slots, in order per conversation. Slow Meta jobs move to the bulk lane.
6. "Needs review" list for uncertain sends, with "was sent" and "send again".
7. Rate limits moved into the database.
8. One shared live-update connection per tab, slower when idle.
9. Hourly clean-up extended to send records, expired sessions and rate-limit rows.
10. AI reads products, prices, stock and the customer's own order status.
11. Campaigns show orders and revenue.

### Batch 6: store

1. Themed checkout under the shop: cart, address and payment only.
2. Cart shows shipping, coupon and total before the WhatsApp code.
3. Product page: sticky buy bar on phones, share button, "ask about this product on WhatsApp", sold-out options greyed.
4. Sitemap, robots file, product data for Google, search title and share image per product.
5. Readable product and category links, with redirects from the old ones.
6. Four to six templates that really look different, with a preview gallery.
7. Hosted fonts, and the missing home page sections.
8. Shop pages cached briefly. Images served sized and cached.
9. Listing limits moved into the database, with a notice to the seller.
10. Retire the old checkout page and merge the two product systems, once the replacements are live.

### Batch 7: remaining gaps

1. WhatsApp sequences, using approved templates outside the 24-hour window.
2. Contact duplicate finder and merge.
3. Campaigns: "skip people messaged in the last X days", quiet hours, "cancel remaining", consent tick for CSV audiences, drafts that keep every field.
4. Inbox: multi-select with bulk actions; server-side paging of the conversation list.
5. Analytics: one definition for response time, daily summary tables, charts that open their records, estimated AI cost.
6. AI setup: provider first, model picker, fewer tabs.
7. Language per user, starting with emails.
8. PDF reports that print Hindi, Telugu and emoji.
9. Settings search and "related settings" links.
10. A restore drill from a real backup, recorded in the runbook.
11. Final sweep converting every remaining screen to the design standard.

---

## 8. Decisions and steps that need the owner

| Item | Needed for |
|---|---|
| Approve each batch list | Every batch |
| Confirm the Railway database backup before each release | Every batch |
| Preview the Apple look locally before it goes live | Batch 2 |
| Zoom keys on Railway | Batch 3, item 20 |
| WhatsApp template approval for reminders with buttons | Batch 3, item 5 |
| Instagram App Review status | Batch 3, items 8–10 |
| Google and Microsoft apps for calendar sync | Batch 3, section E |
| Courier accounts for Delhivery and Shipway | Verifying Phase 5 |
| Custom domain: DNS and hosting choice | Outside all batches |

---

## 9. How we know it worked

- Adding a simple product takes one screen and one save.
- A customer can book from a WhatsApp or Instagram chat in under 30 seconds.
- Staff can see a customer's orders, payments and bookings without leaving the chat.
- A failed load never looks like an empty screen.
- A failed job or a stuck send raises an alert within 10 minutes.
- One slow job in one workspace does not delay replies in another.
- Every status has one word, and every screen has one title and one main button.
