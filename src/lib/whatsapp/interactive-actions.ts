import { randomUUID } from 'node:crypto';
import type { DataClient } from '@/lib/data/types';
import { providerMediaUrl } from '@/lib/storage/server';
import type { InteractiveMessagePayload } from './interactive';

/** Recheck saved references at send time; a workflow may have been removed or disabled. */
export async function assertInteractiveTargets(db: DataClient, accountId: string, payload: InteractiveMessagePayload): Promise<void> {
  if (payload.kind === 'buttons') {
    const checked = new Set<string>();
    for (const button of payload.buttons) {
      const action = button.action;
      if (!action || action.type === 'url') continue;
      const key = `${action.type}:${action.targetId}`;
      if (checked.has(key)) continue;
      const automation = action.type === 'automation';
      const { data, error } = await db.from(automation ? 'automations' : 'flows')
        .select(automation ? 'id,is_active' : 'id,status')
        .eq('account_id', accountId).eq('id', action.targetId).maybeSingle();
      if (error || !data || (automation ? !data.is_active : data.status !== 'active'))
        throw new Error(`The selected ${action.type} is unavailable or inactive in this workspace.`);
      checked.add(key);
    }
  }
  if (payload.media && payload.media.type !== 'location') {
    // Private URLs are authorized and checked in this account before saving/sending.
    await providerMediaUrl(accountId, payload.media.url);
  }
}

/** A fresh opaque ID binds a workflow button to this particular sent message. */
export function bindInteractiveActions(payload: InteractiveMessagePayload): InteractiveMessagePayload {
  if (payload.kind !== 'buttons') return structuredClone(payload);
  return {
    ...structuredClone(payload),
    buttons: payload.buttons.map(button => ({
      ...structuredClone(button),
      id: button.action && button.action.type !== 'url' ? `qr_${randomUUID()}` : button.id,
    })),
  };
}
