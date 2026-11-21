import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OptionSelect, type SelectOption } from "./option-select";

const options: SelectOption[] = [
  { value: "", label: "Any status" },
  { value: "open", label: "Open" },
  { value: "vip", label: "VIP customers", group: "Segments" },
];

const render = (props: Partial<React.ComponentProps<typeof OptionSelect>> = {}) =>
  renderToStaticMarkup(<OptionSelect value="open" onValueChange={() => {}} options={options} aria-label="Status" {...props} />);

describe("OptionSelect", () => {
  it("shows the picked option's label in the trigger, never the raw value", () => {
    const html = render({ value: "vip" });
    expect(html).toContain("VIP customers");
    expect(html).not.toMatch(/>vip</);
  });

  it("treats an empty-string option as a real choice, not as nothing picked", () => {
    const html = render({ value: "", placeholder: "Pick one" });
    expect(html).toContain("Any status");
    expect(html).not.toContain("Pick one");
  });

  it("shows the placeholder for a value that is not an option", () => {
    expect(render({ value: "gone", placeholder: "Pick one" })).toContain("Pick one");
  });

  it("marks the trigger invalid only when asked", () => {
    expect(render({ invalid: true })).toContain('aria-invalid="true"');
    expect(render()).not.toContain('aria-invalid="');
  });

  it("fills its container unless fit is set", () => {
    expect(render()).toMatch(/ w-full/);
    const fit = render({ fit: true });
    expect(fit).toContain(" max-w-full");
    expect(fit).not.toMatch(/ w-full/);
  });
});
