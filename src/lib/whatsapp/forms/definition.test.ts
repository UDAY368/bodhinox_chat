import { describe, expect, it } from 'vitest';
import { emptyFormDefinition, normaliseFormDefinition, validateFormDefinition } from './definition';
import type { FormDefinition, FormField } from './types';

const screen = (fields: FormField[], id = 'DETAILS') => ({ id, title: 'Your details', fields, button_label: 'Next' });
const form = (...screens: ReturnType<typeof screen>[]): FormDefinition => ({ version: 1, screens });
const input = (over: Partial<FormField> = {}): FormField => ({ id: 'name', type: 'short_text', label: 'Name', ...over });
const paths = (def: unknown) => {
  const result = validateFormDefinition(def);
  return result.ok ? [] : result.errors.map((e) => e.path);
};

describe('validateFormDefinition', () => {
  it('accepts a valid form with every field type and returns the normalised definition', () => {
    const def = form(screen([
      { id: 'intro', type: 'heading', label: 'Welcome' },
      { id: 'note', type: 'paragraph', label: 'A few questions.' },
      input({ label: '  Name ', required: true, save_to: { kind: 'contact_field', field: 'name' } }),
      { id: 'mail', type: 'email', label: 'Email', helper: 'Work email' },
      { id: 'tel', type: 'phone', label: 'Phone' },
      { id: 'age', type: 'number', label: 'Age', min: 1, max: 3 },
      { id: 'about', type: 'long_text', label: 'About you', max: 500 },
      { id: 'day', type: 'date', label: 'Preferred day' },
      { id: 'city', type: 'dropdown', label: 'City', options: [{ id: 'nyc', title: 'New York' }] },
      { id: 'size', type: 'radio', label: 'Size', options: [{ id: 's', title: 'Small' }, { id: 'l', title: 'Large' }] },
      { id: 'topics', type: 'checkboxes', label: 'Topics', options: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], min: 1, max: 2 },
      { id: 'consent', type: 'opt_in', label: 'I agree to be contacted about my request.', required: true },
    ]));
    const result = validateFormDefinition(def);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.screens[0].fields[2].label).toBe('Name');
  });

  it('rejects non-objects, bad versions and screen counts', () => {
    expect(paths(null)).toEqual(['']);
    expect(paths({ version: 2, screens: [screen([input()])] })).toContain('version');
    expect(paths({ version: 1, screens: [] })).toContain('screens');
    const eleven = Array.from({ length: 11 }, (_, i) => screen([input({ id: `f${i}` })], `S${i}`));
    expect(paths(form(...eleven))).toContain('screens');
  });

  it('enforces screen ids, titles, buttons and field counts', () => {
    expect(paths(form({ ...screen([input()]), id: 'details' }))).toContain('screens.0.id');
    expect(paths(form(screen([input()], 'A'), screen([input({ id: 'x' })], 'A')))).toContain('screens.1.id');
    expect(paths(form({ ...screen([input()]), title: 'x'.repeat(31) }))).toContain('screens.0.title');
    expect(paths(form({ ...screen([input()]), button_label: '' }))).toContain('screens.0.button_label');
    expect(paths(form({ ...screen([input()]), button_label: 'x'.repeat(31) }))).toContain('screens.0.button_label');
    expect(paths(form(screen([])))).toContain('screens.0.fields');
    const many = Array.from({ length: 21 }, (_, i) => input({ id: `f${i}` }));
    expect(paths(form(screen(many)))).toContain('screens.0.fields');
  });

  it('enforces field ids: pattern, reserved names and uniqueness across screens', () => {
    expect(paths(form(screen([input({ id: 'Name' })])))).toContain('screens.0.fields.0.id');
    expect(paths(form(screen([input({ id: 'flow_token' })])))).toContain('screens.0.fields.0.id');
    // 'error' would read as Meta's error notification at the endpoint; 'error_message' carries screen errors.
    expect(paths(form(screen([input({ id: 'error' })])))).toContain('screens.0.fields.0.id');
    expect(paths(form(screen([input({ id: 'error_message' })])))).toContain('screens.0.fields.0.id');
    expect(paths(form(screen([input()], 'A'), screen([input()], 'B')))).toContain('screens.1.fields.0.id');
  });

  it('applies per-type label limits from Meta', () => {
    expect(paths(form(screen([input({ label: 'x'.repeat(21) })])))).toContain('screens.0.fields.0.label');
    expect(paths(form(screen([input({ type: 'date', label: 'x'.repeat(40) })])))).toEqual([]);
    expect(paths(form(screen([input({ type: 'opt_in', label: 'x'.repeat(121) })])))).toContain('screens.0.fields.0.label');
    expect(paths(form(screen([{ id: 'h', type: 'heading', label: 'x'.repeat(81) }, input()])))).toContain('screens.0.fields.0.label');
    expect(paths(form(screen([{ id: 'p', type: 'paragraph', label: 'x'.repeat(4097) }, input()])))).toContain('screens.0.fields.0.label');
    expect(paths(form(screen([input({ label: '   ' })])))).toContain('screens.0.fields.0.label');
  });

  it('rejects required, helper and save_to on display-only fields', () => {
    const p = paths(form(screen([
      { id: 'h', type: 'heading', label: 'Hi', required: true, helper: 'x', save_to: { kind: 'contact_field', field: 'name' } },
      input(),
    ])));
    expect(p).toEqual(expect.arrayContaining(['screens.0.fields.0.required', 'screens.0.fields.0.helper', 'screens.0.fields.0.save_to']));
    expect(paths(form(screen([input({ helper: 'x'.repeat(81) })])))).toContain('screens.0.fields.0.helper');
  });

  it('checks choice options: count, ids, uniqueness and titles', () => {
    const choice = (options: { id: string; title: string }[]) => form(screen([input({ type: 'radio', label: 'Pick', options })]));
    expect(paths(choice([]))).toContain('screens.0.fields.0.options');
    expect(paths(choice(Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, title: 'T' }))))).toContain('screens.0.fields.0.options');
    expect(paths(choice([{ id: 'a b', title: 'T' }]))).toContain('screens.0.fields.0.options.0.id');
    expect(paths(choice([{ id: 'a', title: 'T' }, { id: 'a', title: 'U' }]))).toContain('screens.0.fields.0.options.1.id');
    expect(paths(choice([{ id: 'a', title: 'x'.repeat(31) }]))).toContain('screens.0.fields.0.options.0.title');
    expect(paths(form(screen([input({ options: [{ id: 'a', title: 'A' }] })])))).toContain('screens.0.fields.0.options');
  });

  it('checks min/max bounds per type', () => {
    expect(paths(form(screen([input({ min: 5, max: 2 })])))).toContain('screens.0.fields.0.min');
    expect(paths(form(screen([input({ min: -1 })])))).toContain('screens.0.fields.0.min');
    expect(paths(form(screen([input({ max: 1.5 })])))).toContain('screens.0.fields.0.max');
    expect(paths(form(screen([input({ max: 81 })])))).toContain('screens.0.fields.0.max');
    expect(paths(form(screen([input({ type: 'long_text', label: 'About', min: 1 })])))).toContain('screens.0.fields.0.min');
    expect(paths(form(screen([input({ type: 'date', label: 'Day', max: 3 })])))).toContain('screens.0.fields.0.max');
    const boxes = (max: number) => form(screen([input({ type: 'checkboxes', label: 'T', options: [{ id: 'a', title: 'A' }], max })]));
    expect(paths(boxes(2))).toContain('screens.0.fields.0.max');
    expect(paths(boxes(1))).toEqual([]);
  });

  it('checks save_to targets', () => {
    expect(paths(form(screen([input({ save_to: { kind: 'custom_field', field_id: 'not-a-uuid' } })])))).toContain('screens.0.fields.0.save_to');
    expect(paths(form(screen([input({ save_to: { kind: 'contact_field', field: 'phone' as 'name' } })])))).toContain('screens.0.fields.0.save_to');
    expect(paths(form(screen([input({ type: 'checkboxes', label: 'T', options: [{ id: 'a', title: 'A' }], save_to: { kind: 'contact_field', field: 'name' } })])))).toContain('screens.0.fields.0.save_to');
    expect(paths(form(screen([input({ save_to: { kind: 'custom_field', field_id: '6f1c2b1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e' } })])))).toEqual([]);
  });

  it('requires at least one question and bounds the success message', () => {
    expect(paths(form(screen([{ id: 'h', type: 'heading', label: 'Hi' }])))).toContain('screens');
    expect(paths({ ...form(screen([input()])), success_message: 'x'.repeat(1025) })).toContain('success_message');
  });

  it('rejects unknown field types without crashing', () => {
    expect(paths(form(screen([input({ type: 'slider' as 'short_text' })])))).toContain('screens.0.fields.0.type');
  });
});

describe('normaliseFormDefinition', () => {
  it('trims text, drops empty optionals and defaults the version', () => {
    const out = normaliseFormDefinition({
      screens: [{ id: ' A ', title: ' T ', button_label: ' Go ', fields: [{ id: ' x ', type: 'short_text', label: ' L ', helper: '  ' }] }],
      success_message: '  ',
    });
    expect(out).toEqual({ version: 1, screens: [{ id: 'A', title: 'T', button_label: 'Go', fields: [{ id: 'x', type: 'short_text', label: 'L' }] }] });
  });
  it('turns garbage into an empty definition', () => {
    expect(normaliseFormDefinition('nope')).toEqual({ version: 1, screens: [] });
  });
});

describe('emptyFormDefinition', () => {
  it('is a valid one-screen form', () => {
    const result = validateFormDefinition(emptyFormDefinition({ title: 'Your details', field: 'Name', button: 'Submit' }));
    expect(result.ok).toBe(true);
  });
});
