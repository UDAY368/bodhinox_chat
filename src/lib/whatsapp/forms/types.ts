/**
 * WhatsApp Forms (Meta Flows). A form is authored in our own builder schema
 * (`FormDefinition`), validated by ./definition and compiled to Meta's Flow
 * JSON by ./flow-json. Rows live in `whatsapp_forms`.
 */

export const FORM_FIELD_TYPES = [
  'heading',
  'paragraph',
  'short_text',
  'long_text',
  'email',
  'phone',
  'number',
  'date',
  'dropdown',
  'radio',
  'checkboxes',
  'opt_in',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Display-only fields: they carry text but collect no value. */
export const FORM_TEXT_FIELD_TYPES: readonly FormFieldType[] = ['heading', 'paragraph'];
export const FORM_CHOICE_FIELD_TYPES: readonly FormFieldType[] = ['dropdown', 'radio', 'checkboxes'];

export const FORM_CATEGORIES = [
  'SIGN_UP',
  'SIGN_IN',
  'APPOINTMENT_BOOKING',
  'LEAD_GENERATION',
  'CONTACT_US',
  'CUSTOMER_SUPPORT',
  'SURVEY',
  'OTHER',
] as const;
export type FormCategory = (typeof FORM_CATEGORIES)[number];

export const FORM_STATUSES = ['draft', 'published', 'deprecated', 'blocked', 'throttled', 'error'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export type FormSaveTo =
  | { kind: 'contact_field'; field: 'name' | 'email' | 'company' }
  | { kind: 'custom_field'; field_id: string };

export interface FormFieldOption {
  id: string;
  title: string;
}

export interface FormField {
  /** `[a-z][a-z0-9_]{0,39}`, unique across the whole form. */
  id: string;
  type: FormFieldType;
  /** For heading/paragraph this is the displayed text. */
  label: string;
  required?: boolean;
  helper?: string;
  options?: FormFieldOption[];
  /** Character bounds for text inputs, value bounds for number, selection bounds for checkboxes. */
  min?: number;
  max?: number;
  save_to?: FormSaveTo | null;
}

export interface FormScreen {
  /** `[A-Z][A-Z0-9_]{0,29}`, unique in the form. */
  id: string;
  title: string;
  fields: FormField[];
  button_label: string;
}

export interface FormDefinition {
  version: 1;
  /** 1-10 screens, shown in order. */
  screens: FormScreen[];
  success_message?: string;
}

export interface FormValidationError {
  /** Dotted path into the definition, e.g. `screens.0.fields.2.label`. */
  path: string;
  message: string;
}

/** A Meta validation error as returned by the Flows API (subset we keep). */
export interface FlowValidationError {
  error?: string;
  error_type?: string;
  message?: string;
  line_start?: number;
  line_end?: number;
  column_start?: number;
  column_end?: number;
  pointers?: unknown[];
}

export interface WhatsAppForm {
  id: string;
  account_id: string;
  name: string;
  category: FormCategory;
  definition: FormDefinition;
  flow_json?: Record<string, unknown> | null;
  meta_flow_id?: string | null;
  status: FormStatus;
  validation_errors?: FlowValidationError[] | null;
  preview_url?: string | null;
  uses_endpoint: boolean;
  published_at?: string | null;
  created_at: string;
  updated_at: string;
}
