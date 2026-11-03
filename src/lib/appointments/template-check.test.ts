import { describe, expect, it } from 'vitest';
import { appointmentTemplateRefusal, manageButtonIndex, manageButtonUrl, type AppointmentCheckedTemplate } from './template-check';

const ORIGIN = 'https://app.example.test';
const base: AppointmentCheckedTemplate = {
  category: 'Utility',
  body_text: 'Your {{1}} is on {{2}} at {{3}}.',
  header_type: undefined,
  header_content: undefined,
  header_media_url: undefined,
  buttons: [],
  template_kind: 'standard',
  cards: undefined,
  lto: undefined,
};
const check = (patch: Partial<AppointmentCheckedTemplate>) => appointmentTemplateRefusal({ ...base, ...patch } as AppointmentCheckedTemplate, ORIGIN);

describe('appointmentTemplateRefusal', () => {
  it('accepts a UTILITY template with body variables, a text header variable and the manage button', () => {
    expect(check({})).toBeNull();
    expect(check({ header_type: 'text', header_content: 'Hi {{1}}' })).toBeNull();
    expect(check({
      buttons: [
        { type: 'QUICK_REPLY', text: 'OK' },
        { type: 'URL', text: 'Manage', url: `${ORIGIN}/my-booking/{{1}}` },
        { type: 'URL', text: 'Site', url: 'https://example.test/' },
      ],
    })).toBeNull();
    expect(check({ header_type: 'image', header_media_url: 'https://cdn.example.test/a.png' })).toBeNull();
  });

  it('refuses marketing and authentication categories', () => {
    expect(check({ category: 'Marketing' })).toBe('not_utility');
    expect(check({ category: 'Authentication' })).toBe('not_utility');
    expect(check({ template_kind: 'authentication' })).toBe('authentication');
  });

  it('refuses shapes needing values it cannot supply', () => {
    expect(check({ template_kind: 'carousel' })).toBe('carousel');
    expect(check({ template_kind: 'limited_time_offer' })).toBe('limited_time_offer');
    expect(check({ header_type: 'location' })).toBe('location_header');
    expect(check({ header_type: 'video' })).toBe('media_header_without_url');
    expect(check({ header_type: 'text', header_content: '{{1}} {{2}}' })).toBe('header_variables');
    expect(check({ buttons: [{ type: 'FLOW', text: 'Open', flow_id: '1' }] })).toBe('flow_button');
  });

  it('allows one variable URL button and only to the manage page', () => {
    const manage = { type: 'URL' as const, text: 'Manage', url: `${ORIGIN}/my-booking/{{1}}` };
    expect(check({ buttons: [manage, { ...manage, text: 'Again' }] })).toBe('too_many_url_buttons');
    expect(check({ buttons: [{ ...manage, url: 'https://evil.example/{{1}}' }] })).toBe('url_button_base');
    expect(check({ buttons: [{ ...manage, url: `${ORIGIN}/r/{{1}}` }] })).toBe('url_button_base');
  });

  it('finds the manage button index and builds its URL', () => {
    expect(manageButtonUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/my-booking/{{1}}`);
    expect(manageButtonIndex({ buttons: [{ type: 'QUICK_REPLY', text: 'x' }, { type: 'URL', text: 'm', url: `${ORIGIN}/my-booking/{{1}}` }] })).toBe(1);
    expect(manageButtonIndex({ buttons: [] })).toBeNull();
  });

  it('null template is not refused (missing template is a separate check)', () => {
    expect(appointmentTemplateRefusal(null, ORIGIN)).toBeNull();
  });
});
