import { providerMediaUrl } from '@/lib/storage/server';
import type { CarouselCard } from '@/types';
import type { SendTimeParams } from './template-send-builder';

/** Keep stored references private and mint provider access only at dispatch. */
export async function resolveTemplateMediaParams(
  accountId: string,
  template: { header_media_url?: string | null; cards?: CarouselCard[] | null } | null,
  params?: SendTimeParams,
): Promise<SendTimeParams | undefined> {
  // Carousel cards carry their own media; each is signed the same way.
  if (template?.cards?.length) {
    const cards = await Promise.all(
      template.cards.map(async (card, i) => {
        const own = params?.cards?.[i] ?? {};
        if (own.headerMediaId) return own;
        const url = own.headerMediaUrl ?? card.header_media_url;
        return url ? { ...own, headerMediaUrl: await providerMediaUrl(accountId, url) } : own;
      }),
    );
    return { ...params, cards };
  }
  if (params?.headerMediaId) return params;
  const url = params?.headerMediaUrl ?? template?.header_media_url;
  if (!url) return params;
  return { ...params, headerMediaUrl: await providerMediaUrl(accountId, url) };
}
