import { redirect } from 'next/navigation';
import { legacyAutomationRedirect } from '@/lib/automations/section-redirect';

// /automations (before channel sections): the first enabled channel's automations.
export default async function AutomationsPage() {
  redirect(await legacyAutomationRedirect({ kind: 'list' }));
}
