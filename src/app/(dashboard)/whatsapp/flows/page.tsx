import { redirect } from 'next/navigation';

// WhatsApp › Flows moved into the unified Automation list; old links open it filtered to WhatsApp.
export default function WhatsAppFlowsPage() {
  redirect('/automation?channel=whatsapp');
}
