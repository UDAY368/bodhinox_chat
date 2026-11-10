import { EditAutomation } from '@/components/automations/edit-automation';

// Edits a Instagram automation (one of the other channel is sent to its own section).
export default async function EditInstagramAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditAutomation id={id} channel="instagram" />;
}
