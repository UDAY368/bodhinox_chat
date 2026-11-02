import { describe, expect, it } from "vitest";
import { creatorLabel } from "./creator-label";

describe("creatorLabel", () => {
  it("omits the creator when the roster failed to load", () => {
    expect(creatorLabel(null, "u1")).toBeNull();
  });

  it("names a current member", () => {
    expect(creatorLabel(new Map([["u1", "Asha"]]), "u1")).toEqual({ kind: "name", name: "Asha" });
  });

  it("calls a current member with no visible name a teammate, not a former member", () => {
    expect(creatorLabel(new Map([["u1", ""]]), "u1")).toEqual({ kind: "teammate" });
    expect(creatorLabel(new Map([["u1", "   "]]), "u1")).toEqual({ kind: "teammate" });
  });

  it("calls a creator absent from a loaded roster a former member", () => {
    expect(creatorLabel(new Map([["u2", "Ravi"]]), "u1")).toEqual({ kind: "former" });
    expect(creatorLabel(new Map(), "u1")).toEqual({ kind: "former" });
  });
});
