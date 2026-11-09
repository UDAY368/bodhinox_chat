# Data requests (export, deletion, end-customer requests)

Requirement ids: SEC-01, SEC-04. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

**Scope.** This runbook covers workspace data export, workspace deletion, and requests from end customers (the workspace's contacts).

**Detection.**
- A workspace owner asks through Settings → Privacy & access, or by email.
- An end customer writes to the workspace or to Bodhinox.
- Log every request in the request log (below) on the day it arrives.

**Response target.** Acknowledge within 3 working days and complete within 30 days of a verified request.

**Verification.**
- **Workspace requests:** these come only from the workspace owner. Export also allows admins. The product enforces this: password or recent Google sign-in, plus MFA when enrolled.
- **End-customer requests:** confirm control of the WhatsApp number, for example with a reply from that number in the inbox thread. Never act on a request that arrives only by email with no number match.

**Workspace export (self-service).**
1. An owner or admin opens Settings → Privacy & access → Export, which calls `POST /api/account/export`. MFA is required when the user has it.
2. The `workspace.export` job (`src/lib/jobs/workspace-export.ts`) writes a zip to private storage. It is ready for 7 days (`EXPORT_READY_DAYS`), and the sweep job removes it after that.
3. The member downloads it through `GET /api/account/export/[id]/download`.

If storage is not configured, the request answers `503 storage_not_configured`. In that case, configure S3 first; there is no manual export path.

**Workspace deletion (self-service).**
1. The owner calls `POST /api/account/deletion` (`src/lib/account/deletion.ts`). The workspace becomes `closing` for 30 days (`DELETION_GRACE_DAYS`) and sends stop. The owner can cancel with `DELETE /api/account/deletion` during the grace period.
2. After `purge_after`, the worker's daily `workspace.purge` job (`src/lib/privacy/workspace-purge.ts`) handles the workspace.
   - **`WORKSPACE_PURGE_ENABLED` unset (default):** dry run. The worker logs `[workspace-purge] dry run` with the workspace id, `due` or the refusal reason, and the row counts it would delete. Nothing changes.
   - **`WORKSPACE_PURGE_ENABLED=true`:** the job re-checks the workspace under row locks: still `closing`, past `purge_after`, and no live provider subscription (refusal reasons `not_due`, `live_subscription`). A cancel by the owner waits for the lock and wins. It then copies the workspace's Bodhinox tax invoices to `purged_invoices`, writes one `workspace_purges` row (workspace id, `purge_after`, purge time, row counts, invoices kept) and deletes the workspace. Every tenant table goes with it. `audit_logs` and billing records stay with `account_id` cleared.
   - Stored files under `<workspace id>/` (media, avatars, exports, reports) are deleted right after. If storage fails, the `workspace.purge_storage` job retries daily for 30 days until `workspace_purges.storage_cleared_at` is set.
   - A purge cannot be undone. Record it in the request log with the `purged_at` date from `workspace_purges`.

**Personal account deletion.** This runs through `src/lib/auth/account-deletion.ts`. It anonymises the login identity, revokes sessions and API keys, and closes sole-member workspaces (30-day grace). `user_id` remains the audit identity, and tenant data is not deleted.

**End-customer requests: interim manual procedure. Built tools are limited.**
- **Access or export:** a workspace admin can view the contact's record and conversation in the inbox. There is no per-contact export. Prepare the extract manually from the inbox and contact page, and send it through the workspace.
- **Erasure:**
  - Use **Erase all data** (contacts page → delete dialog, admins and owners; `POST /api/contacts/{id}/erase`). The request is audited (`contact.erasure_requested`) and queued before it is acknowledged. The worker's `contact.erase` job (`src/lib/privacy/contact-erasure.ts`) then removes:
    - the media files the customer sent (mirrored inbound media; library files stay);
    - processed raw WhatsApp webhook copies naming the number, on this workspace's own phone numbers only;
    - mentions in this workspace's finished job payloads, and its pending outbound webhook deliveries about the contact;
    - campaign parameters and errors, flow variables, automation logs and pending-step context;
    - ad-lead answers (kept as an `erased` tombstone so Meta cannot re-import them), unanswered AI questions, WhatsApp form sessions and answers, notifications and realtime event copies;
    - finally the contact itself, with its conversations, messages, notes, tags, list memberships and channel identities.
  - The job writes `contact.erased` to the audit log with counts only. Check it before telling the customer the erasure is complete.
  - **Kept, with the contact link cleared:** orders, payments, payment links, appointments and coupon redemptions (financial and business records). Record these as retained, with the legal reason (for example, tax records).
  - A plain **Delete** (agents and above, also bulk and the data gateway) removes the contact row and what cascades from it only. Do not use it for an erasure request.
  - Unprocessed webhook receipts are left alone; processed copies older than 30 days are deleted by the retention sweep anyway.
- **Opt-out:** this is recorded on `contacts.opted_out_at` when the customer sends an English stop keyword (`src/lib/contacts/consent.ts`). Other languages need a manual opt-out by an agent.
- **Gap:** there is no opt-in evidence record. "Prove consent" requests cannot be answered from the product. This is listed in the pilot plan under "decide before live onboarding".

**Retention (automatic).** The hourly `data.retention_sweep` job deletes done jobs after 30 days, failed jobs after 90, processed raw webhook receipts after 30 and realtime outbox events after 7 days. Pending jobs and unprocessed receipts are never deleted.

**Customer communication.** Confirm receipt, then confirm completion, stating what was deleted and what was retained and why. Do not include message content in emails.

**Request log.** Use a private sheet the owner keeps, not the repository, with these columns: date received, requester type (workspace or end customer), workspace id, verification method, action taken, data retained and reason, completed date, handled by.

**Follow-up.** Each manual step above is a product backlog item: per-contact export and opt-in evidence.
