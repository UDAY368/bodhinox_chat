# Templates, broadcasts and ads

## Templates and Broadcasts

1. In **Settings → Templates**, create a WhatsApp template with name, language, category, body and any variables/media, then submit it to Meta. You can also **Sync from Meta**. Wait for an **approved** status before using it for business-initiated or out-of-window sends.
2. In **Broadcasts → New**, choose an approved template. Select **All**, **Tags**, **Custom field**, or **CSV** audience, then exclude unsuitable tags and map template variables to static/contact/custom-field values. Start with one opted-in test contact and review the estimated reach.
3. Name and confirm the broadcast. Watch its detail page for recipient, delivery/read/reply state and retry controls. The current wizard labels its last stage **Schedule / Send**, but it **does not expose a future-date scheduler**; confirmation starts the send. Campaigns are limited to 1,000 recipients per campaign in this foundation.
4. Do not use broad audiences until Meta, opt-in, template variables, worker processing, and a one-recipient send have all passed on the real sender. An uncertain provider result must be reconciled before retrying to avoid duplicates.

## Click-to-WhatsApp ads

The **Ads** page (sidebar) collects what happens after someone taps a click-to-WhatsApp ad.

1. **Not enabled yet.** Until the platform's Meta app is approved for ads and an administrator turns ads on for the deployment, the Ads page and **Settings → Ads** say so. Nothing on these screens contacts Facebook while they are off. Conversations that customers start from your ads are still recorded from the WhatsApp messages themselves; they show as **Started from an ad** in **Analytics → Overview** under conversations by source.
2. **Connect (admins).** When ads are enabled, open **Settings → Ads**, choose **Connect with Facebook**, sign in, then pick one ad account and one Facebook Page for the workspace. The card lists any permission you did not grant and which feature it blocks. **Disconnect** stops lead delivery for the Page and removes the stored tokens.
3. **Ads tab.** Campaigns and ads with spend, clicks, conversations started (Meta's figure) and conversations that actually reached your inbox, plus purchases. **Retarget** opens the segment builder with a "clicked this ad" condition; save the segment and use it as a campaign audience. Opt-out and consent rules apply as for any campaign.
4. **Leads tab.** Leads from your Facebook lead forms, filterable by form, ad and date. A lead with a phone number is matched to an existing contact or creates one, but it is **not** opted in to WhatsApp: ask for consent in the lead form. **Broadcast to these leads** (agents and above) saves a lead-form segment and opens a new campaign with that segment already chosen as the audience. Admins can export the list as CSV (needs the contact export plan feature) and delete a lead when a person asks to be erased. Members whose phone numbers are masked see lead phone answers masked too.
5. **Conversions tab (admins).** Purchases (paid payment links and orders), lead-form submissions on WhatsApp and the **Conversion event** flow step (any event except Purchase, which is always reported from the order or payment link) are reported to Meta for customers who came from an ad in the last 7 days, once each, when the Conversions API is switched on for a WhatsApp number in Settings → Ads. If a send's outcome is unknown (for example a timeout), it waits under **Outcome unknown**: check Meta Events Manager and record whether it arrived. It is never re-sent automatically.
6. **Flows and automations.** The trigger **A customer messages you from an ad** starts a flow (or automation) when a message arrives from an ad, optionally only for listed ad IDs. A flow that is already running for that customer keeps running.

Creating or editing ads is done in Meta Ads Manager; Bodhinox does not create ads or spend budget.
