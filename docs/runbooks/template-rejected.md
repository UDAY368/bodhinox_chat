# Rejected WhatsApp template

Requirement ids: WA-04. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

- **Detection:**
  - the template status webhook (`message_template_status_update`, `src/lib/whatsapp/template-webhook.ts`) stores `REJECTED` and the reason;
  - the template list shows the rejected banner;
  - the contract test pins how send error 132001 (template missing or not approved) is read.
- **Impact:** scheduled broadcasts, flows, commerce rules (Shopify/Woo `commerce_event_rules`) and checkout-template sends that use it fail or are recorded as blocked.
- **Steps:**
  1. Read the rejection reason.
  2. Edit and resubmit. Meta allows 10 edits in 30 days and 1 per 24 hours for an approved template.
  3. If the category is wrong (marketing vs utility), recreate the template in the right category.
  4. Find the affected broadcasts, flows and rules. Cancel campaigns that have not started (Broadcasts, `DELETE /api/broadcasts/[id]/schedule`) or switch them to an approved template; pause flows and rules or switch their template. A campaign already sending cannot be stopped today.
  5. While rehearsing, use `WHATSAPP_TEMPLATES_DRY_RUN` so nothing is submitted.
- **Verification:** status `APPROVED`, then one test send to an internal number.
- **Customer communication:** none unless a scheduled campaign was missed.
- **Follow-up:** keep a list of approved fallback templates per use case.
