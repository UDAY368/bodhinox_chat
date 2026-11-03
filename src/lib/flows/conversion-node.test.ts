import { describe, expect, it } from "vitest";
import { conversionEdges, conversionValue, FLOW_CONVERSION_EVENT_NAMES, isConversionEventName } from "./conversion-node";

describe("conversion_event step", () => {
  it("knows the Conversions API events a flow may report", () => {
    // Purchase comes from payment links and orders (order-keyed id); a flow copy would double count it.
    expect(isConversionEventName("Purchase")).toBe(false);
    expect(FLOW_CONVERSION_EVENT_NAMES).not.toContain("Purchase");
    expect(isConversionEventName("LeadSubmitted")).toBe(true);
    expect(isConversionEventName("OrderCreated")).toBe(false);
    expect(isConversionEventName("purchase")).toBe(false);
    expect(isConversionEventName(undefined)).toBe(false);
  });

  it("has a single next port", () => {
    expect(conversionEdges({ next_node_key: "done" })).toEqual(["done"]);
    expect(conversionEdges({ next_node_key: "" })).toEqual([]);
    expect(conversionEdges({})).toEqual([]);
  });

  it("reads the value from a run variable only when it is a non-negative decimal up to 1e12", () => {
    const vars = { total: "499.00", spaced: " 12.5 ", num: 7, neg: "-1", text: "abc", huge: "1000000000001", exp: "1e3" };
    expect(conversionValue(vars, "total")).toBe(499);
    expect(conversionValue(vars, "spaced")).toBe(12.5);
    expect(conversionValue(vars, "num")).toBe(7);
    expect(conversionValue(vars, "neg")).toBeUndefined();
    expect(conversionValue(vars, "text")).toBeUndefined();
    expect(conversionValue(vars, "huge")).toBeUndefined();
    expect(conversionValue(vars, "exp")).toBeUndefined();
    expect(conversionValue(vars, "missing")).toBeUndefined();
    expect(conversionValue(vars, undefined)).toBeUndefined();
  });
});
