# Store, orders and payments

## Store, orders and payments

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
  Dispatched → Delivered (the order shows whether each step was courier confirmed or staff recorded). Older orders without store pricing can still go Confirmed → Delivered.
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

### Courier shipping (Shiprocket)

1. In Shiprocket: Settings → API → Create an API user (not your own login).
2. In Bodhinox: Settings → Meetings & shipping → Shiprocket. Enter the API user email and password, press **Check details**, choose the pickup location, optionally set a default package, and **Connect Shiprocket**.
3. Press **Generate token**, copy the webhook URL and the token (shown once) into Shiprocket → Settings → API → Webhooks.
4. On a paid order, **Create shipment**, check the package size and confirm. This charges your Shiprocket wallet. The AWB, courier and tracking status appear on the order; use **Track**, **Label**, **Cancel shipment** (before pickup) or **Assign courier again** (only after Shiprocket refused the courier assignment).
5. If Shiprocket did not confirm a shipment or a courier assignment, Bodhinox never repeats it automatically; it looks it up and, if it cannot find it, opens a shipment exception for an admin.

- **Courier tracking.** When Shiprocket is connected and an order has a shipment, tracking moves the order to Dispatched and Delivered by itself and sends the usual customer notices once. You can still record dispatch or delivery yourself; the order shows whether each step was **Courier confirmed**, **Staff recorded** or **Not confirmed**.
- **Cancelling a shipped order.** Cancel and refund is refused while a courier shipment is live. Cancel the shipment first, or, once it was picked up, use Returns.
- **Shipments that need attention** (admins, Orders page): tracking that changed after a final status, parcels returning to origin, lost or damaged parcels, and courier updates that disagree with the order. Accepting a correction updates the shipment only; the order's status never moves backwards, so use Returns for goods that come back.

### Order notice templates
Go to Commerce → Store settings → Order notice templates. Choose an approved template for:
- the dispatched notice, the delivered notice and the feedback request. These need **utility** templates;
- the reorder reminder. This needs a **marketing** template.

These templates are used only after the customer's 24-hour WhatsApp window has closed. Inside the window, Bodhinox sends a short text instead, and the dispatched text includes the courier tracking link when the order has a Shiprocket shipment. A warning appears when a chosen template is no longer approved. Only admins can change these settings.

### Reorder reminders
1. In the product editor, set **Reorder reminder after (days)**, for example 30 for a month's supply.
2. Choose a marketing template for **Reorder reminder** in Store settings.
3. Customers who tick "Send me reorder reminders and offers on WhatsApp" at checkout get one reminder that many days after delivery.

Customers who do not tick the box, and anyone who has ever replied STOP, never receive it. Orders placed before this checkbox existed never receive it either. On the order's timeline under Messages, a reminder that was not sent shows the reason, for example "no_marketing_consent".

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
