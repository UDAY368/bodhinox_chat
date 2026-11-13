// What the broadcast wizard starts with when it opens from Duplicate or from a
// draft's Edit (?from=<id>): the campaign's name, channel, message, variable
// mappings, fixed send values and audience. Pure; unit-tested.
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { VariableMapping } from '@/lib/broadcast-create';
import {
  CAMPAIGN_SEND_EXTRAS_KEY,
  storedCampaignSendExtras,
  type CampaignSendExtras,
} from '@/lib/whatsapp/template-send-params';

export interface WizardPrefill {
  name: string;
  channel: 'whatsapp' | 'instagram';
  text: string;
  templateName: string | null;
  templateLanguage: string | null;
  variables: Record<string, VariableMapping>;
  sendExtras: CampaignSendExtras;
  audience: AudienceConfig;
}

interface SourceRow {
  name: string;
  channel?: string | null;
  message_text?: string | null;
  template_name?: string | null;
  template_language?: string | null;
  template_variables?: Record<string, unknown> | null;
  audience_filter?: Record<string, unknown> | null;
}

const MAPPING_TYPES = new Set(['static', 'field', 'custom_field', 'csv_column']);
const AUDIENCE_TYPES = new Set(['all', 'tags', 'custom_field', 'segment', 'list']);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

/**
 * `copyName` names the copy ("X copy"); omitted, the name is kept (editing a
 * draft). A CSV audience is not stored, so it starts as "All contacts" and
 * CSV-column variables are dropped (the user maps them again).
 */
export function prefillFromBroadcast(row: SourceRow, copyName?: (name: string) => string): WizardPrefill {
  const raw = row.template_variables ?? {};
  const af = row.audience_filter ?? {};
  const csv = af.type === 'csv';
  const variables: Record<string, VariableMapping> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === CAMPAIGN_SEND_EXTRAS_KEY || !value || typeof value !== 'object') continue;
    const m = value as { type?: unknown; value?: unknown };
    if (typeof m.type !== 'string' || !MAPPING_TYPES.has(m.type) || typeof m.value !== 'string') continue;
    if (csv && m.type === 'csv_column') continue;
    variables[key] = { type: m.type as VariableMapping['type'], value: m.value };
  }
  const type = typeof af.type === 'string' && AUDIENCE_TYPES.has(af.type) ? (af.type as AudienceConfig['type']) : 'all';
  const custom = af.customField as AudienceConfig['customField'] | undefined;
  const audience: AudienceConfig = {
    type,
    ...(type === 'tags' ? { tagIds: ids(af.tagIds) } : {}),
    ...(type === 'segment' && typeof af.segmentId === 'string' ? { segmentId: af.segmentId } : {}),
    ...(type === 'list' && typeof af.listId === 'string' ? { listId: af.listId } : {}),
    ...(type === 'custom_field' && custom ? { customField: custom } : {}),
    ...(ids(af.excludeTagIds)?.length ? { excludeTagIds: ids(af.excludeTagIds) } : {}),
  };
  const instagram = row.channel === 'instagram';
  return {
    name: copyName ? copyName(row.name) : row.name,
    channel: instagram ? 'instagram' : 'whatsapp',
    text: instagram ? row.message_text ?? '' : '',
    templateName: instagram ? null : row.template_name || null,
    templateLanguage: instagram ? null : row.template_language || null,
    variables: instagram ? {} : variables,
    sendExtras: instagram ? {} : storedCampaignSendExtras(raw[CAMPAIGN_SEND_EXTRAS_KEY]),
    audience,
  };
}
