// The phone preview and the message composer (ManyChat-style UI): static
// render checks of what each shows. Behaviour is covered by the e2e specs.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { PhoneBubble } from './flow-preview';
import { PhoneFrame } from './phone-frame';
import { COMPOSER_EMOJI, TextRow } from './forms/fields';

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ key }) => key}>
      {node}
    </NextIntlClientProvider>,
  );
const t = ((key: string) => key) as unknown as Parameters<typeof PhoneBubble>[0]['t'];
const offer = { id: 1, from: 'bot' as const, text: 'Book a call?', buttons: ['Sure!', 'Not interested'] };

describe('PhoneFrame and PhoneBubble', () => {
  it('draws WhatsApp dark with its reply buttons inside the bubble, idle when not the live question', () => {
    const html = wrap(<PhoneFrame channel="whatsapp" title="Acme" subtitle="Business chat"><PhoneBubble message={offer} channel="whatsapp" active={false} t={t} /></PhoneFrame>);
    expect(html).toContain('data-phone="whatsapp"');
    expect(html).toContain('Acme');
    // The buttons sit inside the bubble div (bg-[#2c3541]) and are disabled.
    const bubble = html.slice(html.indexOf('bg-[#2c3541]'));
    expect(bubble.indexOf('Sure!')).toBeGreaterThan(0);
    expect(html.match(/<button[^>]*disabled=""[^>]*>Sure!<\/button>/)).not.toBeNull();
  });

  it('draws Instagram light with the buttons under the bubble, and the customer on the right', () => {
    const html = wrap(<>
      <PhoneBubble message={offer} channel="instagram" active t={t} />
      <PhoneBubble message={{ id: 2, from: 'customer', text: 'Sure!' }} channel="instagram" active={false} t={t} />
    </>);
    expect(html).toContain('bg-[#efefef]');
    expect(html.match(/<button[^>]*>Sure!<\/button>/)?.[0]).not.toContain('disabled');
    expect(html).toContain('ml-auto');
  });
});

describe('message composer (multi-line TextRow)', () => {
  it('counts down to the channel limit in its dark toolbar, with an emoji button', () => {
    const html = wrap(<TextRow label="Text" value="hello" onChange={() => {}} rows={3} maxLength={10} />);
    expect(html).toContain('data-composer=""');
    expect(html).toContain('data-testid="composer-toolbar"');
    expect(html).toContain('aria-label="charactersLeft"');
    expect(html).toMatch(/>5<\/span>/);
    expect(html).toContain('aria-label="emoji"');
  });

  it('counts characters without a limit, and keeps a single-line row plain', () => {
    expect(wrap(<TextRow label="Text" value="hey" onChange={() => {}} rows={2} />)).toMatch(/aria-label="characters"[^>]*>3<\/span>/);
    expect(wrap(<TextRow label="Footer" value="x" onChange={() => {}} />)).not.toContain('composer-toolbar');
  });

  it('offers a fixed set of distinct emoji', () => {
    expect(new Set(COMPOSER_EMOJI).size).toBe(COMPOSER_EMOJI.length);
  });
});
