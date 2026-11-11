import { AutomationList } from '@/components/automations/automation-list';

// WhatsApp › Automations: only WhatsApp automations (the whatsapp layout gates the section).
export default function WhatsAppAutomationsPage() {
  return <AutomationList channel="whatsapp" />;
}
