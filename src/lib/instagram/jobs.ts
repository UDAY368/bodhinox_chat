// Instagram job dispatch (Phase 11). handlers.ts calls these; each module's
// handler returns early while Instagram is off (instagramConfig() === null), so
// a job queued while it was on never calls Instagram after it is turned off.

export const INSTAGRAM_WEBHOOK_JOB = 'instagram.webhook';
export const INSTAGRAM_TOKEN_SWEEP_JOB = 'instagram.token_sweep';
export const INSTAGRAM_PROFILE_FETCH_JOB = 'instagram.profile_fetch';
export const INSTAGRAM_PRIVATE_REPLY_JOB = 'instagram.private_reply';
export const INSTAGRAM_RESUBSCRIBE_JOB = 'instagram.resubscribe';

/** Pre-scope: one verified webhook delivery; each entry is resolved to its workspace by entry[].id. */
export async function handleInstagramWebhookJob(payload: Record<string, unknown>, assertLease: () => void = () => {}): Promise<void> {
  await (await import('./process-webhook')).processInstagramWebhookJob(payload, assertLease);
}

/** Tenant-scoped instagram.* jobs. */
export async function handleInstagramJob(accountId: string, type: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  if (payload.accountId !== undefined && payload.accountId !== accountId) throw new Error('Instagram job tenant mismatch');
  switch (type) {
    case INSTAGRAM_TOKEN_SWEEP_JOB:
      return (await import('./token-sweep')).runTokenSweep(accountId);
    case INSTAGRAM_PROFILE_FETCH_JOB:
      return (await import('./profile')).handleProfileFetchJob(accountId, payload);
    case INSTAGRAM_PRIVATE_REPLY_JOB:
      return (await import('./private-reply')).handlePrivateReplyJob(accountId, payload, attempt);
    case INSTAGRAM_RESUBSCRIBE_JOB:
      return void (await (await import('./resubscribe')).runResubscribe(accountId));
    default:
      throw new Error('Unknown Instagram job');
  }
}
