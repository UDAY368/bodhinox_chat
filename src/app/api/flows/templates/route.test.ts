import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/flows/templates while Instagram is off', () => {
  it('lists no Instagram-only starter, so nothing Instagram-only can be picked before launch', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    const all = await cards();
    expect(all.some((card) => card.slug.startsWith('ig_'))).toBe(false);
    expect(all.length).toBe(listFlowTemplates().filter((t) => flowTemplateChannels(t).includes('whatsapp')).length);
    expect((await cards('?channel=instagram')).every((card) => card.channels.includes('whatsapp'))).toBe(true);
  });
});

describe('GET /api/flows/templates (Stage 1 channels)', () => {
  it("gives each card the sections it can be created in, from the template's own steps and trigger", async () => {
    const all = await cards();
    expect(all).toHaveLength(listFlowTemplates().length);
    for (const card of all) expect(card.channels).toEqual(flowTemplateChannels(listFlowTemplates().find((t) => t.slug === card.slug)!));
    // Every starter runs on WhatsApp except the Instagram starters (Stage 2), which run only on Instagram.
    for (const card of all) {
      expect(card.channels).toEqual(card.slug.startsWith('ig_') ? ['instagram'] : expect.arrayContaining(['whatsapp']));
    }
  });

  it('lists only one section when asked, and refuses an unknown channel', async () => {
    const instagram = await cards('?channel=instagram');
    expect(instagram.every((card) => card.channels.includes('instagram'))).toBe(true);
    expect(instagram.filter((card) => card.slug.startsWith('ig_')).length).toBeGreaterThanOrEqual(12);
    const whatsapp = await cards('?channel=whatsapp');
    expect(whatsapp.length).toBe(listFlowTemplates().filter((t) => flowTemplateChannels(t).includes('whatsapp')).length);
    expect(whatsapp.some((card) => card.slug.startsWith('ig_'))).toBe(false);
    expect((await GET(new Request('http://localhost/api/flows/templates?channel=sms'))).status).toBe(400);
  });

  it('labels the Instagram starter categories, and only those', async () => {
    const all = (await cards()) as Array<Card & { category: string; category_label?: string }>;
    const own = all.filter((card) => card.slug.startsWith('ig_'));
    expect(own.every((card) => card.category.startsWith('instagram_') && !!card.category_label)).toBe(true);
    expect(new Set(own.map((card) => card.category_label))).toEqual(new Set(['Comments', 'Growth', 'Stories', 'DMs']));
    expect(all.filter((card) => !card.slug.startsWith('ig_')).every((card) => card.category_label === undefined)).toBe(true);
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

describe('GET /api/flows/templates opening messages', () => {
  it("gives each card the bot's opening messages for the detail view's phone", async () => {
    const list = (await (await GET(new Request('http://localhost/api/flows/templates?channel=whatsapp'))).json()) as {
      templates: Array<{ slug: string; preview: Array<{ from: string; text?: string; buttons?: string[] }> }>;
    };
    const meeting = list.templates.find((t) => t.slug === 'wa_book_meeting')!;
    expect(meeting.preview).toHaveLength(1);
    expect(meeting.preview[0].from).toBe('bot');
    expect(meeting.preview[0].buttons).toHaveLength(2);
    for (const card of list.templates) {
      expect(card.preview.length).toBeLessThanOrEqual(3);
      expect(card.preview.every((m) => m.from === 'bot')).toBe(true);
    }
  });
});
