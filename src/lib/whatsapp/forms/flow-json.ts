/**
 * Compiles a validated FormDefinition into Meta Flow JSON (version 6.3).
 *
 * Navigation mode (default): every screen wraps its components in a Form;
 * a non-final footer navigates to the next screen and carries every value
 * collected so far in its payload, which the next screen declares in `data`
 * and forwards as `${data.x}`. The final screen completes the flow with all
 * values, so the submission arrives as one `nfm_reply` message.
 *
 * Endpoint mode: each footer sends only that screen's values with
 * `data_exchange`; the endpoint keeps state per flow token and answers with
 * the next screen. `data_api_version` and `routing_model` are emitted only here.
 *
 * Output is deterministic: same definition, same JSON, key order included.
 */

import { isInputField } from './definition';
import type { FormDefinition, FormField, FormScreen } from './types';

export const FLOW_JSON_VERSION = '6.3';
export const FLOW_DATA_API_VERSION = '3.0';
/** Name of the Form wrapper on every screen. */
const FORM_NAME = 'form';

export interface CompileFlowJsonOptions {
  usesEndpoint: boolean;
}

export type FlowComponent = Record<string, unknown>;
export interface FlowScreenJson {
  id: string;
  title: string;
  terminal?: true;
  success?: true;
  data?: Record<string, Record<string, unknown>>;
  layout: { type: 'SingleColumnLayout'; children: FlowComponent[] };
}
export interface FlowJson {
  version: string;
  data_api_version?: string;
  routing_model?: Record<string, string[]>;
  screens: FlowScreenJson[];
}

const TEXT_INPUT_TYPE = { short_text: 'text', email: 'email', phone: 'phone', number: 'number' } as const;

/** The input fields (not headings or paragraphs) of a screen, in order. */
export function screenInputFields(screen: FormScreen): FormField[] {
  return screen.fields.filter((field) => isInputField(field.type));
}

/** Every input field of the form, in screen order: the keys of a submission. */
export function formInputFields(definition: FormDefinition): FormField[] {
  return definition.screens.flatMap(screenInputFields);
}

/**
 * The `data` schema for a value carried to a later screen. Meta returns
 * CheckboxGroup as a list of ids, OptIn as a boolean and every other input
 * (TextInput of any input-type included) as a string.
 */
function dataSchema(field: FormField): Record<string, unknown> {
  if (field.type === 'checkboxes') return { type: 'array', items: { type: 'string' }, __example__: [] };
  if (field.type === 'opt_in') return { type: 'boolean', __example__: false };
  return { type: 'string', __example__: '' };
}

function options(field: FormField) {
  return (field.options ?? []).map((option) => ({ id: option.id, title: option.title }));
}

function component(field: FormField): FlowComponent {
  const required = field.required ? { required: true } : {};
  const helper = field.helper ? { 'helper-text': field.helper } : {};
  switch (field.type) {
    case 'heading':
      return { type: 'TextHeading', text: field.label };
    case 'paragraph':
      return { type: 'TextBody', text: field.label };
    case 'short_text':
    case 'email':
    case 'phone':
    case 'number':
      return {
        type: 'TextInput',
        name: field.id,
        label: field.label,
        'input-type': TEXT_INPUT_TYPE[field.type],
        ...required,
        ...helper,
        ...(field.min !== undefined ? { 'min-chars': field.min } : {}),
        ...(field.max !== undefined ? { 'max-chars': field.max } : {}),
      };
    case 'long_text':
      return {
        type: 'TextArea',
        name: field.id,
        label: field.label,
        ...required,
        ...helper,
        ...(field.max !== undefined ? { 'max-length': field.max } : {}),
      };
    case 'date':
      return { type: 'DatePicker', name: field.id, label: field.label, ...required, ...helper };
    case 'dropdown':
      return { type: 'Dropdown', name: field.id, label: field.label, ...required, 'data-source': options(field) };
    case 'radio':
      return { type: 'RadioButtonsGroup', name: field.id, label: field.label, ...required, 'data-source': options(field) };
    case 'checkboxes':
      return {
        type: 'CheckboxGroup',
        name: field.id,
        label: field.label,
        ...required,
        'data-source': options(field),
        ...(field.min !== undefined ? { 'min-selected-items': field.min } : {}),
        ...(field.max !== undefined ? { 'max-selected-items': field.max } : {}),
      };
    case 'opt_in':
      return { type: 'OptIn', name: field.id, label: field.label, ...required };
  }
}

function formRefs(fields: FormField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.id, `\${${FORM_NAME}.${field.id}}`]));
}
function dataRefs(fields: FormField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.id, `\${data.${field.id}}`]));
}

/** Compiles a definition that has already passed validateFormDefinition. */
export function compileFlowJson(definition: FormDefinition, opts: CompileFlowJsonOptions): FlowJson {
  const screens = definition.screens;
  const carried: FormField[] = [];
  const compiled = screens.map((screen, index): FlowScreenJson => {
    const last = index === screens.length - 1;
    const own = screenInputFields(screen);
    let action: Record<string, unknown>;
    if (opts.usesEndpoint) {
      action = { name: 'data_exchange', payload: formRefs(own) };
    } else if (last) {
      action = { name: 'complete', payload: { ...dataRefs(carried), ...formRefs(own) } };
    } else {
      action = {
        name: 'navigate',
        next: { type: 'screen', name: screens[index + 1].id },
        payload: { ...dataRefs(carried), ...formRefs(own) },
      };
    }
    const footer: FlowComponent = { type: 'Footer', label: screen.button_label, 'on-click-action': action };
    const data = !opts.usesEndpoint && carried.length > 0
      ? Object.fromEntries(carried.map((field) => [field.id, dataSchema(field)]))
      : undefined;
    carried.push(...own);
    return {
      id: screen.id,
      title: screen.title,
      ...(last ? { terminal: true as const, success: true as const } : {}),
      ...(data ? { data } : {}),
      layout: {
        type: 'SingleColumnLayout',
        children: [{ type: 'Form', name: FORM_NAME, children: [...screen.fields.map(component), footer] }],
      },
    };
  });

  if (!opts.usesEndpoint) return { version: FLOW_JSON_VERSION, screens: compiled };
  const routing = Object.fromEntries(screens.map((screen, index) =>
    [screen.id, index < screens.length - 1 ? [screens[index + 1].id] : []]));
  return { version: FLOW_JSON_VERSION, data_api_version: FLOW_DATA_API_VERSION, routing_model: routing, screens: compiled };
}
