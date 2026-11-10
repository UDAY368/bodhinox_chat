import type { ReactNode } from 'react';
import { ChannelGate } from '@/components/channels/channel-gate';

// The WhatsApp section (/whatsapp/inbox, /flows, /automations): shown while
// WhatsApp is enabled for the workspace, else an explanation (never a 404).
export default function WhatsAppLayout({ children }: { children: ReactNode }) {
  return <ChannelGate channel="whatsapp">{children}</ChannelGate>;
}
