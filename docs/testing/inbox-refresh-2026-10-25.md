# Inbox refresh verification — 2026-10-25

## Changes
- Replaced decorative conversation-studio heading with a compact Chats header.
- Scoped WhatsApp-style light/dark Inbox colours, green outgoing messages, white incoming messages and neutral chat surface. Surrounding cream/copper app stays intact.
- Contact sidebar edits name, email, company and existing custom values. An owner/admin can add the Address field using existing workspace field settings. Phone/WhatsApp identities remain unchanged.
- Tags can be assigned/removed through the existing authenticated tag route, preserving automation events. Fixed the shared helper to include the CSRF token.
- Contact sidebar displays primitive answers from the latest 20 flow runs, grouped by flow/date, separately from manually maintained fields.
- Deals are collapsed by default and expand on demand. Notes remain available. Viewer writes are disabled; field definition creation remains admin-only.

## Automated checks
- Full Vitest suite: 185 files, 1,653 tests passed.
- Focused Inbox/contact/API/localisation checks: 17 files, 99 tests passed.
- Final data/tag/localisation checks: 3 files, 21 tests passed.
- TypeScript passed; focused ESLint passed.
- Production build passed using `npm run build -- --webpack`.
- Windows Turbopack build failed starting its CSS worker process, including after running outside the restricted environment. Webpack successfully compiled the same application.

## Browser checks
Used the isolated `.env.test` workspace, with outbound WhatsApp disconnected.
- Decorative Inbox header removed and neutral/green message layout visible.
- Created an Address custom field through the sidebar.
- Updated sample contact name/email/address. Reloading retained the values and the conversation list reflected the new name.
- Existing Service interest custom value remained unchanged.
- Flow answers displayed under the originating flow/date; the flow's original name stayed separate from the edited contact name.
- Assigned Priority tag successfully with no CSRF error.
- Expanded Deals to show all four sample deals.

No production contact data was edited. This change does not require a database migration or new environment variables.
- Removed Priority tag successfully; UI returned to No tags. Collapsed Deals after checking all four cards. Verified compact header at 1280px and desktop layout at 1480px.
