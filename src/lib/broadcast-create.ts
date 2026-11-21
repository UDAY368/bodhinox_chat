import { authFetch } from '@/lib/auth/client';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { CampaignSendExtras } from '@/lib/whatsapp/template-send-params';

export type VariableMapping = { type: 'static' | 'field' | 'custom_field' | 'csv_column'; value: string };
export interface BroadcastCreationInput {
  name: string;
  templateId: string;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
  scheduledAt?: string;
  trackedUrl?: string;
  /** Location, offer end and coupon code, the same for every recipient. */
  sendExtras?: CampaignSendExtras;
  /** The number to send from; the server uses the workspace default when omitted. */
  whatsappConfigId?: string | null;
  /** One id per wizard session; the server returns the campaign already created for a repeat. */
  clientRequestId?: string;
  /** Quiet hours: minutes after midnight in the workspace time zone; omitted sends any time. */
  sendWindow?: { start: number; end: number } | null;
}

export async function requestBroadcastCreation(input: BroadcastCreationInput, send: typeof authFetch = authFetch): Promise<string> {
  const response = await send('/api/broadcasts/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, headerMediaUrl: input.headerMediaUrl?.trim() || undefined }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Could not create broadcast');
  if (typeof result.id !== 'string') throw new Error('Campaign creation returned no identifier');
  return result.id;
}
