import { AutomationLogs } from '@/components/automations/automation-logs';

// A WhatsApp automation's run log (one of the other channel is sent to its own section).
export default async function WhatsAppAutomationLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationLogs id={id} channel="whatsapp" />;
}
