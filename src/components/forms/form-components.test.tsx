import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FORM_FIELD_TYPES, type FormDefinition } from "@/lib/whatsapp/forms/types";

vi.mock("next-intl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-intl")>()),
  useTranslations: () => (key: string) => key,
}));

import { FormPreview } from "./form-preview";
import { FieldEditor } from "./field-editor";
import { errorsByPath } from "./form-editing";

const definition: FormDefinition = {
  version: 1,
  screens: [
    {
      id: "SCREEN_1",
      title: "About you",
      button_label: "Continue",
      fields: FORM_FIELD_TYPES.map((type) => ({
        id: type,
        type,
        label: `Label ${type}`,
        ...(type === "dropdown" || type === "radio" || type === "checkboxes"
          ? { options: [{ id: "a", title: `Pick ${type}` }] }
          : {}),
      })),
    },
    { id: "SCREEN_2", title: "Done", button_label: "Send", fields: [{ id: "x", type: "short_text", label: "X" }] },
  ],
};

describe("form builder components", () => {
  it("renders every field type in the WhatsApp preview with the screen's footer", () => {
    const html = renderToStaticMarkup(
      <FormPreview definition={definition} screenIndex={0} onScreenChange={() => {}} formName="Signup" />,
    );
    for (const type of FORM_FIELD_TYPES) expect(html, type).toContain(`Label ${type}`);
    expect(html).toContain("Pick radio");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Continue");
    expect(html).toContain("About you");
  });

  it("shows server errors next to the matching input and hides edit controls when read-only", () => {
    const field = { id: "email", type: "email" as const, label: "Email", required: true };
    const errors = errorsByPath([{ path: "definition.screens.0.fields.0.label", message: "Label is too long" }]);
    const editable = renderToStaticMarkup(
      <FieldEditor
        field={field}
        path="screens.0.fields.0"
        errors={errors}
        readOnly={false}
        customFields={[{ id: "11111111-1111-4111-8111-111111111111", field_name: "Plan" }]}
        isFirst
        isLast
        onChange={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
      />,
    );
    expect(editable).toContain("Label is too long");
    expect(editable).toContain('aria-invalid="true"');
    expect(editable).toContain("removeField");
    expect(editable).toContain("custom:11111111-1111-4111-8111-111111111111");

    const locked = renderToStaticMarkup(
      <FieldEditor
        field={field}
        path="screens.0.fields.0"
        errors={new Map()}
        readOnly
        customFields={[]}
        isFirst
        isLast
        onChange={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
      />,
    );
    expect(locked).not.toContain("removeField");
    expect(locked).toContain("readOnly");
  });

  it("lists id errors on display fields, which have no ID input (R13)", () => {
    const heading = { id: "heading", type: "heading" as const, label: "Welcome" };
    const errors = errorsByPath([{ path: "screens.1.fields.0.id", message: 'Field ID "heading" is already used' }]);
    const html = renderToStaticMarkup(
      <FieldEditor
        field={heading}
        path="screens.1.fields.0"
        errors={errors}
        readOnly={false}
        customFields={[]}
        isFirst
        isLast
        onChange={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
      />,
    );
    expect(html).toContain("Field ID &quot;heading&quot; is already used");
    // The message appears once (no hidden ID input also rendering it).
    expect(html.split("is already used").length - 1).toBe(1);
  });
});
