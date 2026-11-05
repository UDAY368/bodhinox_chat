# Flows and automations

## Create a visual Flow

A **Flow** is a structured WhatsApp conversation with nodes and branches. It starts on a keyword, a contact's first inbound message, or a manual trigger. A Flow is different from an **Automation**, which is a general event rule with a sequence of actions.

1. Open **Flows → Create**, or clone a starter: **Welcome menu**, **FAQ bot**, or **Lead capture**. A new blank flow starts as a draft.
2. Give it a name and trigger. For example, set trigger **Keyword** to `pricing`.
3. In the builder, connect **Start → Send buttons** with the text `Which plan would you like?` and buttons `Basic` and `Enterprise`. Route each button to a different **Send message** node. Optionally add **Collect input** (`company_size`), **Condition**, **Set tag**, **Send media**, or **Handoff**, then an **End** node. Pick an entry node and configure fallback/timeout behavior in the builder.
4. Save and resolve issues in the validation panel, use **Dry run** to check it without sending anything, then **Publish**. Open **Runs** after testing to inspect what happened. Edits stay in your draft until you publish again, and people already in the flow finish on the version they started (see section 9f).
5. Test from a permitted phone: send `pricing`, tap a button and check the resulting messages, tag, run log and handoff. A human can take over in Inbox; bot sends should remain paused until explicitly resumed.

Example journey: `pricing` → buttons `Basic` / `Enterprise` → `Enterprise` asks for company size → adds `Qualified` tag → handoff to a human agent. Configure the exact nodes/links in the editor; this example is not preloaded as a complete production journey.

## Create an Automation

An **Automation** runs when a trigger fires and performs steps. The builder supports message received, first inbound, keyword match, interactive reply, new contact, assigned conversation, added tag, and time-based triggers. Steps include message/buttons/list/template, add/remove tag, assign conversation, update contact field, create deal, wait, condition, signed outbound webhook, and close conversation. Scheduled/delayed work requires the worker.

1. Open **Automations → New**, or start from **Welcome message**, **Out of office**, **Lead qualifier**, or **Follow-up reminder**. Give the rule a clear name.
2. Example **Lead qualifier**: choose **Keyword match**, keywords `pricing` or `demo`, and a match mode. Add **Send message**: `Thanks for your interest. Which plan are you considering?`; optionally **Wait** 10 minutes; **Add tag** `Qualified`; **Create deal** in the sales pipeline; **Assign conversation** round-robin. Save and switch the rule **Active**.
3. Send a test keyword from a permitted phone. Confirm the message, contact tag, deal and assignment. Open the automation's **Logs** to inspect failures or partial outcomes. Pause the rule before changing it.
4. For an after-hours reply, clone **Out of office** and configure its time-of-day condition. For a periodic task, choose **Time based**, a five-field schedule/timezone, and an explicit contact audience if the actions affect contacts; use an approved template for recipients outside the service window.

Keep one active responder for a given trigger while testing. A Flow, Automation and AI auto-reply can all react to incoming messages; coordinate their triggers and handoff rules to avoid duplicate responses.

## Publishing flows, dry runs, safer automations and reports

### Publishing a flow
- **Save vs Publish.** Save keeps your draft; customers never see it. **Publish** makes the saved draft the new live version (v1, v2, …). Save any edits before publishing. The bar under the flow's name shows Draft, Live vN, Paused vN or Archived, and **Unpublished changes** when your draft differs from the live version.
- **Customers stay on their version.** Someone midway through the flow finishes it the way it was when they started; edits only affect people who start later. To move people waiting at a question onto the new version, open **Versions** and choose **Move waiting runs** on the old version (only runs idle for a minute, waiting at a step the new version still has). You can also cancel an old version's runs.
- **Pause, Resume, Archive.** Pause stops new customers while people already in the flow finish; tick "also cancel" to stop everyone now. Resume publishes the draft again. Archive needs no one in the flow (or tick "cancel"). A flow that was ever published must be archived before it can be deleted.
- **Why publish can be refused.** A step that needs a provider your workspace has not set up (payments, appointments, AI, Conversions API, store checkout) is shown greyed out with a **Set up** link, and publishing refuses it. Connect flow steps that would bounce customers between flows with no reply in between are refused too.

### Dry run, run history and replay
- **Dry run vs live test.** **Dry run** (in the version bar) shows what the flow would do for a sample contact and sends nothing, calls nothing and charges nothing. It uses the *saved* draft or a published version. The live test (flow settings, test numbers) sends real WhatsApp messages to those numbers.
- **Run history.** Flows → a flow → **Runs** lists runs with their version; filter by status or version and open **Details** to see each step, what was sent and whether a message's delivery is uncertain.
- **Replay a failed run (admins).** On a failed run's details, **Replay failed step** appears when it is safe. If the page says a message "may already have been delivered", check the conversation first: Bodhinox never re-sends it automatically.
- **Permissions.** "Replay failed flow runs" (admins and owners by default) and "Publish automations" (agents and above by default) can be taken away from a role in Settings → Team members → Permissions.

### Automations
- **Avoiding loops.** Saving an active automation that would trigger itself through tags is refused, with the automations in the loop. Change one tag so the chain ends.
- **Webhooks.** Use JSON for the body, with placeholders inside quotes, for example `{"text": "{{message.text}}"}`. Only an admin can use a secret workspace value in a webhook header or body. Private or internal addresses are refused. If the destination does not answer, the step says so and does not send again: check the receiving system before you re-run anything.
- **Scheduled recipients.** **Contacts in a saved segment** re-reads the segment at every run (opted-out and blocked contacts are skipped). Turn on **Run once per contact** to reach each contact only once.
- **Notify team.** Sends a notice to the conversation's assignee or to the owners and admins. It is not a WhatsApp message. Each member chooses in-app and email digest for **Automation notices** in Settings → Notifications.

### Journey templates
- Flows → New flow → **Journeys**: start with **Journey menu** (a four-option list, plus "Type a number" for phones that do not show lists), clone the journeys you need (**Work From Home registration**, **Free consultation**, **Chiropractic visit**, **Ayurvedic store**), then replace each menu placeholder with a Connect flow step to that journey's flow. Set the workspace values `wfh_link` and `chiropractic_fee` in Settings.

### Analytics comparisons and reports
- **Calendar periods.** Besides Today / 7 / 30 / 90 days and Custom, **Calendar period** offers This week, Last week, This month and Last month in your workspace's timezone (weeks run Monday to Sunday). Reports offer the same periods.
- **Compare.** The Compare panel on Analytics shows 2-5 campaigns side by side, appointment outcomes per service (with the no-show rate), and, for agents and above, the top products by net revenue in the period.
- **Choose a format.** In Analytics → Reports, pick CSV or PDF. PDF is for reading and printing: it shows up to 2,000 rows, and characters its font cannot show (for example Korean) appear as "?". Use CSV for the complete data. New report kinds: product sales, appointments by service and collections by day.
- **Schedule a report (admins).** Under **Scheduled reports**, choose the report, format, how often (daily, weekly on Monday, monthly on the 1st) and the hour, then pick up to 10 admins or owners. Each report covers the previous complete day, week or month. Recipients get an email with a sign-in link. A recipient who is no longer an admin is skipped. If the person who created the schedule is no longer an admin, the schedule pauses.
- **Share a report (admins).** Next to a ready report, choose **Share**, pick who can open it (viewers, agents, or admins and above) and for how long (up to 7 days), then copy the link. Only people signed in to this workspace with that role can open it; the page shows the report and until when it opens. You can see how often it was opened and revoke it at any time. Someone signed in to a different workspace sees "not available" and should switch workspace first.
