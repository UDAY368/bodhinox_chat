import { describe, expect, it } from "vitest";
import { withChosenOption } from "./customer-options";

describe("withChosenOption", () => {
  const a = { id: "a", name: "Ann" }, b = { id: "b", name: "Bo" };
  it("keeps the chosen customer when a new search drops them", () => {
    expect(withChosenOption([b], a)).toEqual([a, b]);
  });
  it("does not duplicate a chosen customer still in the results, and adds nothing without a choice", () => {
    expect(withChosenOption([a, b], a)).toEqual([a, b]);
    expect(withChosenOption([b], null)).toEqual([b]);
  });
});
