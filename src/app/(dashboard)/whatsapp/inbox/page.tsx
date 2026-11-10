import { redirect } from 'next/navigation';
import { ChannelGate } from '@/components/channels/channel-gate';
import { InboxView } from '@/components/inbox/inbox-view';
import { resolveInboxRedirect } from '@/lib/inbox/channel-inbox';

// The WhatsApp inbox: only WhatsApp conversations. A ?c=<id> link to an
// Instagram conversation opens in the Instagram inbox (or the All view while
// Instagram is off). The layout shows the off state when WhatsApp is turned off.
export default async function WhatsAppInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const target = await resolveInboxRedirect('whatsapp', await searchParams);
  if (target) redirect(target);
  // Gated here, not by the section layout, so the redirect above always runs first.
  return <ChannelGate channel="whatsapp"><InboxView channel="whatsapp" /></ChannelGate>;
}
