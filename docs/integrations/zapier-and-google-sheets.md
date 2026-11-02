# Zapier and Google Sheets

Bodhinox connects to Zapier and Google Sheets in two directions:

- **Out of Bodhinox:** outbound webhooks. Bodhinox POSTs a signed JSON event to a
  URL you choose when something happens (an order arrives, a payment link is
  paid, a message comes in, and so on).
- **Into Bodhinox:** the public REST API (`/api/v1`). A Zap calls it with an API
  key to send a WhatsApp message, create a contact or start a broadcast.

Both are described in full in [docs/public-api.md](../public-api.md). This page
gives two step-by-step recipes and the commerce event payloads.

## Events you can send to Zapier or a sheet

Choose events when you add the webhook in **Settings → API & webhooks →
Add webhook**:

| Event | Sent when |
| --- | --- |
| `message.received` | A contact sends you a message |
| `message.status_updated` | A message you sent was sent, delivered, read or failed |
| `conversation.created` | A new conversation opens |
| `broadcast.completed` | A broadcast finishes, with its counts |
| `template.status_updated` | Meta approves, rejects or pauses a template |
| `flow.completed` | A chatbot flow finishes, with the answers it collected |
| `order.created` | A store order is received (Shopify, WooCommerce or a WhatsApp cart) |
| `order.paid` | A store order is paid |
| `payment_link.paid` | A payment link sent from Bodhinox is paid in full |

Every delivery has the same envelope. `id` is unique per delivery: use it to
ignore a delivery you have already handled.

```json
{
  "id": "6c1d2f0e-6a43-4c39-9a8e-2f7b1f3c9d10",
  "event": "order.created",
  "occurred_at": "2026-11-02T10:00:00.000Z",
  "account_id": "…",
  "data": { "…": "per event, below" }
}
```

### `order.created` and `order.paid`

```json
{
  "order_id": "b0c6…",
  "source": "woocommerce",
  "external_id": "5001",
  "order_number": "5001",
  "status": "processing",
  "total_minor": 149950,
  "total": "₹1,499.50",
  "currency": "INR",
  "item_count": 3,
  "contact_id": "4f2a…",
  "conversation_id": null,
  "customer_name": "Asha Rao",
  "customer_phone": "+919876543210",
  "occurred_at": "2026-11-02T10:00:00.000Z"
}
```

`total_minor` is the exact amount in the currency's smallest unit (paise,
cents). `total` is the same amount formatted for people. Fields Bodhinox does
not know are `null`; `order_id` is null when the order is not stored in Bodhinox
(for example a WooCommerce order).

### `payment_link.paid`

```json
{
  "payment_link_id": "1e7f…",
  "provider": "razorpay",
  "reference_id": "q3J8v…",
  "provider_link_id": "plink_…",
  "amount_minor": 50000,
  "amount_paid_minor": 50000,
  "amount_paid": "₹500.00",
  "currency": "INR",
  "order_id": null,
  "contact_id": "4f2a…",
  "conversation_id": "9a0b…",
  "paid_at": "2026-11-02T10:05:00.000Z"
}
```

Deliveries are best effort and can, rarely, arrive twice or out of order. Always
skip an `id` you have already seen, and check the source system when an exact
total matters.

## Recipe 1: Zapier

### Bodhinox event → Zap (trigger)

1. In Zapier, create a Zap. For the trigger choose **Webhooks by Zapier →
   Catch Raw Hook** (Catch Raw Hook keeps the request headers and the exact
   body, which you need to check the signature). Copy the hook URL Zapier shows.
2. In Bodhinox, open **Settings → API & webhooks → Add webhook**. Paste the
   Zapier URL, tick the events you want (for example `order.paid`) and save.
   Copy the **signing secret**; it is shown only once.
3. Back in Zapier, add a **Code by Zapier → Run JavaScript** step that checks the
   signature. Map `raw_body` and the `X-Wacrm-Signature` header from the trigger
   into the input data as `raw_body` and `signature`, and keep the secret in the
   code step (or a Zapier storage value):

   ```js
   const crypto = require('crypto');
   const secret = 'PASTE_THE_SIGNING_SECRET';
   const match = /t=(\d+),v1=([0-9a-f]{64})/.exec(inputData.signature || '');
   if (!match) throw new Error('Missing signature');
   const [, t, v1] = match;
   const expected = crypto.createHmac('sha256', secret).update(`${t}.${inputData.raw_body}`).digest('hex');
   const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
   if (!fresh || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) {
     throw new Error('Signature check failed');
   }
   const event = JSON.parse(inputData.raw_body);
   return { id: event.id, event: event.event, ...event.data };
   ```

4. Add your actions, using the fields the code step returns (`order_number`,
   `total`, `customer_phone`…). To add a row to Google Sheets, use **Google
   Sheets → Create Spreadsheet Row**. This is the simplest way to get Bodhinox
   events into a sheet.
5. Turn the Zap on, then trigger a real event (or use **Test** in Zapier).

### Zap → Bodhinox (action)

1. In Bodhinox, open **Settings → API keys → New API key**. Name it "Zapier" and
   grant only the scopes the Zap needs, such as `messages:send` or
   `contacts:write`. Copy the key; it is shown only once.
2. In Zapier, add a **Webhooks by Zapier → Custom Request** action:
   - Method: `POST`
   - URL: `https://<your Bodhinox address>/api/v1/messages`
   - Headers: `Authorization: Bearer <your API key>` and
     `Content-Type: application/json`
   - Data (send an approved template):

     ```json
     {
       "to": "+919876543210",
       "type": "template",
       "template": { "name": "order_update", "language": "en", "params": ["5001", "₹1,499.50"] }
     }
     ```

   `to` must be in international format with a leading `+`. Map it from your
   trigger.
3. Test the step. A `201` response contains the `message_id` and
   `conversation_id`.

Keep the API key in Zapier only, and revoke it in **Settings → API keys** if the
Zap is deleted or the key may have leaked.

## Recipe 2: Google Sheets with Apps Script

Use this when you want a sheet that fills itself without Zapier. Two Google
limitations decide how it works:

- **Apps Script cannot read request headers**, so a script cannot check the
  `X-Wacrm-Signature` header. The script below checks a long random token in the
  URL instead, and skips deliveries it has already written.
- **An Apps Script web app answers every POST with a redirect (HTTP 302)**.
  Bodhinox does not follow redirects for security reasons and counts the reply
  as a failed delivery, even though the script has already run. The delivery is
  then retried, and after 15 failures in a row Bodhinox pauses the webhook.

Because of the second point, do not point a Bodhinox webhook straight at an Apps
Script URL. Put a relay in front that checks the signature and then calls the
script: the Zapier recipe above (Catch Raw Hook → Code → **Webhooks by Zapier →
POST** to the script URL), or a small serverless function of your own. The
script then only needs the URL token.

### 1. Create the sheet and the script

1. Create a Google Sheet. Name the first tab `Events` and add this header row:
   `id`, `event`, `occurred_at`, `order_number`, `total`, `customer_name`,
   `customer_phone`, `status`.
2. Open **Extensions → Apps Script** and replace the code with:

   ```js
   // Set this in Project Settings → Script properties as TOKEN: a long random value.
   const TOKEN = PropertiesService.getScriptProperties().getProperty('TOKEN');
   const COLUMNS = ['id', 'event', 'occurred_at', 'order_number', 'total', 'customer_name', 'customer_phone', 'status'];

   function doPost(e) {
     if (!TOKEN || !e || !e.parameter || e.parameter.token !== TOKEN) {
       return ContentService.createTextOutput('forbidden');
     }
     let event;
     try {
       event = JSON.parse(e.postData.contents);
     } catch (err) {
       return ContentService.createTextOutput('bad request');
     }
     if (!event || typeof event.id !== 'string') return ContentService.createTextOutput('bad request');

     const lock = LockService.getScriptLock();
     lock.waitLock(10000);
     try {
       const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Events');
       // Skip a delivery that is already in the sheet.
       const seen = sheet.getRange('A:A').createTextFinder(event.id).matchEntireCell(true).findNext();
       if (seen) return ContentService.createTextOutput('duplicate');
       const data = event.data || {};
       const flat = { id: event.id, event: event.event, occurred_at: event.occurred_at, ...data };
       sheet.appendRow(COLUMNS.map((name) => asText(flat[name])));
     } finally {
       lock.releaseLock();
     }
     return ContentService.createTextOutput('ok');
   }

   // A leading apostrophe makes Sheets store the value as text, so a phone
   // number keeps its + and a value starting with = is never run as a formula.
   function asText(value) {
     if (value === undefined || value === null) return '';
     const text = String(value);
     return /^[=+\-@]/.test(text) ? "'" + text : text;
   }
   ```

3. In **Project Settings → Script properties**, add `TOKEN` with a long random
   value (for example 40 random letters and digits).
4. Click **Deploy → New deployment → Web app**. Execute as **Me**, access
   **Anyone**. Copy the web app URL and add `?token=<your TOKEN>` to it.

`asText` stores every value as text: a phone number such as `+919876543210`
keeps its `+`, and a customer name that starts with `=` cannot run as a
formula in your sheet.

### 2. Connect it through the relay

In the relay (for example the Zap from Recipe 1), after the signature check,
POST the original raw body to the web app URL with the token. The relay sees the
302 from Google, which is expected; check the sheet to confirm rows arrive.

### 3. Test

Trigger an event in Bodhinox (for example place a test order in your store)
and check that one row appears. Trigger the same delivery again from the relay:
no second row should appear.

## Security notes

- Treat the webhook signing secret, the API key and the script token like
  passwords. Never put them in a shared sheet.
- Rows contain customer names and phone numbers. Share the sheet only with
  people who may see that data, and delete rows you no longer need.
- To stop sending, pause or delete the webhook in **Settings → API & webhooks**.
