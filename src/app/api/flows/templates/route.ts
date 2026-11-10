import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { flowTemplateChannels, listFlowTemplates } from '@/lib/flows/templates';
import { getT } from '@/lib/i18n/translate';
import { isChannel } from '@/lib/channels/capabilities';

const t = getT('Api');

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * category + icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Each card carries `channels`, the sections it can be created in.
 * `?channel=whatsapp|instagram` lists only one section's templates.
 *
 * Available to any signed-in user. Flows is in soft-GA.
 */
export async function GET(request: Request) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: t('common.unauthorized') },
      { status: 401 }
    );
  }
  const channel = new URL(request.url).searchParams.get('channel');
  if (channel !== null && !isChannel(channel)) {
    return NextResponse.json({ error: getT('Flows.channelSection')('channelInvalid') }, { status: 400 });
  }
  // Shallow shape so the client gallery doesn't have to know about
  // the full node tree.
  const templates = listFlowTemplates().map((t) => ({ template: t, channels: flowTemplateChannels(t) }))
    .filter(({ channels }) => !channel || channels.includes(channel))
    .map(({ template: t, channels }) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    category: t.category,
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
    channels,
  }));
  return NextResponse.json({ templates });
}
