import { NewAutomation } from '@/components/automations/new-automation';

// A new WhatsApp automation; it belongs to WhatsApp for its whole life.
export default function NewWhatsAppAutomationPage() {
  return <NewAutomation channel="whatsapp" />;
}
