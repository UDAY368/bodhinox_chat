import { authFetch } from '@/lib/auth/client';
import type { AudienceConfig } from '@/lib/broadcast-audience';

export type VariableMapping = { type: 'static' | 'field' | 'custom_field'; value: string };
export interface BroadcastCreationInput {
  name: string;
  templateId: string;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
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
