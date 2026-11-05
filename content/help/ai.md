# AI assistant

## Configure AI Agents

The current **Agents** page configures an **account-level AI assistant**, not a gallery of independent named bots.

1. Open **Agents → Setup**. Choose OpenAI, Anthropic, or OpenAI-compatible; enter the model and API key (plus base URL for a compatible provider). Set a clear system prompt and, if using knowledge search, its embedding credential and knowledge documents.
2. Use **Test** to check the provider credentials, then **Save**. Open **Playground** and ask a sample customer question, for example `What is your annual plan?` Verify the draft against your approved business facts.
3. Start with human-reviewed drafts. Only then enable the **Active** and **Automatic replies** options if desired, set a per-conversation reply maximum, and choose a human handoff teammate/queue. Keep the worker and WhatsApp connection healthy. **Usage** is visible to owner/admin.
4. Example: add a knowledge document describing Basic and Enterprise plans. Asha asks `What is included in Enterprise?`; the AI may draft an answer for an agent to review. Automatic sending is a separate switch and should be enabled only after real test conversations and clear escalation rules.

No AI vendor credentials are preconfigured. The model can only answer accurately from material you provide and approve.

## AI business assistant

The assistant helps your team; it never acts on its own. Summaries, suggested replies, assessments and insights are shown to members, and nothing reaches a customer until a member reviews it and presses Send. It never marks a payment, attendance or delivery as confirmed, never gives medical advice, and routes health questions to qualified staff. (AI auto-reply and the flow AI reply step, which already existed, still send without review; they now hand health questions and unsafe answers to staff instead.)

### Turning it on (admins)
- **Settings → AI assistant** (admins and owners) has four switches: **Summaries**, **Suggested replies**, **Intent and lead assessment** and **Business insights**. All are off until you turn them on. You can also set a monthly AI token cap for the workspace (empty means only your plan's limit applies). The cap stops summaries, suggested replies, assessments and insights once reached; auto-replies, flow AI replies and Draft are counted towards it but are limited by your plan's monthly AI messages instead.
- A switched-on feature still needs an active AI key (AI Agents → Setup). The status line on the page tells you when the key is missing or AI is turned off for the whole deployment.
- What each role can do is in Settings → Team members → Permissions: "AI summaries, suggested replies and drafts", "Refresh AI lead assessments", "Request AI business insights", "Control who can see knowledge sources" and "Manage AI assistant settings". Taking the first one away from agents also removes their ✨ Draft.

### In the inbox
- **Summarize with AI** shows a summary of the conversation for staff only, with open questions and next steps. Any statement about a payment, refund, appointment or delivery is replaced with "[check the order/payment/appointment record]": always check the real record.
- **Suggested replies:** the ✨ button in the composer shows up to three replies with the knowledge they used. **Use** puts the text in the composer; edit it and press Send yourself. If suggested replies are off, ✨ gives the usual single AI draft.
- When the customer asks about a health topic (symptoms, treatment, dosage, emergencies, pregnancy), you see **Route to qualified staff** instead of text: assign the conversation from the control at the top of the thread.
- **Assessment** (contact panel): the customer's likely intent (pricing, purchase, booking, support, order status, complaint and so on), how sure it is, buying signals and a lead score from 0 to 100, with when it was assessed and whether it came from AI or keyword matching. **Refresh** reassesses now (once per 10 minutes). Keyword-only results have no score. The contacts list shows a small lead-score badge next to each name. Assessments are advice only: they never tag, create deals or send anything.

### Knowledge access (admins)
- AI Agents → Knowledge: each source has **Visible to** (agents and above, or admins only) and **Use in customer replies**. Customer-facing text (Draft, suggested replies, auto-reply, flow AI replies) uses only sources marked for customer replies and visible to agents. Admin-only sources are never used for customers. Existing and uploaded sources start as visible to agents and used in customer replies.

### Business insights
- Analytics → **AI insights** (agents and above): pick an insight (conversation volume, response times, agent workload, campaign funnel, flow outcomes, template delivery, AI performance, commerce sales) and a period. The numbers come from the same reports as the Analytics page; a short written summary is added, by AI when it is available and every number it quotes matches the data, otherwise from a template. Each insight shows its data range, when it was read, how much of the period it covers, caveats, how certain it is, and a link to the report. Up to three insights can be waiting at once.

### AI quality (admins)
- Below the switches, **AI quality** shows the last 30 days: how many suggested replies were sent as written, edited, rejected or left unused, how much people changed them, summaries, route-to-staff items, which safety checks fired, how many assessments used AI vs keywords, and AI tokens used this month. It shows counts only, never message text.

### Data kept
- Suggested reply text is cleared after 30 days and the records removed after 180; old assessments are removed after 30 days (all after 180), insights after 90 days and AI usage records after 400 days.
