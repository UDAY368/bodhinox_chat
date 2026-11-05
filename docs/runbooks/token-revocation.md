# Token revocation and secret rotation

Requirement ids: WA-01, IG-01, ADS-01, APT-05, TEN-03. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

- **WhatsApp (code 190):**
  - **Detection, at once on a send.** When any WhatsApp send (inbox reply, template, broadcast, flow, catalogue, interactive or flow message) gets Meta 190 or HTTP 401, `src/lib/whatsapp/meta-api.ts` reports the sending number and `recordSendTokenError` (`src/lib/whatsapp/health-sync.ts`) sets `health_error='token'` and `health_error_at` on that connected number, the same fields the health sync uses. The first token error after a healthy state sends each owner and admin one in-app `number_quality` notification ("WhatsApp number needs reconnecting", link to Settings → WhatsApp; email digest per their preference). Concurrent sends on the same token alert once (the row is locked). The send itself still fails with Meta's error; queued sends record the outbound intent as `failed` (a classified rejection, never `unknown`), so nothing is re-sent blindly. The platform console's Integration health shows the number's last error code `token`.
  - **Detection, every 6 hours.** `whatsapp.health_sync` (`HEALTH_SYNC_INTERVAL_MS`) also classes 190 / 401 as `token` (`categorizeHealthError`) and alerts the same way on the first one. A successful sync clears `health_error`, so a later revocation alerts again.
  - **Fix.** Reconnect the number (Settings → WhatsApp) with a new system-user token.
- **Instagram:** the account status becomes `token_invalid` (`src/lib/instagram/connection.ts`, daily `instagram` token sweep). Reconnect it from Settings → Instagram.
- **Meta Ads:** reconnect the Page connection. Lead fetches fail until you do.
- **Zoom:** `app_deauthorized` disconnects the current connection; a delayed one for an older connection is ignored. Reconnect in Settings → Integrations.
- **Google sign-in:** users relink from Settings → Security.
- **Meta app secret rotation:**
  - `META_APP_SECRET` accepts more than one value, so you can overlap old and new during a rotation.
  - The Embedded Signup code exchange uses `META_APP_SECRET_PRIMARY` (else the first value).
  - Order: add the new secret, deploy, rotate it in Meta, then remove the old one.
- **`ENCRYPTION_KEY` / `AUTH_MFA_ENCRYPTION_KEY` rotation is not supported.** There is no re-encrypt path in the code. Changing either key makes every stored provider token, and MFA secrets for the MFA key, unreadable. Treat a suspected leak as an incident and plan a re-encrypt tool first.
- **Verification:** the health page shows `ok` after reconnecting, and a test send succeeds.

- **Remaining gap (owner decision, not built):** a broadcast already sending is not stopped by the first token error. Admins now see the token error at once, but the running pass keeps failing recipient by recipient (paced, no tight retry loop, no `unknown` intents) until it ends, and there is no pause or stop control for a running campaign. What exists today: cancel campaigns that have not started (Broadcasts, `DELETE /api/broadcasts/[id]/schedule`), reconnect the number, then create or reschedule the campaign for the recipients that failed. Stopping the pass on the first token error, leaving the rest `pending`, is on the pilot plan's "decide before live onboarding" list.
