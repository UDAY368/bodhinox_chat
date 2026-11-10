// Where the pre-Stage 1 automation URLs (/automations/**) go now that each
// channel has its own section. Server only: the legacy pages call it and
// redirect. The automation lookup and the channel state are read under the
// caller's own tenant (withTenant, live session), so a link never reveals
// another workspace's automation, and an id that is not a UUID is never sent
// to SQL.
import { Prisma } from '@prisma/client';
import { resolveSession } from '@/lib/auth/session';
import { getWorkspaceChannels } from '@/lib/channels/workspace';
import { channelPath, firstEnabledChannel } from '@/lib/channels/routes';
import { withTenant } from '@/lib/db/tenant';
import { getTemplate, templateOnChannel } from './templates';
import type { Channel } from '@/types';

export type LegacyAutomationTarget =
  | { kind: 'list' }
  | { kind: 'new'; template?: string | null }
  | { kind: 'edit' | 'logs'; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure: the section URL for a legacy target. The list and a new automation go
 * to the first enabled channel (WhatsApp first); an automation goes to its own
 * channel's section, or the first enabled one when it was not found (that
 * page then reports it missing). A template slug is kept only when it is one
 * an enabled channel offers, and opens in that channel.
 */
export function legacyAutomationPath(target: LegacyAutomationTarget, enabled: readonly Channel[],
  automationChannel: Channel | null = null): string {
  const first = firstEnabledChannel(enabled);
  switch (target.kind) {
    case 'list':
      return channelPath(first, 'automations');
    case 'new': {
      const slug = target.template;
      const template = slug ? getTemplate(slug) : null;
      // A starter template opens in the first enabled channel it is made for;
      // one no enabled channel offers is dropped rather than opening blank.
      const channel = template ? [first, ...enabled].find((c) => templateOnChannel(template, c)) : undefined;
      return slug && channel
        ? `${channelPath(channel, 'automationNew')}?template=${encodeURIComponent(slug)}`
        : channelPath(first, 'automationNew');
    }
    case 'edit':
      return channelPath(automationChannel ?? first, 'automations', target.id);
    case 'logs':
      return channelPath(automationChannel ?? first, 'automationLogs', target.id);
  }
}

/**
 * The section URL for a legacy target, read for the signed-in workspace. With
 * no session, or when the read fails, the WhatsApp section (its layout and API
 * still gate everything); never throws.
 */
export async function legacyAutomationRedirect(target: LegacyAutomationTarget): Promise<string> {
  try {
    const session = await resolveSession();
    if (!session) return legacyAutomationPath(target, []);
    const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
    const { enabled, channel } = await withTenant(tenant, async (tx) => {
      const state = await getWorkspaceChannels(tx, session.accountId);
      let channel: Channel | null = null;
      if ((target.kind === 'edit' || target.kind === 'logs') && UUID.test(target.id)) {
        const [row] = await tx.$queryRaw<{ channel: string }[]>(Prisma.sql`
          SELECT channel FROM automations WHERE account_id=${session.accountId}::uuid AND id=${target.id}::uuid`);
        if (row) channel = row.channel === 'instagram' ? 'instagram' : 'whatsapp';
      }
      return { enabled: state.enabled, channel };
    });
    return legacyAutomationPath(target, enabled, channel);
  } catch {
    console.error('[automations] legacy redirect lookup failed');
    return legacyAutomationPath(target, []);
  }
}
