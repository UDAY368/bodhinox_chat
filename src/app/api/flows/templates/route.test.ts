import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ signedIn: true }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.signedIn ? { id: 'u' } : null }, error: null }) } }),
}));

import { GET } from './route';
import { flowTemplateChannels, listFlowTemplates } from '@/lib/flows/templates';

type Card = { slug: string; channels: string[] };
const cards = async (query = '') => ((await (await GET(new Request(`http://localhost/api/flows/templates${query}`))).json()) as { templates: Card[] }).templates;

beforeEach(() => {
  h.signedIn = true;
});

describe('GET /api/flows/templates (Stage 1 channels)', () => {
  it("gives each card the sections it can be created in, from the template's own steps and trigger", async () => {
    const all = await cards();
    expect(all).toHaveLength(listFlowTemplates().length);
    for (const card of all) expect(card.channels).toEqual(flowTemplateChannels(listFlowTemplates().find((t) => t.slug === card.slug)!));
    // Every starter template runs on WhatsApp today.
    expect(all.every((card) => card.channels.includes('whatsapp'))).toBe(true);
  });

  it('lists only one section when asked, and refuses an unknown channel', async () => {
    const instagram = await cards('?channel=instagram');
    expect(instagram.every((card) => card.channels.includes('instagram'))).toBe(true);
    expect((await cards('?channel=whatsapp')).length).toBe(listFlowTemplates().length);
    expect((await GET(new Request('http://localhost/api/flows/templates?channel=sms'))).status).toBe(400);
  });

  it('needs a signed-in caller', async () => {
    h.signedIn = false;
    expect((await GET(new Request('http://localhost/api/flows/templates'))).status).toBe(401);
  });
});

describe('flowTemplateChannels', () => {
  it("keeps a template with a WhatsApp-only step off Instagram, and honours a template's own list", () => {
    const base = listFlowTemplates()[0];
    const withTemplate = { ...base, nodes: [...base.nodes, { node_key: 'tpl', node_type: 'send_template' as never, config: {} }] };
    expect(flowTemplateChannels(withTemplate)).toEqual(['whatsapp']);
    const plain = { ...base, trigger_type: 'keyword' as const,
      nodes: [{ node_key: 'start', node_type: 'start' as const, config: { next_node_key: 'end' } }, { node_key: 'end', node_type: 'end' as const, config: {} }] };
    expect(flowTemplateChannels(plain)).toEqual(['whatsapp', 'instagram']);
    expect(flowTemplateChannels({ ...plain, channels: ['instagram'] })).toEqual(['instagram']);
  });
});
