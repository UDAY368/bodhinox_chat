import { describe, expect, it } from 'vitest';
import type { DataClient } from '@/lib/data/types';
import { automationTemplateIssues, automationTemplateRefusal } from './template-check';

const BASE = {
  body_text: 'Hi {{1}}',
  header_type: null,
  header_content: null,
  buttons: [],
  template_kind: 'standard',
  cards: null,
  lto: null,
} as unknown as Parameters<typeof automationTemplateRefusal>[0] & object;

const tpl = (over: Record<string, unknown>) => ({ ...BASE, ...over }) as typeof BASE;

describe('automationTemplateRefusal', () => {
  it('allows a template that only needs body values', () => {
    expect(automationTemplateRefusal(BASE)).toBeNull();
    expect(automationTemplateRefusal(null)).toBeNull();
  });

  it.each([
    ['authentication', { template_kind: 'authentication', body_text: '' }],
    ['carousel', { template_kind: 'carousel', cards: [{ body_text: 'Card {{1}}', buttons: [] }] }],
    ['limited-time offer', { template_kind: 'limited_time_offer', lto: { text: 'Sale', has_expiration: false } }],
    ['location header', { header_type: 'location' }],
    ['header variable', { header_type: 'text', header_content: 'Hello {{1}}' }],
    ['URL button variable', { buttons: [{ type: 'URL', text: 'Open', url: 'https://x.test/{{1}}' }] }],
  ])('refuses a %s template with a reason', (_label, over) => {
    const reason = automationTemplateRefusal(tpl(over));
    expect(typeof reason).toBe('string');
    expect(reason).not.toBe('');
  });
});

function fakeDb(rows: Record<string, unknown>[]): DataClient {
  return {
    from() {
      let name = '';
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, v: unknown) => {
          if (col === 'name') name = String(v);
          return b;
        },
        then: (resolve: (r: unknown) => unknown) =>
          resolve({ data: rows.filter((r) => r.name === name), error: null }),
      };
      return b;
    },
  } as unknown as DataClient;
}

describe('automationTemplateIssues', () => {
  const db = fakeDb([
    { id: 't1', user_id: 'u1', name: 'promo', language: 'en_US', ...tpl({ template_kind: 'limited_time_offer', lto: { text: 'x', has_expiration: true } }) },
    { id: 't2', user_id: 'u1', name: 'hello', language: 'en_US', ...BASE },
  ]);

  it('flags a refused template step, including inside condition branches', async () => {
    const issues = await automationTemplateIssues(db, 'acc-1', [
      { step_type: 'send_template', step_config: { template_name: 'hello' } },
      {
        step_type: 'condition',
        step_config: { subject: 'tag' },
        branches: { no: [{ step_type: 'send_template', step_config: { template_name: 'promo', language: 'en_US' } }] },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('steps[1].no.steps[0].template_name');
    expect(issues[0].message).toBeTruthy();
  });

  it('passes body-only and unknown templates', async () => {
    expect(
      await automationTemplateIssues(db, 'acc-1', [
        { step_type: 'send_template', step_config: { template_name: 'hello' } },
        { step_type: 'send_template', step_config: { template_name: 'gone' } },
      ]),
    ).toEqual([]);
    expect(await automationTemplateIssues(db, 'acc-1', undefined)).toEqual([]);
  });
});
