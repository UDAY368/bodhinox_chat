# Flow audit — October 25, 2026

Audited application revision: `d18430b`. Scope: production flow list, active IMC editor and run history, local flow/API/editor tests, reconstructed IMC execution scenarios, starter templates, and selected database integration checks. Existing flows were not saved, paused, activated, or deleted. No customer messages were sent by this audit.

## Findings and recommended changes

### 1. High: IMC's Yes button ends the flow instead of reopening the menu

The active flow has `send_buttons_4 → Yes → if_else`. The condition checks `vars.rule == "Yes"`; its true branch points to `send_buttons` and its false branch to `end`. The only collection keys in the flow are `name`, `loc`, and `Number`. Tapping a reply button routes the run; it does not assign its title to `vars.rule`.

Production evidence: the run starting October 25 at 11:56:24 recorded `reply_id=yes` at 11:57:06, entered `if_else`, logged `advancing_to=end`, and completed at 11:57:06. All four reconstructed service routes reproduce this behavior using the actual engine with isolated storage and mocked sends.

Recommended correction: route Yes directly to `send_buttons_2` to reopen the service choices, or to `send_buttons` if the welcome message should repeat. Keep No connected to End. A simulation of direct Yes-to-service-menu routing remains active at the correct menu. This recommendation has not been applied to the live flow.

### 2. Medium: activation checks miss undefined condition variables

The active IMC editor reports “No issues. Ready to activate.” despite the condition depending on an unset `rule`. The reconstructed graph also passes activation validation without an error.

Recommended correction: warn when a condition or interpolated message references a variable that no reachable earlier collection node supplies. Use a warning where externally supplied variables are allowed; do not blindly reject all unknown variables. Add a variable selector based on available captured keys.

Evidence: `src/lib/flows/validate.ts` validates a condition's key syntax/presence and edges, but does not analyze where the variable is assigned.

### 3. Medium: email/phone validation cannot be configured in the builder

The Collect input form offers a prompt, a variable key, and a next node. Advanced settings expose the node key, but no validation selector. The runtime supports `any`, `email`, `phone`, and bounded `regex` validation. Without a validation setting, it accepts nonempty text.

An isolated probe confirms `not-a-phone` is accepted by the current untyped phone configuration and rejected with `validation: "phone"`. The shipped lead-capture template also omits email validation, so `not-an-email` is accepted and rejected only when `validation: "email"` is explicitly set.

Recommended correction: expose validation in Collect input, configure the lead template's email node appropriately, and offer a clear retry message. Decide the desired phone format and explain it in the form; the current phone rule expects an optional leading plus and 8–15 digits, without spaces.

Relevant sources: `src/components/flows/forms/node-config-form.tsx`, `src/lib/flows/input-validation.ts`, `src/lib/flows/templates.ts`.

### 4. Medium: run duration is incorrect

The completed production run above lasted 42 seconds (11:56:24–11:57:06), while the history displayed “ran for 43 minutes” during inspection. The value increases over time.

Root cause: `src/app/(dashboard)/flows/[id]/runs/page.tsx` calculates `formatDistanceToNow(ended_at)` and labels it as execution duration. That measures elapsed time since completion.

Recommended correction: calculate the distance between `started_at` and `ended_at`. If “ended X ago” is useful, show it as a separate label.

## Verification

- Existing flow, editor, API, quick-reply action, and AI auto-reply suites: **234 tests passed across 15 files**.
- Additional isolated audit scenarios: **13 tests passed**. These check all three starter templates, all four IMC service routes, the incorrect Yes branch, a proposed direct-menu connection, normal No completion, AI fallback preserving the menu, invalid contact details, and the missing-variable validation gap. Passing reproduction tests confirm the defects; they do not mean those configurations are correct.
- Additional probes are saved under ignored `.reference/flow-audit.test.ts`; run with `npm.cmd test -- --config .reference/flow-audit.config.ts`.
- Selected tests against the isolated PostgreSQL test database: **2 passed**, covering opted-in AI menu fallback/human handoff without advancing the flow, and tenant-scoped persistence of flow nodes. The other 14 tests in that file were excluded by the test-name filter. Total tests passed in this audit: **249**.
- Production editor, canvas/list switching, and run history loaded successfully. No browser console errors were captured during this inspection. No Failed status was present in the visible recent IMC run list; business routing defects can still appear as Completed.

## Limits

WhatsApp sends were mocked in execution simulations. This audit did not send real messages, modify production configuration, verify every media file against Meta, or simulate every possible customer phrase. No application behavior changes or deployment were made. Fix the Yes connection first, then add validation and accurate run durations before expanding the builder.

## Approved fixes and production verification

After this audit, the user approved fixing the four issues. Revision `db45c96` is now deployed successfully to both the web app and background worker. Full GitHub release validation passed. The final affected suite passed 360 tests; 13 additional corrected IMC simulation scenarios passed.

The live IMC flow was saved and reloaded: Yes now points directly to `send_buttons_2`, No still points to `end`, and `collect_input_3` uses phone validation. All other nodes and settings were preserved. The obsolete `if_else` node remains present but unreachable, with advisory warnings; it no longer controls this route. No customer messages were sent during this verification.

The live editor exposes all four validation choices and displays missing-variable warnings. New lead-capture templates validate email. Existing drafts retain their settings until changed in the editor. Invalid regex configurations are rejected before activation. The historical run now displays its actual timestamp-based duration (41 seconds at full stored precision), rather than the time since it ended. A screenshot is saved at `.reference/flow-fixes-production.png`.
