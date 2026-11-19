# Store plan Phase 8, batch 8: the big or external items

What each one needs before it can be real, and the smallest useful version. Nothing here fakes an integration:
an item that needs an outside account stays unbuilt until the owner has that account.

| Item | Needs from outside | Big decisions | Smallest useful version | Status |
|---|---|---|---|---|
| Subscriptions (Razorpay) | Razorpay Subscriptions enabled on the owner's Razorpay account (plans API, mandate/e-mandate or UPI Autopay approval), webhook secret | Billing cycles, failed-payment retries and dunning, proration, pausing, how a renewal becomes an order and takes stock | A "subscribe" product that creates a Razorpay plan + subscription link; each `subscription.charged` webhook places a normal paid order through the existing pricing and stock path | Not built: needs the Razorpay Subscriptions product switched on and tested on the owner's account |
| Marketplace channels (Amazon, Flipkart, Meesho) | Seller accounts and approved API/partner access on each marketplace (Amazon SP-API developer registration, Flipkart/Meesho seller APIs) | Which side owns stock and price, order import and cancellation sync, catalogue mapping per marketplace category | One channel at a time: push stock counts out and pull orders in as `source = <channel>` orders | Not built: needs seller and API approvals |
| International tax and duties | A tax/duty data source (rates per country and HS code) or a provider (for example a landed-cost API), export compliance (IEC, LUT for GST-free exports) | Duties paid by buyer or shop, which countries to sell to, currencies | Per-country flat tax rate and "duties paid by buyer" notice, priced in the existing engine | Not built: needs the owner's export setup and a rate source |
| Several shops per workspace | None | Today one workspace = one shop handle; settings, theme, stock, price rules and reports are per workspace | A second shop is a separate workspace today (the app already supports several workspaces per user) | Not built here: making it in-workspace touches every store table (a `shop_id` on each) and is a phase of its own, not a batch. Recommend: keep "one shop per workspace" and use a second workspace |
| Buying a domain in-app | A registrar reseller account (for example a registrar API with prepaid balance), payment collection, DNS hosting | Who pays and owns the domain, renewals, refunds | Connect a domain the owner already bought (point DNS + TLS on the host) | Not built: needs a registrar reseller account and pricing decision |
| Point of sale (POS-lite) | None for a cash/UPI-QR counter; card readers need a payment terminal provider | Offline use, receipt printer, cash drawer | A staff "counter order" screen = the existing manual order flow (batch 1-4 pricing, stock, receipts) on a phone, paid by cash or UPI marked by staff | Built (POS-lite counter screen): a staff screen that makes a manual order and records the cash/UPI payment with the existing "Record offline payment" path, in one flow. No card reader |
| App platform | None, but it is a large product: OAuth apps, scopes, webhooks, review and a security model | Who can publish apps, what data they may read | Outgoing webhooks for order events with a signing secret | Not built: a platform needs its own design and review |
| Theme marketplace | Payments to theme authors, review process | Licensing, sandboxing third-party theme code | More built-in templates (six exist) | Not built |
| SMS order messages | An SMS provider account and, in India, DLT registration of the sender ID and every template | Which messages go by SMS vs WhatsApp, cost per SMS | Order placed/shipped SMS through one provider, only when WhatsApp delivery fails | Not built: needs a provider account and DLT approvals |

## Built in batch 8

Only POS-lite. Several shops per workspace needs no outside account but is too large for a batch (a `shop_id`
on every store table); everything else needs an outside account or approval. See the status column.
