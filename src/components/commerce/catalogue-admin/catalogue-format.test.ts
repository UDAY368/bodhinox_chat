import { describe, expect, it } from "vitest";
import { bpsToPercent, moneyInput, moneyText, parseOptionsText, percentToBps, priceRange } from "./catalogue-format";

describe("catalogue form helpers", () => {
  it("turns percent text into basis points and back", () => {
    expect(percentToBps("18")).toBe(1800);
    expect(percentToBps("12.5")).toBe(1250);
    expect(percentToBps("0")).toBe(0);
    expect(percentToBps(" ")).toBeNull();
    expect(percentToBps("100.01")).toBeUndefined();
    expect(percentToBps("-1")).toBeUndefined();
    expect(percentToBps("5.125")).toBeUndefined();
    expect([1800, 1250, 5, 0].map(bpsToPercent)).toEqual(["18", "12.5", "0.05", "0"]);
    expect(bpsToPercent(null)).toBe("");
  });

  it("parses money exactly in the store currency's minor units", () => {
    expect(moneyInput("499.00", "INR")).toBe(49900);
    expect(moneyInput("1,299.5", "INR")).toBe(129950);
    expect(moneyInput("500", "JPY")).toBe(500);
    expect(moneyInput("1.5", "JPY")).toBeUndefined();
    expect(moneyInput("1.234", "KWD")).toBe(1234);
    expect(moneyInput("", "INR")).toBeNull();
    expect(moneyInput("10", null)).toBeUndefined();
    expect(moneyInput("abc", "INR")).toBeUndefined();
    expect(moneyText(49900, "INR")).toBe("499.00");
    expect(moneyText(null, "INR")).toBe("");
    expect(priceRange(19900, 49900, "INR", "en-IN")).toBe("₹199.00 – ₹499.00");
    expect(priceRange(null, null, "INR", "en")).toBeNull();
  });

  it("parses option text into at most four pairs", () => {
    expect(parseOptionsText("Size: M, Colour: Blue")).toEqual({ Size: "M", Colour: "Blue" });
    expect(parseOptionsText("")).toEqual({});
    expect(parseOptionsText("Size M")).toBeNull();
    expect(parseOptionsText("a:1,b:2,c:3,d:4,e:5")).toBeNull();
    expect(parseOptionsText("Size: M, Size: L")).toBeNull();
  });
});
