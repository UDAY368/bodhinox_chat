import { FlowList } from '@/components/flows/flow-list';

// WhatsApp › Flows (Stage 1): this channel's flows plus legacy flows that run on both.
export default function WhatsAppFlowsPage() {
  return <FlowList channel="whatsapp" />;
}
