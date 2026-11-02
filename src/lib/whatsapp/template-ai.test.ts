import { describe, expect, it, vi } from 'vitest';
import {
  buildTemplateDraftPrompt,
  draftTemplate,
  extractJsonObject,
  normaliseTemplateDraft,
  normaliseTemplateName,
  parseTemplateDraftRequest,
  type TemplateDraftGenerator,
  type TemplateDraftRequest,
} from './template-ai';

const REQ: TemplateDraftRequest = {
  goal: 'Tell customers their order has shipped with a tracking link',
  tone: 'friendly',
  category: 'Utility',
  language: 'pt_BR',
  business: 'Café Aurora',
  includeButtons: true,
};

const VALID = {
  name: 'Order Shipped Update!',
  header_text: 'Your order is on its way',
  body_text: 'Hi {{1}}, your order {{2}} has shipped and arrives soon.',
  footer_text: 'Café Aurora',
  buttons: [
    { type: 'URL', text: 'Track order', url: 'https://example.com/track' },
    { type: 'QUICK_REPLY', text: 'Thanks!' },
  ],
  sample_values: { body: ['Ana', 'A-1042'] },
};

const usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };

describe('parseTemplateDraftRequest', () => {
  const body = {
    goal: ' Remind about a booking ',
    tone: 'professional',
    category: 'Marketing',
    language: 'en_US',
  };

  it('accepts a valid brief and trims it', () => {
    expect(parseTemplateDraftRequest({ ...body, include_buttons: true })).toEqual({
      ok: true,
      value: {
        goal: 'Remind about a booking',
        tone: 'professional',
        category: 'Marketing',
        language: 'en_US',
        business: undefined,
        includeButtons: true,
      },
    });
  });

  it.each([
    [{ ...body, goal: '  ' }, 'goalRequired'],
    [{ ...body, goal: 'x'.repeat(501) }, 'goalTooLong'],
    [{ ...body, tone: 'angry' }, 'toneInvalid'],
    [{ ...body, category: 'Authentication' }, 'categoryInvalid'],
    [{ ...body, language: 'english please' }, 'languageInvalid'],
    [{ ...body, business: 'b'.repeat(201) }, 'businessTooLong'],
    [null, 'goalRequired'],
  ])('rejects %j with %s', (input, error) => {
    expect(parseTemplateDraftRequest(input)).toEqual({ ok: false, error });
  });
});

describe('buildTemplateDraftPrompt', () => {
  it('carries the brief, tone, language and Meta limits', () => {
    const { systemPrompt, userMessage } = buildTemplateDraftPrompt(REQ);
    expect(userMessage).toContain(REQ.goal);
    expect(userMessage).toContain('Café Aurora');
    expect(userMessage).toContain('Tone: friendly');
    expect(systemPrompt).toContain('"pt_BR"');
    expect(systemPrompt).toContain('1024');
    expect(systemPrompt).toContain('60');
    expect(systemPrompt).toContain('25');
    expect(systemPrompt).toContain('QUICK_REPLY');
    expect(systemPrompt).toContain('Utility');
  });

  it('forbids buttons when not requested', () => {
    const { systemPrompt } = buildTemplateDraftPrompt({ ...REQ, includeButtons: false });
    expect(systemPrompt).toContain('Do not include buttons.');
  });
});

describe('extractJsonObject', () => {
  it('parses plain, fenced and chatty output', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":"}"}\n```')).toEqual({ a: '}' });
    expect(extractJsonObject('Sure! Here it is: {"a":{"b":2}} Hope that helps {x}')).toEqual({
      a: { b: 2 },
    });
  });

  it('returns null for unusable output', () => {
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"a": ')).toBeNull();
    expect(extractJsonObject('[1,2]')).toBeNull();
  });
});

describe('normaliseTemplateDraft', () => {
  it('normalises the name and takes category/language from the request', () => {
    const draft = normaliseTemplateDraft(
      { ...VALID, category: 'Authentication', language: 'xx' },
      REQ,
    );
    expect(draft.name).toBe('order_shipped_update');
    expect(draft.category).toBe('Utility');
    expect(draft.language).toBe('pt_BR');
    expect(draft.header_type).toBe('text');
    expect(draft.header_content).toBe('Your order is on its way');
    // Quick replies are moved ahead of the URL button.
    expect(draft.buttons?.map((b) => b.type)).toEqual(['QUICK_REPLY', 'URL']);
  });

  it('caps header, footer, button and sample lengths', () => {
    const draft = normaliseTemplateDraft(
      {
        ...VALID,
        header_text: 'h'.repeat(80),
        footer_text: 'f'.repeat(80),
        buttons: [{ type: 'QUICK_REPLY', text: 'b'.repeat(40) }],
        sample_values: { body: ['s'.repeat(300), 42] },
      },
      REQ,
    );
    expect(draft.header_content).toHaveLength(60);
    expect(draft.footer_text).toHaveLength(60);
    expect(draft.buttons?.[0].text).toHaveLength(25);
    expect(draft.sample_values?.body?.[0]).toHaveLength(200);
    expect(draft.sample_values?.body?.[1]).toBe('42');
  });

  it('drops buttons when not requested and ignores junk entries', () => {
    expect(normaliseTemplateDraft(VALID, { ...REQ, includeButtons: false }).buttons).toBeUndefined();
    const draft = normaliseTemplateDraft(
      {
        ...VALID,
        buttons: [null, { type: 'PHONE_NUMBER', text: 'Call' }, { type: 'URL', text: 'x' }, 'a'],
      },
      REQ,
    );
    expect(draft.buttons).toBeUndefined();
  });

  it('falls back to a usable name', () => {
    expect(normaliseTemplateName('Promoção de Natal')).toBe('promo_o_de_natal');
    expect(normaliseTemplateName('日本語')).toBe('ai_template_draft');
    expect(normaliseTemplateName(undefined)).toBe('ai_template_draft');
    expect(normaliseTemplateName('a'.repeat(600))).toHaveLength(512);
  });
});

describe('draftTemplate', () => {
  it('returns a validated draft from the first answer', async () => {
    const generate = vi.fn<TemplateDraftGenerator>().mockResolvedValue({
      text: JSON.stringify(VALID),
      usage,
    });
    const result = await draftTemplate(REQ, generate);
    expect(result).toMatchObject({ ok: true, usages: [usage] });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries once with the validation error and accepts the fix', async () => {
    const generate = vi
      .fn<TemplateDraftGenerator>()
      .mockResolvedValueOnce({
        text: JSON.stringify({ ...VALID, sample_values: { body: ['Ana'] } }),
        usage,
      })
      .mockResolvedValueOnce({ text: '```json\n' + JSON.stringify(VALID) + '\n```', usage: null });
    const result = await draftTemplate(REQ, generate);
    expect(result.ok).toBe(true);
    expect(result.usages).toEqual([usage, null]);
    const retryMessages = generate.mock.calls[1][1];
    expect(retryMessages).toHaveLength(3);
    expect(retryMessages[1].role).toBe('assistant');
    expect(retryMessages[2].content).toContain('failed validation');
  });

  it('asks for JSON again when the first answer is unreadable', async () => {
    const generate = vi
      .fn<TemplateDraftGenerator>()
      .mockResolvedValueOnce({ text: '', usage: null })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID), usage });
    const result = await draftTemplate(REQ, generate);
    expect(result.ok).toBe(true);
    const retryMessages = generate.mock.calls[1][1];
    expect(retryMessages[1].content).toBe('(no output)');
    expect(retryMessages[2].content).toContain('not a single valid JSON object');
  });

  it('gives up after the second invalid draft', async () => {
    const generate = vi.fn<TemplateDraftGenerator>().mockResolvedValue({
      text: JSON.stringify({ ...VALID, body_text: 'Hi {{1}} and {{3}}' }),
      usage,
    });
    const result = await draftTemplate(REQ, generate);
    expect(result).toMatchObject({ ok: false, reason: 'invalid', usages: [usage, usage] });
    expect(result.ok === false && result.message).toBeTruthy();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('reports unreadable when neither answer has JSON', async () => {
    const generate = vi.fn<TemplateDraftGenerator>().mockResolvedValue({ text: 'nope', usage: null });
    expect(await draftTemplate(REQ, generate)).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});
