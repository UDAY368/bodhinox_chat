import { describe, expect, it } from "vitest";
import { emptyFormDefinition, validateFormDefinition } from "@/lib/whatsapp/forms/definition";
import { FORM_FIELD_TYPES, type FormDefinition } from "@/lib/whatsapp/forms/types";
import {
  canAddScreen,
  dropIndexedErrors,
  errorsByPath,
  errorsUnder,
  fieldCapabilities,
  formatAnswer,
  isLockedStatus,
  moveItem,
  newField,
  newOption,
  newScreen,
  optionTitles,
  responseColumns,
  singleFlight,
  unplacedErrors,
  withoutMetaErrors,
} from "./form-editing";

const labels = { title: "Details", field: "Name", button: "Next" };
const fieldLabels = { label: "Q", option: (n: number) => `Choice ${n}` };

describe("form editing helpers", () => {
  it("adds fields with unique ids across screens and starter options for choices", () => {
    let def = emptyFormDefinition(labels);
    const a = newField(def, "short_text", fieldLabels);
    def = { ...def, screens: [{ ...def.screens[0], fields: [...def.screens[0].fields, a] }] };
    const b = newField(def, "short_text", fieldLabels);
    expect([a.id, b.id]).toEqual(["short_text", "short_text_2"]);
    expect(newField(def, "radio", fieldLabels).options).toEqual([
      { id: "option_1", title: "Choice 1" },
      { id: "option_2", title: "Choice 2" },
    ]);
    expect(newField(def, "heading", fieldLabels).required).toBeUndefined();
  });

  it("produces fields the shared validator accepts for every palette type", () => {
    const def = emptyFormDefinition(labels);
    for (const type of FORM_FIELD_TYPES) {
      const field = newField(def, type, { label: "Label", option: (n) => `Choice ${n}` });
      const candidate: FormDefinition = { ...def, screens: [{ ...def.screens[0], fields: [...def.screens[0].fields, field] }] };
      expect(validateFormDefinition(candidate), type).toMatchObject({ ok: true });
    }
  });

  it("offers only the settings the validator allows per type", () => {
    expect(fieldCapabilities("paragraph")).toMatchObject({ required: false, helper: false, saveTo: false, min: false, max: false });
    expect(fieldCapabilities("long_text")).toMatchObject({ helper: true, min: false, max: true, saveTo: true });
    expect(fieldCapabilities("checkboxes")).toMatchObject({ options: true, min: true, max: true, saveTo: false });
    expect(fieldCapabilities("opt_in")).toMatchObject({ required: true, saveTo: false, options: false });
    expect(fieldCapabilities("date")).toMatchObject({ helper: true, saveTo: true, min: false });
  });

  it("numbers new screens and options past existing ids and caps screens at ten", () => {
    let def = emptyFormDefinition(labels);
    expect(newScreen(def, labels).id).toBe("SCREEN_TWO");
    const option = newOption({ id: "q", type: "radio", label: "Q", options: [{ id: "option_2", title: "x" }] }, "New");
    expect(option).toEqual({ id: "option_3", title: "New" });
    for (let i = 0; i < 9; i += 1) def = { ...def, screens: [...def.screens, newScreen(def, labels)] };
    expect(def.screens).toHaveLength(10);
    expect(new Set(def.screens.map((s) => s.id)).size).toBe(10);
    // Meta accepts only letters and underscores in screen ids.
    for (const s of def.screens) expect(s.id).toMatch(/^[A-Z_]+$/);
    expect(canAddScreen(def)).toBe(false);
  });

  it("moves items with clamping and leaves the input untouched", () => {
    const items = ["a", "b", "c"];
    expect(moveItem(items, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(items, 2, 5)).toEqual(["a", "b", "c"]);
    expect(moveItem(items, 1, -3)).toEqual(["b", "a", "c"]);
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("indexes server and local errors by path and finds the ones no input shows", () => {
    const errors = [
      { path: "definition.screens.0.fields.1.label", message: "too long" },
      { path: "screens.0.title", message: "missing" },
      { path: "name", message: "taken" },
      { message: "Meta rejected the flow" },
      { path: "screens", message: "count" },
    ];
    const map = errorsByPath(errors);
    expect(map.get("screens.0.fields.1.label")).toEqual(["too long"]);
    expect(errorsUnder(map, "screens.0")).toEqual(["too long", "missing"]);
    expect(errorsUnder(map, "screens.1")).toEqual([]);
    expect(unplacedErrors(errors)).toEqual(["Meta rejected the flow", "count"]);
  });

  it("locks the builder only for statuses Meta owns", () => {
    expect(isLockedStatus("draft")).toBe(false);
    expect(isLockedStatus("error")).toBe(false);
    expect(isLockedStatus("published")).toBe(true);
    expect(isLockedStatus("deprecated")).toBe(true);
  });

  it("formats answers and builds response columns from questions plus older keys", () => {
    expect(formatAnswer(["a", "b"], "Yes", "No")).toBe("a, b");
    expect(formatAnswer(true, "Yes", "No")).toBe("Yes");
    expect(formatAnswer(undefined, "Yes", "No")).toBe("");
    const def = emptyFormDefinition(labels);
    def.screens[0].fields.unshift({ id: "intro", type: "heading", label: "Hi" });
    const columns = responseColumns(def, [
      { answers: { name: "Ana", old_q: "x" }, labels: { old_q: "Old question" } },
    ]);
    expect(columns).toEqual([
      { key: "name", label: "Name" },
      { key: "old_q", label: "Old question" },
    ]);
  });

  it("shows option titles instead of stored option ids for dropdown and checkbox answers (R10)", () => {
    const def: FormDefinition = {
      version: 1,
      screens: [{
        id: "SCREEN_1",
        title: "T",
        button_label: "Send",
        fields: [
          { id: "colour", type: "dropdown", label: "Colour", options: [{ id: "option_1", title: "Red" }, { id: "option_2", title: "Blue" }] },
          { id: "extras", type: "checkboxes", label: "Extras", options: [{ id: "option_1", title: "Gift wrap" }, { id: "option_2", title: "Card" }] },
          { id: "name", type: "short_text", label: "Name" },
        ],
      }],
    };
    const titles = optionTitles(def);
    expect(formatAnswer("option_2", "Yes", "No", titles.get("colour"))).toBe("Blue");
    expect(formatAnswer(["option_1", "option_2"], "Yes", "No", titles.get("extras"))).toBe("Gift wrap, Card");
    // An option removed since the response was stored still shows its id.
    expect(formatAnswer("option_9", "Yes", "No", titles.get("colour"))).toBe("option_9");
    // Text answers are never mapped, even when they look like an option id.
    expect(titles.get("name")).toBeUndefined();
    expect(formatAnswer("option_1", "Yes", "No", titles.get("name"))).toBe("option_1");
  });

  it("drops index-addressed errors after a structural edit but keeps form-wide ones (R12)", () => {
    const errors = [
      { path: "screens.0.fields.0.label", message: "Label is required" },
      { path: "definition.screens.1.title", message: "Title is required" },
      { path: "name", message: "Name is required" },
      { path: "success_message", message: "Too long" },
      { message: "Meta says no" },
    ];
    expect(dropIndexedErrors(errors).map((e) => e.message)).toEqual(["Name is required", "Too long", "Meta says no"]);
  });

  it("de-duplicates Meta errors once the refreshed form lists them (R14)", () => {
    const echoed = [{ message: "Invalid component" }, { path: "screens.0.title", message: "Invalid component" }, { message: "Other" }];
    const meta = [{ error: "INVALID_PROPERTY", message: "Invalid component" }];
    expect(withoutMetaErrors(echoed, meta)).toEqual([{ path: "screens.0.title", message: "Invalid component" }, { message: "Other" }]);
    expect(withoutMetaErrors(echoed, null)).toEqual(echoed);
  });

  it("runs only one create at a time so a double Enter sends one request (R15)", async () => {
    let calls = 0;
    let release!: () => void;
    const guarded = singleFlight(() => {
      calls += 1;
      return new Promise<string>((resolve) => { release = () => resolve("created"); });
    });
    const first = guarded();
    const second = guarded();
    expect(calls).toBe(1);
    expect(await second).toBeUndefined();
    release();
    expect(await first).toBe("created");
    // Once settled, a later submit (e.g. after an error) runs again.
    const third = guarded();
    expect(calls).toBe(2);
    release();
    await third;
  });

  it("releases the guard when the call fails", async () => {
    let calls = 0;
    const guarded = singleFlight(async () => {
      calls += 1;
      throw new Error("network");
    });
    await expect(guarded()).rejects.toThrow("network");
    await expect(guarded()).rejects.toThrow("network");
    expect(calls).toBe(2);
  });
});
