// Stage 5 (5F) gallery filters: by goal, by trigger (a template without a
// trigger is in neither trigger filter), and the search text.
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { matchesGalleryFilter, TemplateGallery, type TemplateSummary } from './template-gallery';

const template = (over: Partial<TemplateSummary>): TemplateSummary => ({
  slug: 's', name: 'Giveaway draw', description: 'Comment to enter', icon: 'Gift', category: 'instagram_growth',
  trigger_type: 'ig_comment', node_count: 5,
  meta: { goals: ['grow_followers'], trigger: 'post_comment', kind: 'flow', level: 'beginner', uses_ai: false, needs_payments: false },
  ...over,
});

describe('matchesGalleryFilter', () => {
  it('shows everything under All templates', () => {
    expect(matchesGalleryFilter(template({ meta: undefined }), { kind: 'all' }, '')).toBe(true);
  });

  it('filters by goal and by trigger', () => {
    const t = template({});
    expect(matchesGalleryFilter(t, { kind: 'goal', value: 'grow_followers' }, '')).toBe(true);
    expect(matchesGalleryFilter(t, { kind: 'goal', value: 'drive_traffic' }, '')).toBe(false);
    expect(matchesGalleryFilter(t, { kind: 'trigger', value: 'post_comment' }, '')).toBe(true);
    expect(matchesGalleryFilter(t, { kind: 'trigger', value: 'dm' }, '')).toBe(false);
  });

  it('keeps a template without a trigger, or without metadata, out of the trigger and goal filters', () => {
    const triggerless = template({ meta: { ...template({}).meta!, trigger: null } });
    for (const value of ['post_comment', 'dm', 'story_reply', 'live_comment'] as const)
      expect(matchesGalleryFilter(triggerless, { kind: 'trigger', value }, '')).toBe(false);
    expect(matchesGalleryFilter(template({ meta: undefined }), { kind: 'goal', value: 'grow_followers' }, '')).toBe(false);
  });

  it('searches the name and description, ignoring case and spaces around the query', () => {
    expect(matchesGalleryFilter(template({}), { kind: 'all' }, '  GIVEAWAY ')).toBe(true);
    expect(matchesGalleryFilter(template({}), { kind: 'all' }, 'to enter')).toBe(true);
    expect(matchesGalleryFilter(template({}), { kind: 'all' }, 'quiz')).toBe(false);
  });
});

describe('TemplateGallery layout per channel', () => {
  const render = (templates: TemplateSummary[]) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ key }) => key}>
        <TemplateGallery templates={templates} creating={false} onUse={() => {}} />
      </NextIntlClientProvider>,
    );
  const plain = template({ slug: 'welcome_menu', name: 'Welcome menu', category: 'general', meta: undefined });
  const waStarter = template({ slug: 'wa_ai_chat', name: 'Chat with AI', category: 'general', channels: ['whatsapp'],
    meta: { goals: ['engage_audience'], trigger: 'dm', kind: 'flow', level: 'beginner', uses_ai: true, needs_payments: false } });

  it('keeps WhatsApp on the category gallery, starters first with a Details button and direct Use this', () => {
    const html = render([plain, waStarter, template({ slug: 'x', name: 'Clinic visit', category: 'health', meta: undefined })]);
    expect(html).toContain('aria-label="categoriesLabel"');
    expect(html).not.toContain('data-template=');
    expect(html.indexOf('useThis: Chat with AI')).toBeLessThan(html.indexOf('useThis: Welcome menu'));
    expect(html).toContain('details: Chat with AI');
    expect(html).not.toContain('details: Welcome menu');
  });

  it('gives a gallery with Instagram starters the filter rail', () => {
    const html = render([plain, template({ slug: 'ig', channels: ['instagram'] })]);
    expect(html).toContain('data-template="ig"');
    expect(html).toContain('byGoal');
  });
});
