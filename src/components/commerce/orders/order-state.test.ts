import { describe, expect, it } from "vitest";
import { csvCell, orderRef, toCsv, updateTextKey, withChosenOption } from "./order-state";

describe("updateTextKey and orderRef", () => {
  it("picks the update text and the visible reference", () => {
    expect(updateTextKey("dispatched")).toBe("dispatched");
    expect(updateTextKey("awaiting_payment")).toBe("other");
    expect(orderRef({ id: "abcdef12-0000", external_id: "1042" })).toBe("#1042");
    expect(orderRef({ id: "abcdef12-0000", external_id: null })).toBe("ABCDEF12");
  });
});

describe("CSV export", () => {
  it("quotes cells and neutralises spreadsheet formulas", () => {
    expect(csvCell('Asha "A"')).toBe('"Asha ""A"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("+91 98")).toBe(`"'+91 98"`);
    expect(csvCell(null)).toBe('""');
    expect(toCsv([["a", 1], ["b", 2]])).toBe('"a","1"\r\n"b","2"');
  });
});

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
