import { describe, expect, it } from 'vitest';
import { buildMetaTemplatePayload } from './template-components';
import type { TemplatePayload } from './template-validators';

describe('buildMetaTemplatePayload — location header', () => {
  it('emits a LOCATION header with no example', () => {
    expect(
      buildMetaTemplatePayload({
        name: 'store_visit',
        category: 'Utility',
        language: 'en_US',
        header_type: 'location',
        body_text: 'See you soon.',
      }),
    ).toEqual({
      name: 'store_visit',
      category: 'UTILITY',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'LOCATION' },
        { type: 'BODY', text: 'See you soon.' },
      ],
    });
  });
});

describe('buildMetaTemplatePayload — carousel', () => {
  const payload: TemplatePayload = {
    name: 'spring_carousel',
    category: 'Marketing',
    language: 'en_US',
    template_kind: 'carousel',
    body_text: 'Hi {{1}}, new arrivals.',
    sample_values: { body: ['Ana'] },
    cards: [
      {
        header_type: 'image',
        header_handle: 'h:one',
        header_media_url: 'https://cdn.example/one.jpg',
        body_text: 'Shoes for {{1}}',
        sample_values: { body: ['$40'] },
        buttons: [
          { type: 'QUICK_REPLY', text: 'More' },
          { type: 'URL', text: 'Buy', url: 'https://shop.example/{{1}}', example: 'https://shop.example/1' },
        ],
      },
      {
        header_type: 'image',
        header_media_url: 'https://cdn.example/two.jpg',
        body_text: 'Bags',
        buttons: [
          { type: 'QUICK_REPLY', text: 'More' },
          { type: 'URL', text: 'Buy', url: 'https://shop.example/bags' },
        ],
      },
    ],
  };

  it('emits BODY then CAROUSEL with one HEADER/BODY/BUTTONS set per card', () => {
    expect(buildMetaTemplatePayload(payload)).toEqual({
      name: 'spring_carousel',
      category: 'MARKETING',
      language: 'en_US',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, new arrivals.', example: { body_text: [['Ana']] } },
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h:one'] } },
                { type: 'BODY', text: 'Shoes for {{1}}', example: { body_text: [['$40']] } },
                {
                  type: 'BUTTONS',
                  buttons: [
                    { type: 'QUICK_REPLY', text: 'More' },
                    {
                      type: 'URL',
                      text: 'Buy',
                      url: 'https://shop.example/{{1}}',
                      example: ['https://shop.example/1'],
                    },
                  ],
                },
              ],
            },
            {
              components: [
                { type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://cdn.example/two.jpg'] } },
                { type: 'BODY', text: 'Bags' },
                {
                  type: 'BUTTONS',
                  buttons: [
                    { type: 'QUICK_REPLY', text: 'More' },
                    { type: 'URL', text: 'Buy', url: 'https://shop.example/bags' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('uses VIDEO for video card headers', () => {
    const video = buildMetaTemplatePayload({
      ...payload,
      cards: payload.cards!.map((c) => ({ ...c, header_type: 'video' as const })),
    });
    const cards = video.components[1].cards!;
    expect(cards.map((c) => c.components[0].format)).toEqual(['VIDEO', 'VIDEO']);
  });
});

describe('buildMetaTemplatePayload — authentication', () => {
  const base: TemplatePayload = {
    name: 'login_code',
    category: 'Authentication',
    language: 'en_US',
    template_kind: 'authentication',
    body_text: 'ignored',
    auth_options: {
      otp_type: 'COPY_CODE',
      add_security_recommendation: true,
      code_expiration_minutes: 10,
      button_text: 'Copy code',
    },
  };

  it('sends the options, never the stored body text', () => {
    expect(buildMetaTemplatePayload(base)).toEqual({
      name: 'login_code',
      category: 'AUTHENTICATION',
      language: 'en_US',
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
        },
      ],
    });
  });

  it('omits the footer and button text when they are not set', () => {
    expect(
      buildMetaTemplatePayload({ ...base, auth_options: { otp_type: 'COPY_CODE' } }).components,
    ).toEqual([
      { type: 'BODY' },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ]);
  });
});

describe('buildMetaTemplatePayload — limited_time_offer', () => {
  it('emits HEADER, LIMITED_TIME_OFFER, BODY then BUTTONS', () => {
    expect(
      buildMetaTemplatePayload({
        name: 'flash_sale',
        category: 'Marketing',
        language: 'en_US',
        template_kind: 'limited_time_offer',
        header_type: 'image',
        header_handle: 'h:sale',
        body_text: 'Hi {{1}}, the sale ends soon.',
        sample_values: { body: ['Ana'] },
        lto: { text: 'Flash sale', has_expiration: true },
        buttons: [
          { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE20' },
          { type: 'URL', text: 'Shop', url: 'https://shop.example/sale' },
        ],
      }),
    ).toEqual({
      name: 'flash_sale',
      category: 'MARKETING',
      language: 'en_US',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h:sale'] } },
        {
          type: 'LIMITED_TIME_OFFER',
          limited_time_offer: { text: 'Flash sale', has_expiration: true },
        },
        { type: 'BODY', text: 'Hi {{1}}, the sale ends soon.', example: { body_text: [['Ana']] } },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'COPY_CODE', text: 'Copy code', example: ['SAVE20'] },
            { type: 'URL', text: 'Shop', url: 'https://shop.example/sale' },
          ],
        },
      ],
    });
  });

  it('omits the header and buttons when there are none', () => {
    expect(
      buildMetaTemplatePayload({
        name: 'flash_sale',
        category: 'Marketing',
        language: 'en_US',
        template_kind: 'limited_time_offer',
        body_text: 'Sale today.',
        lto: { text: 'Today only', has_expiration: false },
      }).components,
    ).toEqual([
      {
        type: 'LIMITED_TIME_OFFER',
        limited_time_offer: { text: 'Today only', has_expiration: false },
      },
      { type: 'BODY', text: 'Sale today.' },
    ]);
  });
});
