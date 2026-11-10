import { redirect } from 'next/navigation';
import { legacyFlowsTarget } from './_lib/legacy-target';
import { LegacyFlowsRedirect } from './_lib/legacy-redirect';

// /flows predates the channel sections (Stage 1): it opens the first enabled
// channel's flows (WhatsApp first), so old bookmarks and links keep working.
export const dynamic = 'force-dynamic';

export default async function FlowsRedirectPage() {
  const target = await legacyFlowsTarget();
  if (target) redirect(target);
  return <LegacyFlowsRedirect />;
}
