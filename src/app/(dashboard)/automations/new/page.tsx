import { redirect } from 'next/navigation';
import { legacyAutomationRedirect } from '@/lib/automations/section-redirect';

// /automations/new[?template=] (before channel sections): a new automation in the first enabled channel.
export default async function NewAutomationPage({ searchParams }: {
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const { template } = await searchParams;
  redirect(await legacyAutomationRedirect({ kind: 'new', template: typeof template === 'string' ? template : null }));
}
