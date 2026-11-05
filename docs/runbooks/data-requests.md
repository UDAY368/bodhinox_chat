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
2. **Not built:** the purge after the grace period. Nothing is deleted automatically today. A request to actually erase a closed workspace is an owner and engineering task until the purge exists. Record it in the request log with the `purge_after` date.

**Personal account deletion.** This runs through `src/lib/auth/account-deletion.ts`. It anonymises the login identity, revokes sessions and API keys, and closes sole-member workspaces (30-day grace). `user_id` remains the audit identity, and tenant data is not deleted.

**End-customer requests: interim manual procedure. Built tools are limited.**
- **Access or export:** a workspace admin can view the contact's record and conversation in the inbox. There is no per-contact export. Prepare the extract manually from the inbox and contact page, and send it through the workspace.
- **Erasure:**
  - Deleting the contact (contacts page, or the data gateway `contacts` delete, agent and above) removes the contact row and what cascades from it.
  - **Gap:** there is no full per-contact erasure across messages, media objects, broadcast recipients, orders and payments. Financial records must be kept anyway.
  - Until a per-contact erasure tool exists, record what was deleted and what was retained, with the legal reason (for example, tax records for orders and payments).
- **Opt-out:** this is recorded on `contacts.opted_out_at` when the customer sends an English stop keyword (`src/lib/contacts/consent.ts`). Other languages need a manual opt-out by an agent.
- **Gap:** there is no opt-in evidence record. "Prove consent" requests cannot be answered from the product. This is listed in the pilot plan under "decide before live onboarding".

**Customer communication.** Confirm receipt, then confirm completion, stating what was deleted and what was retained and why. Do not include message content in emails.

**Request log.** Use a private sheet the owner keeps, not the repository, with these columns: date received, requester type (workspace or end customer), workspace id, verification method, action taken, data retained and reason, completed date, handled by.

**Follow-up.** Each manual step above is a product backlog item: per-contact export, per-contact erasure, the closed-workspace purge, and opt-in evidence.
