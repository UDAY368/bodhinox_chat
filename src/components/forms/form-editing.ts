// Pure helpers behind the WhatsApp form builder. Kept free of React so the
// id generation, reordering and error lookup rules are unit-tested directly.

import { FORM_LIMITS, isInputField } from "@/lib/whatsapp/forms/definition";
import type {
  FormDefinition,
  FormField,
  FormFieldType,
  FormScreen,
  FormStatus,
  FormValidationError,
  FlowValidationError,
} from "@/lib/whatsapp/forms/types";

/** Statuses Meta owns: the uploaded flow is fixed, so the builder is read-only. */
const LOCKED_STATUSES: readonly FormStatus[] = ["published", "deprecated", "blocked", "throttled"];

export function isLockedStatus(status: FormStatus): boolean {
  return LOCKED_STATUSES.includes(status);
}

/** Which optional settings the field editor offers for a type (mirrors the validator). */
export function fieldCapabilities(type: FormFieldType) {
  const textInput = type === "short_text" || type === "email" || type === "phone" || type === "number";
  return {
    required: isInputField(type),
    helper: textInput || type === "long_text" || type === "date",
    options: type === "dropdown" || type === "radio" || type === "checkboxes",
    min: textInput || type === "checkboxes",
    max: textInput || type === "long_text" || type === "checkboxes",
    saveTo: isInputField(type) && type !== "checkboxes" && type !== "opt_in",
  };
}

function allFieldIds(definition: FormDefinition): Set<string> {
  return new Set(definition.screens.flatMap((s) => s.fields.map((f) => f.id)));
}

/** `base`, `base_2`, `base_3`, ... — the first one not in `taken`. */
function uniqueId(base: string, taken: Set<string>, maxLength: number): string {
  const root = base.slice(0, maxLength);
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A new field of `type` with an id unique across the form and starter options for choice types. */
export function newField(
  definition: FormDefinition,
  type: FormFieldType,
  labels: { label: string; option: (n: number) => string },
): FormField {
  const field: FormField = { id: uniqueId(type, allFieldIds(definition), 40), type, label: labels.label };
  if (isInputField(type)) field.required = false;
  if (fieldCapabilities(type).options) {
    field.options = [1, 2].map((n) => ({ id: `option_${n}`, title: labels.option(n) }));
  }
  return field;
}

export function newOption(field: FormField, title: string): { id: string; title: string } {
  const taken = new Set((field.options ?? []).map((o) => o.id));
  let n = (field.options?.length ?? 0) + 1;
  while (taken.has(`option_${n}`)) n += 1;
  return { id: `option_${n}`, title };
}

export function newScreen(
  definition: FormDefinition,
  labels: { title: string; button: string },
): FormScreen {
  const taken = new Set(definition.screens.map((s) => s.id));
  let n = definition.screens.length + 1;
  while (taken.has(`SCREEN_${n}`)) n += 1;
  return { id: `SCREEN_${n}`, title: labels.title, fields: [], button_label: labels.button };
}

export function canAddScreen(definition: FormDefinition): boolean {
  return definition.screens.length < FORM_LIMITS.maxScreens;
}

/** Returns a copy of `items` with the element at `from` moved to `to` (clamped). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/**
 * Indexes errors by their dotted path. Server errors may be rooted at the
 * request body (`definition.screens.0...`); those are re-rooted so the
 * builder looks every error up the same way.
 */
export function errorsByPath(errors: readonly { path?: string; message: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const error of errors) {
    const path = (error.path ?? "").replace(/^definition\.?/, "");
    map.set(path, [...(map.get(path) ?? []), error.message]);
  }
  return map;
}

/** Messages for `path` and everything below it (`screens.0` covers its fields). */
export function errorsUnder(map: Map<string, string[]>, path: string): string[] {
  const out: string[] = [];
  for (const [key, messages] of map) {
    if (key === path || key.startsWith(`${path}.`)) out.push(...messages);
  }
  return out;
}

/** Errors that no builder input shows inline (unknown paths, form-wide rules). */
export function unplacedErrors(errors: readonly FormValidationError[] | readonly { path?: string; message: string }[]): string[] {
  return errors
    .filter((e) => {
      const path = (e.path ?? "").replace(/^definition\.?/, "");
      return !/^screens\.\d+/.test(path) && path !== "success_message" && path !== "name" && path !== "category";
    })
    .map((e) => e.message);
}

/** Display text for Meta's Flow JSON validation errors (they carry no builder path). */
export function metaErrorMessages(errors: readonly FlowValidationError[] | null | undefined): string[] {
  return (errors ?? []).map((e) => e.message || e.error || e.error_type || "").filter(Boolean);
}

/**
 * After a rejected publish the refreshed form lists Meta's errors itself, so
 * the same errors echoed in the 422 body are dropped from the builder errors
 * to avoid showing each one twice. Path-addressed (our validator) errors stay.
 */
export function withoutMetaErrors<T extends { path?: string }>(
  errors: readonly T[],
  meta: readonly FlowValidationError[] | null | undefined,
): T[] {
  const shown = new Set(metaErrorMessages(meta));
  if (shown.size === 0) return [...errors];
  return errors.filter((e) => e.path || !metaErrorMessages([e as FlowValidationError]).some((m) => shown.has(m)));
}

/**
 * Errors addressed by screen/field index (`screens.N...`) point at the wrong
 * input once screens or fields are removed or reordered, so a structural edit
 * drops them; form-wide errors (name, category, success message) stay.
 */
export function dropIndexedErrors<T extends { path?: string }>(errors: readonly T[]): T[] {
  return errors.filter((e) => !/^screens\.\d+/.test((e.path ?? "").replace(/^definition\.?/, "")));
}

/**
 * Lets one async call run at a time: calls made while one is pending resolve
 * to undefined without running. Guards submit handlers that a double Enter or
 * double click could fire twice before React re-renders the disabled state.
 */
export function singleFlight<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  let pending = false;
  return async (...args: A): Promise<R | undefined> => {
    if (pending) return undefined;
    pending = true;
    try {
      return await fn(...args);
    } finally {
      pending = false;
    }
  };
}

/** Option id -> title per choice field, so stored option ids read as their titles. */
export function optionTitles(definition: FormDefinition): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  for (const field of definition.screens.flatMap((s) => s.fields)) {
    if (field.options?.length) map.set(field.id, new Map(field.options.map((o) => [o.id, o.title])));
  }
  return map;
}

/**
 * Renders one stored answer as plain text for the responses table. Choice
 * answers are stored as option ids; `titles` (from optionTitles) maps them to
 * the option titles, and ids the form no longer has are shown as stored.
 */
export function formatAnswer(value: unknown, yes: string, no: string, titles?: Map<string, string>): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? yes : no;
  if (Array.isArray(value)) return value.map((v) => formatAnswer(v, yes, no, titles)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return titles?.get(String(value)) ?? String(value);
}

/** Response columns: the form's current questions first, then keys only older responses carry. */
export function responseColumns(
  definition: FormDefinition,
  responses: readonly { answers: Record<string, unknown>; labels: Record<string, string> }[],
): { key: string; label: string }[] {
  const columns = definition.screens
    .flatMap((s) => s.fields)
    .filter((f) => isInputField(f.type))
    .map((f) => ({ key: f.id, label: f.label }));
  const seen = new Set(columns.map((c) => c.key));
  for (const response of responses) {
    for (const key of Object.keys(response.answers)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push({ key, label: response.labels[key] ?? key });
    }
  }
  return columns;
}
