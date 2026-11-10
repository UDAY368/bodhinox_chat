import { redirect } from 'next/navigation';
import { legacyAutomationRedirect } from '@/lib/automations/section-redirect';

// /automations/[id]/edit (before channel sections): the editor in the automation's own channel.
export default async function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(await legacyAutomationRedirect({ kind: 'edit', id }));
}
