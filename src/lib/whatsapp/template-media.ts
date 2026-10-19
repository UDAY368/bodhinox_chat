import { providerMediaUrl } from '@/lib/storage/server';
import type { SendTimeParams } from './template-send-builder';

/** Keep stored references private and mint provider access only at dispatch. */
export async function resolveTemplateMediaParams(
  accountId: string,
  template: { header_media_url?: string | null } | null,
  params?: SendTimeParams,
): Promise<SendTimeParams | undefined> {
  if (params?.headerMediaId) return params;
  const url = params?.headerMediaUrl ?? template?.header_media_url;
  if (!url) return params;
  return { ...params, headerMediaUrl: await providerMediaUrl(accountId, url) };
}
