import { NextResponse } from 'next/server';
import { createClient } from '@/lib/data/server';
import { flowTemplateChannels, listFlowTemplates } from '@/lib/flows/templates';
import { getT } from '@/lib/i18n/translate';
import { isChannel } from '@/lib/channels/capabilities';
import { instagramEnabled } from '@/lib/instagram/config';

const t = getT('Api');
const tCategories = getT('Instagram.quickAutomations.categories');

/** Instagram starter categories are labelled here (the gallery labels the older ones itself). */
const categoryLabel = (category: string): string | undefined =>
  category.startsWith('instagram_') ? tCategories(category) : undefined;

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * category + icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Each card carries `channels`, the sections it can be created in.
 * `?channel=whatsapp|instagram` lists only one section's templates. The
 * Instagram starters (Stage 2) also carry `category_label`, since their
 * categories are newer than the gallery's own labels. They are listed only
 * while INSTAGRAM_ENABLED is on. From Stage 5 they also carry `meta` (goals,
 * trigger, kind, level, AI, payments, recommended), the detail view's
 * `business_value` and `how_it_works`, and `note_count` (canvas notes).
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
  // The Instagram-only starters stay hidden while the platform flag is off.
  const instagramOn = instagramEnabled();
  const templates = listFlowTemplates().map((t) => ({ template: t, channels: flowTemplateChannels(t) }))
    .filter(({ channels }) => !channel || channels.includes(channel))
    .filter(({ channels }) => instagramOn || channels.includes('whatsapp'))
    .map(({ template: t, channels }) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    category: t.category,
    category_label: categoryLabel(t.category),
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
    channels,
    // Stage 5 (5F): what the gallery's filters, Recommended row and detail view show.
    ...(t.meta ? { meta: t.meta } : {}),
    ...(t.business_value ? { business_value: t.business_value } : {}),
    ...(t.how_it_works ? { how_it_works: t.how_it_works } : {}),
    note_count: t.canvas_notes?.length ?? 0,
  }));
  return NextResponse.json({ templates });
}
