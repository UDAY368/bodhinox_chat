# Bodhinox Chat: full module review

Date: 19 November 2026. Code reviewed: live `main` at commit `71ef4c2d` (after store Phases 4, 5 and 8).

## How this review was done

- Eight reviewers each read one part of the code in parallel. Nothing was run: no tests, no browser, no live site.
- Ten of the highest-impact findings were then re-checked by hand in the code. Those are marked **(re-checked)**.
- Every other finding comes from a reviewer reading the code. Items marked *suspected* were not fully traced.
- Mobile layout, dark mode and accessibility were judged from code only, not on a device.
- Sizes: **S** is hours to a day, **M** is a few days, **L** is a week or more.

## The 20 changes that matter most

| # | Change | Why | Size |
|---|---|---|---|
| 1 | One-page Add product with one Save | Adding a product takes about five saves today, and saving one card can wipe text typed in another | M |
| 2 | Let the AI auto-reply read the catalogue, stock, the buyer's own order status and bookings | The bot cannot answer "how much", "is it in stock" or "where is my order"; it hands off instead | L |
| 3 | Orders, payments, bookings and deals inside the chat side panel, with "New order / booking / deal" buttons | Staff must leave the chat and re-find the customer for every sale task | M |
| 4 | Store and deal triggers for flows and rules: order paid, shipped, delivered, cart abandoned, form submitted, deal stage changed | Sellers cannot build their own journeys from store events; only `order_received` exists | L |
| 5 | Split inbound messages into their own worker lane with several slots | One slow AI call or one busy workspace delays every other workspace's replies **(re-checked)** | M |
| 6 | Alert on failed jobs and on sends stuck in "dispatching"; add a list of uncertain sends with "mark sent / send again" | A failed or stuck send can sit unseen for days **(re-checked)** | M |
| 7 | Themed checkout page under the shop, with only cart, address and payment | After the WhatsApp code the buyer lands on a second, differently styled page that lists all products again | L |
| 8 | Sitemap, robots file, product data for Google, and a base URL for share images | Shops are open to Google but nothing tells it which pages exist; link previews are probably broken **(re-checked: no sitemap, robots or `metadataBase`)** | M |
| 9 | Apply the monthly AI token cap to auto-replies and flow AI too | The cap the owner sets does not limit the biggest spender **(re-checked)** | M |
| 10 | Guard against sending the same campaign twice, and add "skip people messaged in the last X days" | A retry or second tab sends the campaign again; nothing limits how often a contact is messaged | M |
| 11 | Show payments and refunds on the order page | The panel for this exists but is never shown **(re-checked: no screen imports it)** | S |
| 12 | Error state with Retry on every list | Inbox, flows, orders, contacts, templates and the dashboard show "nothing here" or endless loading when a request fails **(re-checked on the dashboard)** | S each |
| 13 | Per-IP limit on sign-up, login and password reset | Limits are per email only; many emails from one address are not slowed **(re-checked)** | S |
| 14 | Move rate limits out of process memory | This is what forces a single web server; a restart clears every limit | M |
| 15 | One shared live-update connection per tab | Each tab opens about six streams, each querying the database every 2 seconds | M |
| 16 | WhatsApp drip sequences | Sequences work on Instagram only | L |
| 17 | Templates that really look different, with a preview gallery | The six templates are one layout in six colour sets | L |
| 18 | Fix "Delete pipeline" | The dialog says "archive" but the code deletes every deal, including won ones **(re-checked)** | S |
| 19 | Simplify the Sales menu and Store settings | Ten tabs with look-alike names; settings are one long page of nine sections | M |
| 20 | Upgrade Next.js and add a dependency check to CI | The installed version has a reported security advisory and CI has no check for one | S |

## What was fixed since the 10 November audit

Most of the 57 earlier findings are fixed on main. Still open or only partly fixed:

| Earlier item | Status |
|---|---|
| 1. Inbox loads every conversation | Partly. Refresh is now quiet and incremental, but the first load and a 5-minute full reload still read every conversation into the browser |
| 7. Pipeline board | Partly. Nothing is hidden now, but every deal ever made is still loaded into the browser |
| 10. Campaigns block the worker | Partly. Campaigns have their own lanes, but one pass still runs 2.5 minutes or more, and Meta ads and Instagram jobs still share the inbound lane |
| 21. Flow "Book appointment" with paid services | Partly. It is now logged clearly, but flows still cannot book a paid service |
| 23. Shiprocket untested against the live service | Not re-checked; treat as open |
| 30. AI confidence slider | Partly. A reply with no knowledge behind it still goes out at every setting |
| 32. Sensitive-topic word list | Mostly fixed. No per-workspace switch; Hindi and Telugu scripts are not covered |
| 34. PDF reports print "?" for Hindi, Telugu and emoji | Still open |
| 39. Deletion | Partly. Clean-up jobs exist, but workspace deletion is switched off by default and several tables are never pruned |
| 43. Help pages | Partly. Still English only |
| 44. Instagram | Built; still off until Meta App Review |
| 45. Emails in the user's language | Partly. Language is fixed when the app is built, not per user |
| 57. Uncertain inbound step | Still open. No screen shows or clears one |

---

## 1. Inbox, contacts and notifications

### Features
| Gap | Change | Size |
|---|---|---|
| No duplicate detection or merge for contacts; the same person can exist on WhatsApp and Instagram | "Find duplicates" view and a merge that keeps chats, tags, notes and orders | L |
| No multi-select in the inbox list | Checkboxes and a bulk bar: assign, resolve, label, mark read | M |
| Notifications page shows the newest 100 only, with no filter or "load more" | Unread filter, type filter, load more, link to notification settings | S |
| Many notification types do nothing when clicked (payment received, campaign finished, template rejected, billing) | Send each type to its own page | S |

### UI
| Gap | Change | Size |
|---|---|---|
| A failed conversation load shows "no conversations"; a failed message load shows nothing | Error state with Retry | S |
| A failed contacts load leaves old rows on screen with only a toast | Inline error, mark rows as stale | S |
| Contact search sends a request on every keystroke | Wait about 300 ms after typing stops | S |
| Inbox height uses `100vh` and assumes a 56px header (it is 60px) (*suspected*) | Use `dvh` and 60px | S |

### Links to other modules
| Gap | Change | Size |
|---|---|---|
| The chat side panel shows deals as plain text and has no orders, payments or appointments | Add those blocks, each linking to the record | M |
| No way to create an order, appointment or deal from a chat | Add them to the composer's plus menu, with the contact filled in | M |
| Contact profile has no appointments or payments; every deal links to the whole board | Add both lists; link each deal directly | M |
| The contact timeline leaves out deals, bookings, payments, campaigns received, flow runs and form answers | Add those event kinds | L |
| Three separate code paths start a conversation with a contact (*suspected*) | One shared helper | M |

### Architecture
| Gap | Change | Size |
|---|---|---|
| Each tab opens about six live streams; each queries the database every 2 seconds | One shared stream per tab; slow down when idle; cap streams per user | M |
| The side panel reloads about 10 queries every 30 seconds and on every new message | Reload only when the contact, deal or tags change | S |
| All conversations are held and filtered in the browser | Page the list on the server | L |
| Reminders are polled every 60 seconds in three separate places | One shared store | S |
| Contacts export builds up to 50,000 rows inside one request | Run large exports as a background job with a download notice | M |
| Very large files: message thread 2,037 lines, conversation list 1,474, composer 1,398, contacts page 1,711 | Split data loading from the screen markup | L |

---

## 2. Automation: flows, rules, sequences, forms, webhooks

What exists today: 16 flow triggers, 34 flow step types, 16 rule triggers, 15 rule steps, 14 outbound webhook events. Sequences are Instagram only.

### Features
| Gap | Change | Size |
|---|---|---|
| No WhatsApp sequences | Allow them, sending an approved template when the 24-hour window has closed | L |
| Sequences have no "stop when they reply / buy" rule | Add an "exit when" setting | M |
| Keyword rules default to "contains", so "hi" fires inside "this" **(confirmed by reviewer)** | Default to whole word; warn on short keywords; add "once per contact per N hours" | S |
| A rule's "Send webhook" throws the reply away and cannot do a GET | Reuse the flow's API request step | M |
| No "send test event" or "redeliver" for outbound webhooks | Add both | S |
| Webhook events missing for contacts, tags, deals, forms, shipping, returns, failed payments | Add them | M |
| Outside systems cannot start a flow | `POST /api/v1/flows/:id/start` | M |
| Flows still cannot book a paid service | Mark paid services in the picker now; allow paid holds later | L |

### UI
| Gap | Change | Size |
|---|---|---|
| A failed flow list load shows "no flows yet" | Error state with Retry | S |
| Three builders (rule, flow, sequence) with no guidance on which to pick | Start "New" with goals: "Reply to a keyword", "Welcome new contacts", "Follow up after a booking" | M |
| Rule run history stops at 100 rows, with no filter | Status filter, load more, failed-only view | S |
| Part of the rule builder is hard-coded English | Move the strings to the translation files | S |

### Links to other modules
| Gap | Change | Size |
|---|---|---|
| Rules and flows cannot react to payments, shipping, returns, form answers or deal stages | One internal event feed used by both engines and by webhooks | L |
| Flows cannot create or move a deal; rules can create one but not move it | Add "create deal" and "move deal stage" to both | M |
| A form answer starts nothing unless a flow is already waiting on it | Emit a form-submitted event; add "tag" and "notify team" on the form | M |
| Deleting a form or archiving a sequence does not check what uses it | Show "Used in N flows" and confirm first | S |
| Flow runs, rule logs and form answers show the contact as plain text | Link to the contact and the chat | S |
| The form page has no "send" button and no sent-versus-submitted figure (*suspected*) | Add both | M |

### Architecture
| Gap | Change | Size |
|---|---|---|
| The flow engine is one 4,725-line file; the rule engine repeats much of it, so each fix is made twice | Share the step code (send, tag, assign, notify, webhook, consent check); then split the flow engine by step group | L |
| The clean-up of timed-out flow runs reads 500 runs in no order | Oldest first, in pages | S |
| Every matching rule runs on one message with no limit | Cap rules per trigger and automated messages per contact per minute | S |
| Uncertain steps and uncertain webhook sends are visible only in the database | "Needs review" list with "was sent" and "retry" | M |

---

## 3. Campaigns, templates, ads, Instagram tools

### Features
| Gap | Change | Size |
|---|---|---|
| The same campaign can be created twice by a retry or second tab | Unique request id per campaign; warn on same template to same audience | S–M |
| No limit on how often a contact gets marketing; no quiet hours | "Skip anyone messaged in the last X days" and a send window | M |
| A sending campaign can only be paused, never stopped for good | "Cancel remaining" | S–M |
| A CSV audience adds people with no consent tick | Require a consent confirmation and record who gave it | S |
| A saved draft loses the CSV rows, header media, tracked link and extras **(re-checked)** | Save every field, from any step | M |
| No product or catalogue templates | Product template kind and a product picker | L |
| No A/B test of two templates | Later | M |
| Ads data is kept 90 days; rules act hourly, so a runaway ad can overspend for an hour | Say so on screen; add a daily cap | S |

### UI
| Gap | Change | Size |
|---|---|---|
| First broadcast takes five screens and asks for the name twice | Skip steps that have nothing to fill; default the name | S–M |
| If the reach count fails, it shows 0 and still lets you send | Show "could not count", block Send until known | S |
| Schedule time uses the browser's time zone, not the workspace's | Use the workspace time zone | S |
| Template picker has no search, filter or preview | Add search, category chips and the full preview | S |
| Template editor closes without warning and loses everything | Confirm on close | S |
| Template list hides load errors | Error state with Retry | S |
| Ad form loses everything if closed; non-admins are not told why "Create ad" is missing | Save a draft; show the missing step | S–M |
| Instagram insights label posts by the last 8 characters of an id | Show caption, thumbnail and link | S |
| Templates appear under both Campaigns and Settings | Keep one, redirect the other | S |

### Links to other modules
| Gap | Change | Size |
|---|---|---|
| Campaigns show no orders or revenue | Credit paid orders to the last campaign the buyer received or clicked | M |
| No "message the people who read but did not reply" from a campaign | "Create segment from this result" buttons | S |
| Template buttons cannot start a flow (*suspected*) | "Template button tapped" trigger | M |
| Ad creation cannot pick a product or choose which flow answers the click | Product picker and "on click, run flow" | M–L |
| Campaign recipients do not link to the contact or chat | Add links | S |
| Ads show chats and deals as numbers only | Make numbers open filtered lists | M |

### Architecture
| Gap | Change | Size |
|---|---|---|
| One campaign pass is still up to 1,000 sends with a fixed pause; no fairness between workspaces | Limit a pass to about 30 seconds, then requeue | M |
| Slow Meta ads and Instagram jobs share the inbound lane | Move them to the bulk lane | S |

---

## 4. Pipelines, appointments, orders, payments, shipping

### Features
| Gap | Change | Size |
|---|---|---|
| Orders cannot be found by the reference shown on screen | Search by that reference, or add a running order number | S |
| No returns queue; returns exist only inside each order | Returns tab with status filter | M |
| Sent quotes cannot be listed, tracked or revoked (the server side exists) | Quotes tab | S |
| No payment-state or date filter on orders; export drops one filter and silently stops at 5,000 rows | Add filters; pass all of them to the export; warn when cut | M |
| No bulk dispatch or bulk label | Row selection with bulk actions | M |
| Return window has no admin override; no reverse pickup | Override with a note | S |
| Reconciliation report has no export and no split by payment method | CSV and method split | S |
| Counter sale is admin-only, with no "cash given / change" and no print layout | Till permission for agents; tender and change; print receipt | S |
| Shipments are admin-only; parcel size typed every time; no rate or wallet balance shown | Agent permission; saved parcel preset; show rate and balance | M |
| Deals have no close date or lost reason; stage totals mix currencies and include closed deals | Add both fields; fix totals | S |

### UI
| Gap | Change | Size |
|---|---|---|
| Order detail page and order drawer are two different screens with different actions | One order view with a clear "next step" button | M |
| A failed orders load shows "No orders yet" | Error state with Retry | S |
| Money actions use the browser's plain confirm box | Proper dialog showing amount and order | S |
| Shipment and attention banners vanish silently when they fail to load | Show "could not load" | S |
| Pipeline cards block scrolling on touch screens **(re-checked)** | Long-press to drag; allow vertical scroll | S |
| "Delete pipeline" says archive but deletes **(re-checked)** | Fix the wording or really archive | S |
| Removing a stage with deals is a dead end | Offer "move deals to stage X" | S |
| Contact pickers search by name only, not phone; the deal form loads every contact into one dropdown | One shared picker that searches name and phone | S |
| Public booking page never confirms on screen; no price on service cards; no calendar file | Poll and show "Booked"; show price; add calendar download | M |
| Payments tab is not in the URL; no count on Exceptions; no load more | Fix all three | S |

### Links to other modules
| Gap | Change | Size |
|---|---|---|
| The order page shows no payments or refunds; the panel is built but never shown **(re-checked)** | Show it | S |
| Appointment payment status is stored but never displayed; cancelling a paid booking offers no refund | Paid badge and "Refund this payment" | M |
| Deals are not connected to orders or payments; paying does not move the deal | Link them; win the deal on payment | L |
| Appointment list links to the chat only, never to the contact | Add the contact link | S |

### Architecture
| Gap | Change | Size |
|---|---|---|
| The board loads every deal ever made into the browser | Open deals per stage with paging; totals from the database | M |
| Creating a pipeline and its stages is two calls; a failure leaves an empty pipeline | One server transaction | S |
| Appointment list stops at 500 rows with no notice | Show a notice | S |
| Order-state rules are written in several places | One shared module | M |

---

## 5. Store and public shop

Already covered in earlier answers: the five-save product editor, variants typed as text, look-alike templates, the 10-tab Sales menu and the long Store settings page.

### Buyer side
| Gap | Change | Size |
|---|---|---|
| Checkout moves the buyer to a second, differently styled page that lists all products again | Themed checkout with only cart, address and payment | L |
| Checkout needs a WhatsApp code; no guest or email option; no "resend code" | Guest checkout; resend with a countdown | L |
| Cart shows only a subtotal; shipping, coupon and total appear after verifying | Pincode and coupon boxes in the cart | M |
| Product page has no sticky buy bar on phones, no share button, and no "ask about this product on WhatsApp" | Add all three | S–M |
| Size and colour buttons never show a sold-out combination as unavailable | Grey them out | S |
| Product cards have no sale badge or quick add | Add both | S |
| Search shows 24 results with no paging or sort | Page and sort | S |
| Product and category links are long ids | Readable names with redirects | M |
| Tracking page has no photos and no "message the shop about this order" | Add both, plus a returns entry | S–M |
| Buyer account has no saved-items page, name or email | Add them | M |

### Seller side
| Gap | Change | Size |
|---|---|---|
| No sitemap, robots file or product data for Google; no per-product search title or share image **(re-checked)** | Add them; set the base URL | M |
| No custom domain **(re-checked: no field exists)** | Guided domain setup | L |
| Bulk actions on products are limited to "send new arrivals" | Bulk publish, hide, archive, category, price | M |
| No "open on shop / copy link / send on WhatsApp" per product | Add the menu | S |
| Inventory has no stock count mode, bulk update or "reorder low stock" | CSV update; "create purchase order from low stock" | M |
| Purchase orders have a free-text supplier, a 100-row limit and nothing to send | Suppliers list; PDF or WhatsApp share | M |
| Every review needs manual approval; no reply; no link to the order | Auto-publish option; reply; links | S–M |
| Shop reports have no funnel, no export except tax, no drill-down | Visits-to-paid funnel; CSV; row links | M |
| Imported Shopify and WooCommerce images still point at the old store (*suspected*) | Copy them into the media library | M |

### Links to other modules
| Gap | Change | Size |
|---|---|---|
| The AI cannot answer product, price or stock questions | Read-only catalogue source for the AI | M–L |
| Store events cannot start flows | See section 2 | L |
| A product does not show who asked about it or bought it | "Orders containing this product" | M |
| Ads cannot be made from a product or collection | See section 3 | M–L |

### Architecture
| Gap | Change | Size |
|---|---|---|
| Every shop page is rebuilt from the database on every visit | Cache public pages briefly; refresh on product save | M |
| Every product image passes through the app server and a database check, unresized | Serve from storage with long caching and sized versions | M |
| Silent limits: home page picks from 200 products, a category loads 500 then filters in code | Filter and page in the database; tell the seller when a limit is hit | M |
| Two product systems side by side: the Meta mirror ("Products") and the shop's own ("Catalogue"); two shop front ends (`storefront` and `shop-public`) | One product loader; show the Meta state as a column; retire the old front end after the themed checkout | L |

---

## 6. AI agents and analytics

### What the AI can do today
- **Sees:** the last 20 text messages and the top 5 knowledge matches.
- **Does not see:** catalogue, stock, prices, coupons, order status, tracking, bookings, contact name or tags.
- **Can do:** send text, hand off to staff. On Instagram it can also collect lead details.
- **Cannot do:** create an order, payment link or booking, tag a contact, start a flow, move a deal.

### Features
| Gap | Change | Size |
|---|---|---|
| The monthly token cap does not apply to auto-replies **(re-checked)** | Apply it; warn at 80% | M |
| No retry when the AI provider is busy or times out; the reply becomes a handoff | Retry once or twice | S |
| A reply with no knowledge behind it still goes out at every confidence setting | "Hand off when nothing matched" switch | S |
| The handoff note is a fixed line, not a summary | Attach the existing summary | S |
| After a handoff the AI stays off for that chat (*suspected*) | Resume when the chat is resolved and the customer returns | S |
| Agents cannot have their own knowledge or model | Tag knowledge sources to agents | M |
| Lead-capture goals exist on Instagram only | Allow them on WhatsApp | M |
| No cost or "time saved" figure anywhere; usage is in tokens only | Estimated cost and "chats the AI closed alone" | M |
| Sensitive-topic check cannot be tuned and misses Indian scripts | Workspace switch; add scripts | S |
| PDF reports cannot print Hindi, Telugu or emoji | Embed a font that can | M |
| Knowledge limits (50 sources, 500 pages, text cut at 100,000 characters) may be hit silently (*suspected*) | Show "indexed N of M" per source | S |

### UI
| Gap | Change | Size |
|---|---|---|
| The dashboard shows loading skeletons forever when a request fails **(re-checked)** | Error and Retry, as the analytics tabs already do | S |
| AI setup asks for the provider key last, far down the page; eight tabs | Make "connect provider" step 1; group Learnings, Usage and Activity | M |
| The model name is free text | Dropdown with a recommended choice and "test connection" | M |
| Dashboard cards use the browser's day; charts use the workspace's day | Use the workspace day for both | S |
| Three different "response time" figures with no labels | One definition, or label each | M |

### Links to other modules
| Gap | Change | Size |
|---|---|---|
| The home dashboard has no revenue, bookings, ad spend or AI figures | Add cards that link to each module | M |
| Most charts do not open the records behind them | Make AI and store tiles clickable | M |
| Staff cannot see why the AI stayed silent on a chat (*suspected*) | Show the reason in the inbox | M |

### Architecture
| Gap | Change | Size |
|---|---|---|
| The dashboard scans the whole message history on every load | Limit to open chats or the last 30 days | M |
| Analytics run live over all messages with a 15-second limit | Daily summary table | L |
| The AI rate limit lives in process memory | Count in the database | M |
| Tables silently show "top 50" or "newest 100" (*suspected*) | Show "N of M" | S |

---

## 7. Navigation and screen consistency

### Navigation
| Gap | Change | Size |
|---|---|---|
| Six pages show "Dashboard" as their title (catalogue, online store, reviews, shop reports, store settings, reports) | Take the title from the menu definition | S |
| Search (Ctrl+K) finds pages only, not contacts, orders or products | Add record search and "create new" actions | L |
| The home page sits inside Analytics; there is no "Home" | Give Home its own entry | S |
| The setup checklist covers WhatsApp, Instagram, automation and team only | One workspace checklist linking to store, payments, bookings, AI and ads | M |
| No bell notice for new orders, COD confirmations, shipment problems, reviews, low stock, form answers or AI handoffs | Add them; add a dot on Sales and Campaigns | M |
| Sales has 10 tabs with look-alike names | Group into Sales, Catalogue and Store | M |
| Repeated names: "Analytics" inside Analytics, "Campaigns" in two places, "Ads" in three | Rename | S |
| The AI page's tabs have no link of their own | Use `?tab=` | S |
| Nine Instagram pages hide behind one tab | Second row of tabs | M |
| Settings live in about nine places | Settings search; "related settings" links | S |
| The first-run checklist still points at the old `/flows` address | Update it | S |

### Screen consistency
| Gap | Change | Size |
|---|---|---|
| Two page titles on every screen | Make the top bar a breadcrumb | S |
| The page header is copied about 30 times with different sizes | One shared header | M |
| About 30 destructive actions use the browser's plain confirm box | One shared confirm dialog | M |
| Save behaviour differs: one save per page, per card, or autosave | Pick one per page type; warn on unsaved changes everywhere | M |
| 250 plain dropdowns next to the shared one; 31 plain checkboxes | Move over gradually, starting with Contacts and Orders | L |
| Empty, loading and error states are built per screen | Three shared components | M |
| Four money formatters; mixed date formats | One of each | M |
| Orders header has five buttons | One main button, the rest in a menu | S |
| Default button height is 32px, small for touch (*suspected*) | Larger on touch screens | S |
| Several "contact" links take an extra redirect | Link straight to the profile | S |

### How records link to each other

| Pair | Today |
|---|---|
| Chat and contact | Both ways |
| Chat and order | Both ways, but no "new order" from chat |
| Chat and payment | Both ways |
| Chat and appointment | Appointment opens chat only |
| Chat and deal | Deal opens chat only; chat shows deals as text |
| Chat and flow run | Chat lists runs; runs do not link back |
| Chat and campaign | Not linked |
| Chat and ad | Badge goes to Meta, not to the ad in Bodhinox |
| Contact and order | Both ways |
| Contact and deal | Deal opens contact; contact links to the whole board |
| Contact and appointment | Appointment opens contact only |
| Contact and payment | Payment opens contact only |
| Contact and campaign | Not linked |
| Order and payment | Both ways in data; payments not shown on the order page |
| Order and deal | Not linked |
| Order and campaign | Not linked |
| Order and product | Order shows products; product shows no orders |
| Ad and order or deal | Counts only |
| Order and payment events to flows or rules | Only `order_received`, for flows |

---

## 8. Platform and architecture

Size today: 2,038 source files, 558 API routes, 256 database tables, about 65 kinds of background job, 1,171 test files.

### Recommended changes, in order

1. **Split the inbound lane.** One "main" worker slot handles every workspace's inbound messages, AI replies (up to 30 seconds each), flow timers, webhooks and sweeps in a single line **(re-checked)**. First step: move sweeps and timers to their own lane. Then run several inbound slots with a lock per conversation so order is kept.
2. **Move rate limits and live updates off per-process memory.** This is what forces one web server. First step: store rate limits in the database; poll for live updates every 5 seconds when idle.
3. **Close the alerting gaps.** Failed jobs raise no alert, and sends stuck in "dispatching" are not counted **(re-checked)**. Then build the list of uncertain sends.
4. **Stop unbounded growth.** A job row is written per active workspace every 30 seconds and kept 30 days. Send records, expired sessions and rate-limit rows are never pruned. Add them to the hourly clean-up.
5. **Harden the public edge.** Add a per-IP limit on sign-up and login **(re-checked)**. Make the API key scope a required argument. Upgrade Next.js and add a dependency check to CI. Turn the browser content policy from report-only into an enforced one.
6. **Language per user.** The language is fixed when the app is built, so one deployment serves one language. First step: store the language on the user and use it for emails.
7. **Tidy the module layout.** Old and new versions sit side by side: `automation` and `automations`, `catalog` and `catalogue`, `storefront` and `shop-public`. Three ways of reading the database are mixed. Write one rule for new code and rename by meaning.
8. **Prove recovery.** Backups have never been restored as a test. Do one restore drill and record it.

### Other findings
| Gap | Change | Size |
|---|---|---|
| The scheduler runs about 20 sweeps one after another on one timer | Time each step; warn over 5 seconds | S |
| Every signed-in request runs 2 to 3 session queries | Cache the session for a few seconds | S |
| A Meta server error is treated as "unknown" and never retried (*suspected*) | Retry clear refusals | S |
| Uploads are read fully into memory and the file type is trusted from the browser | Direct upload links; check the real file type | M |
| Raw message text is kept 30 days in a table with no workspace column | Strip text after processing; keep 7 days | S–M |
| Workspace deletion is off by default and untested on a large workspace | Test on a restored copy first | M |
| The worker runs uncompiled code in production, with no health check | Build it in CI | M |
| Worker death is noticed only by an outside monitor | Check from the web service every minute | S |
| Logs are plain console lines with no request id or error tracker | Add an error code on failed jobs and a request id | S–M |
| Feature switches are environment variables that need a redeploy | Small switches table, per workspace | M |
| 34 files still mention "supabase" and 24 "wacrm" | Remove stale comments | S |
| The deployment guide is a 614-line change log | Keep current setup only; move history to a changelog | S |
| Help is English only and not searchable | Label it, or translate the top three pages | S |

### What is done well and should be kept
- Workspace separation is enforced in the database, with tests that sweep every table.
- Webhooks are saved before they are acknowledged, and every send is recorded before it goes out, so nothing is sent twice after an unclear result.
- Money paths use request ids, so a retry never charges or refunds twice.
- Sessions, CSRF checks and media serving are careful.
- Translations are complete in four languages (15,570 keys each).
- Database changes are additive and checked in CI.

---

## Suggested order of work

**Week 1: small fixes with large effect**
- Error and Retry on every list.
- Payments on the order page.
- Fix "Delete pipeline".
- Per-IP login limit.
- Upgrade Next.js.
- Failed-job and stuck-send alerts.
- Campaign double-send guard.
- Page titles.

**Weeks 2–3: daily use**
- One-page Add product.
- Chat side panel with orders, payments and bookings.
- One shared confirm dialog, page header, and empty/loading/error components.
- Sales menu regrouped.

**Weeks 4–6: connecting the modules**
- Event feed for flows and rules (order paid, shipped, form submitted, deal stage).
- AI reads catalogue and order status.
- Campaign revenue.
- Inbound worker lane split.

**After that: the larger builds**
- Themed checkout.
- Distinct templates.
- WhatsApp sequences.
- Sitemap and custom domain.
- Daily analytics summaries.
