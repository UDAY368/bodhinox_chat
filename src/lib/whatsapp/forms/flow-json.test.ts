import { describe, expect, it } from 'vitest';
import { validateFormDefinition } from './definition';
import { compileFlowJson, formInputFields, type FlowJson } from './flow-json';
import type { FormDefinition } from './types';

const oneScreen: FormDefinition = {
  version: 1,
  screens: [{
    id: 'CONTACT',
    title: 'Contact us',
    button_label: 'Send',
    fields: [
      { id: 'name', type: 'short_text', label: 'Name', required: true },
      { id: 'message', type: 'long_text', label: 'Message', helper: 'Tell us more', max: 300 },
    ],
  }],
};

const threeScreens: FormDefinition = {
  version: 1,
  screens: [
    {
      id: 'ABOUT', title: 'About you', button_label: 'Next', fields: [
        { id: 'intro', type: 'heading', label: 'Welcome' },
        { id: 'note', type: 'paragraph', label: 'Two minutes.' },
        { id: 'name', type: 'short_text', label: 'Name', required: true, min: 2, max: 60 },
        { id: 'email', type: 'email', label: 'Email', helper: 'We reply here' },
        { id: 'phone', type: 'phone', label: 'Phone' },
        { id: 'seats', type: 'number', label: 'Seats' },
      ],
    },
    {
      id: 'BOOKING', title: 'Booking', button_label: 'Next', fields: [
        { id: 'day', type: 'date', label: 'Day', required: true },
        { id: 'branch', type: 'dropdown', label: 'Branch', options: [{ id: 'north', title: 'North' }, { id: 'south', title: 'South' }] },
        { id: 'slot', type: 'radio', label: 'Slot', required: true, options: [{ id: 'am', title: 'Morning' }, { id: 'pm', title: 'Evening' }] },
      ],
    },
    {
      id: 'CONFIRM', title: 'Confirm', button_label: 'Book', fields: [
        { id: 'extras', type: 'checkboxes', label: 'Extras', options: [{ id: 'tea', title: 'Tea' }, { id: 'cake', title: 'Cake' }], min: 1, max: 2 },
        { id: 'consent', type: 'opt_in', label: 'Send me reminders', required: true },
      ],
    },
  ],
};

type Child = Record<string, unknown>;
const formChildren = (json: FlowJson, screen: number) =>
  ((json.screens[screen].layout.children[0] as Child).children as Child[]);
const footerAction = (json: FlowJson, screen: number) => {
  const children = formChildren(json, screen);
  return children[children.length - 1]['on-click-action'] as Record<string, unknown>;
};

/** Every `${data.x}` must be declared in that screen's data; every `${form.x}` must be an input on it. */
function assertReferencesDeclared(json: FlowJson) {
  for (const [index, screen] of json.screens.entries()) {
    const text = JSON.stringify(screen.layout);
    const declared = new Set(Object.keys(screen.data ?? {}));
    const names = new Set(formChildren(json, index).map((c) => c.name).filter(Boolean));
    for (const [, key] of text.matchAll(/\$\{data\.([a-z0-9_]+)\}/g)) expect(declared.has(key), `${screen.id} data.${key}`).toBe(true);
    for (const [, key] of text.matchAll(/\$\{form\.([a-z0-9_]+)\}/g)) expect(names.has(key), `${screen.id} form.${key}`).toBe(true);
  }
}

describe('compileFlowJson', () => {
  it('compiles a one-screen form that completes with its values', () => {
    expect(validateFormDefinition(oneScreen).ok).toBe(true);
    expect(compileFlowJson(oneScreen, { usesEndpoint: false })).toEqual({
      version: '6.3',
      screens: [{
        id: 'CONTACT',
        title: 'Contact us',
        terminal: true,
        success: true,
        layout: {
          type: 'SingleColumnLayout',
          children: [{
            type: 'Form',
            name: 'form',
            children: [
              { type: 'TextInput', name: 'name', label: 'Name', 'input-type': 'text', required: true },
              { type: 'TextArea', name: 'message', label: 'Message', 'helper-text': 'Tell us more', 'max-length': 300 },
              {
                type: 'Footer',
                label: 'Send',
                'on-click-action': { name: 'complete', payload: { name: '${form.name}', message: '${form.message}' } },
              },
            ],
          }],
        },
      }],
    });
  });

  it('maps every field type to its Meta component', () => {
    const json = compileFlowJson(threeScreens, { usesEndpoint: false });
    const [about, booking, confirm] = [0, 1, 2].map((i) => formChildren(json, i));
    expect(about.slice(0, 6)).toEqual([
      { type: 'TextHeading', text: 'Welcome' },
      { type: 'TextBody', text: 'Two minutes.' },
      { type: 'TextInput', name: 'name', label: 'Name', 'input-type': 'text', required: true, 'min-chars': 2, 'max-chars': 60 },
      { type: 'TextInput', name: 'email', label: 'Email', 'input-type': 'email', 'helper-text': 'We reply here' },
      { type: 'TextInput', name: 'phone', label: 'Phone', 'input-type': 'phone' },
      { type: 'TextInput', name: 'seats', label: 'Seats', 'input-type': 'number' },
    ]);
    expect(booking.slice(0, 3)).toEqual([
      { type: 'DatePicker', name: 'day', label: 'Day', required: true },
      { type: 'Dropdown', name: 'branch', label: 'Branch', 'data-source': [{ id: 'north', title: 'North' }, { id: 'south', title: 'South' }] },
      { type: 'RadioButtonsGroup', name: 'slot', label: 'Slot', required: true, 'data-source': [{ id: 'am', title: 'Morning' }, { id: 'pm', title: 'Evening' }] },
    ]);
    expect(confirm.slice(0, 2)).toEqual([
      { type: 'CheckboxGroup', name: 'extras', label: 'Extras', 'data-source': [{ id: 'tea', title: 'Tea' }, { id: 'cake', title: 'Cake' }], 'min-selected-items': 1, 'max-selected-items': 2 },
      { type: 'OptIn', name: 'consent', label: 'Send me reminders', required: true },
    ]);
  });

  it('navigates through three screens carrying values, then completes with all of them', () => {
    expect(validateFormDefinition(threeScreens).ok).toBe(true);
    const json = compileFlowJson(threeScreens, { usesEndpoint: false });
    expect(json.data_api_version).toBeUndefined();
    expect(json.routing_model).toBeUndefined();
    expect(json.screens.map((s) => s.terminal ?? false)).toEqual([false, false, true]);
    expect(json.screens[0].data).toBeUndefined();
    expect(Object.keys(json.screens[1].data ?? {})).toEqual(['name', 'email', 'phone', 'seats']);
    expect(json.screens[2].data).toMatchObject({
      name: { type: 'string', __example__: '' },
      slot: { type: 'string', __example__: '' },
    });
    expect(footerAction(json, 0)).toEqual({
      name: 'navigate',
      next: { type: 'screen', name: 'BOOKING' },
      payload: { name: '${form.name}', email: '${form.email}', phone: '${form.phone}', seats: '${form.seats}' },
    });
    expect(footerAction(json, 1)).toMatchObject({ name: 'navigate', next: { type: 'screen', name: 'CONFIRM' } });
    expect((footerAction(json, 1).payload as Record<string, string>).name).toBe('${data.name}');
    const complete = footerAction(json, 2);
    expect(complete.name).toBe('complete');
    expect(Object.keys(complete.payload as object)).toEqual(formInputFields(threeScreens).map((f) => f.id));
    expect(complete.payload).toMatchObject({ day: '${data.day}', extras: '${form.extras}', consent: '${form.consent}' });
    assertReferencesDeclared(json);
  });

  it('declares checkbox and opt-in values with their own types when carried', () => {
    const def: FormDefinition = {
      version: 1,
      screens: [
        { id: 'A', title: 'A', button_label: 'Next', fields: [
          { id: 'tags', type: 'checkboxes', label: 'Tags', options: [{ id: 'x', title: 'X' }] },
          { id: 'ok', type: 'opt_in', label: 'OK' },
        ] },
        { id: 'B', title: 'B', button_label: 'Done', fields: [{ id: 'name', type: 'short_text', label: 'Name' }] },
      ],
    };
    const json = compileFlowJson(def, { usesEndpoint: false });
    expect(json.screens[1].data).toEqual({
      tags: { type: 'array', items: { type: 'string' }, __example__: [] },
      ok: { type: 'boolean', __example__: false },
    });
    assertReferencesDeclared(json);
  });

  it('uses data_exchange, a routing model and a terminal success screen in endpoint mode', () => {
    const json = compileFlowJson(threeScreens, { usesEndpoint: true });
    expect(json.version).toBe('6.3');
    expect(json.data_api_version).toBe('3.0');
    expect(json.routing_model).toEqual({ ABOUT: ['BOOKING'], BOOKING: ['CONFIRM'], CONFIRM: [] });
    expect(json.screens.every((s) => s.data === undefined)).toBe(true);
    expect(json.screens[2]).toMatchObject({ terminal: true, success: true });
    expect(footerAction(json, 1)).toEqual({
      name: 'data_exchange',
      payload: { day: '${form.day}', branch: '${form.branch}', slot: '${form.slot}' },
    });
    expect(JSON.stringify(json)).not.toContain('${data.');
    assertReferencesDeclared(json);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(compileFlowJson(threeScreens, { usesEndpoint: false }));
    const b = JSON.stringify(compileFlowJson(structuredClone(threeScreens), { usesEndpoint: false }));
    expect(a).toBe(b);
  });
});

describe('screen ids sent to WhatsApp', () => {
  it('spells out digits so older SCREEN_n ids pass Meta (letters and underscores only)', () => {
    const legacy: FormDefinition = {
      version: 1,
      screens: [
        { id: 'SCREEN_1', title: 'One', button_label: 'Next', fields: [{ id: 'name', type: 'short_text', label: 'Name' }] },
        { id: 'SCREEN_12', title: 'Two', button_label: 'Send', fields: [{ id: 'city', type: 'short_text', label: 'City' }] },
      ],
    };
    expect(validateFormDefinition(legacy).ok).toBe(true);
    for (const usesEndpoint of [false, true]) {
      const json = compileFlowJson(legacy, { usesEndpoint }) as FlowJson & { routing_model?: Record<string, string[]> };
      expect(json.screens.map((s) => s.id)).toEqual(['SCREEN_ONE', 'SCREEN_ONETWO']);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/SCREEN_\d/);
      if (usesEndpoint) expect(json.routing_model).toEqual({ SCREEN_ONE: ['SCREEN_ONETWO'], SCREEN_ONETWO: [] });
    }
  });

  it('refuses two stored ids that would reach WhatsApp as the same id', () => {
    const clash: FormDefinition = {
      version: 1,
      screens: [
        { id: 'SCREEN_1', title: 'One', button_label: 'Next', fields: [{ id: 'name', type: 'short_text', label: 'Name' }] },
        { id: 'SCREEN_ONE', title: 'Two', button_label: 'Send', fields: [{ id: 'city', type: 'short_text', label: 'City' }] },
      ],
    };
    expect(validateFormDefinition(clash).ok).toBe(false);
  });
});
