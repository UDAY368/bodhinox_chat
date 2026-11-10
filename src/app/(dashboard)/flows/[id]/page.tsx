import { redirect } from 'next/navigation';
import { legacyFlowsTarget } from '../_lib/legacy-target';
import { LegacyFlowsRedirect } from '../_lib/legacy-redirect';

// /flows/[id] predates the channel sections (Stage 1): it opens the flow in its
// own channel's section (a legacy 'any' flow in WhatsApp unless only Instagram
// is enabled), so old bookmarks and notification links keep working.
export const dynamic = 'force-dynamic';

export default async function FlowRedirectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const target = await legacyFlowsTarget(id);
  if (target) redirect(target);
  return <LegacyFlowsRedirect flowId={id} />;
}
