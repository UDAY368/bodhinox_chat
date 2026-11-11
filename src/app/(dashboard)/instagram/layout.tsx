import type { ReactNode } from 'react';
import { ChannelGate } from '@/components/channels/channel-gate';

// The Instagram section (/instagram/inbox, /flows, /automations and the
// Instagram tools): shown while Instagram is enabled and available for the
// workspace, else an explanation (never a 404).
export default function InstagramLayout({ children }: { children: ReactNode }) {
  return <ChannelGate channel="instagram" exceptPath="/instagram/inbox">{children}</ChannelGate>;
}
