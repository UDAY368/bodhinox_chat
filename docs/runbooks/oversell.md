# Oversell exceptions

Requirement ids: COM-02, PAY-02. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

- **How oversell is prevented:**
  - Checkout and WhatsApp carts reserve stock under row locks (`src/lib/commerce/stock.ts`). A reservation that cannot be met fails with `out_of_stock` before payment.
  - Holds expire through `commerce.reservation_expiry`; the worker must be running.
- **How oversell can still appear:**
  - A customer pays after the hold expired and the stock was sold. Settlement moves the order to `payment_review` and opens `late_payment_no_stock` in Payments → Exceptions. It is never fulfilled silently, and dispatch is refused while the order is under review.
  - Orders from external stores (Shopify, WooCommerce) are recorded as commerce events only. They do not touch Bodhinox stock, so stock in those stores is the store's responsibility.
- **Steps:**
  1. **Restock and accept.** Use exception action "restocked". It is refused while a refund on the payment is in flight.
  2. **Or refund.** A full refund closes a `payment_review` order as cancelled.
  3. Tell the customer the expected dispatch date, or that the refund was issued.
- **Verification:**
  - the order is `paid` (accepted) or `cancelled` (refunded);
  - the exception is resolved;
  - inventory `on_hand` and `reserved` match the shelf.
- **Customer communication:** a template message with the new date or the refund; never promise a date before restock.
