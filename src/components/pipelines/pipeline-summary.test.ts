import { describe, expect, it } from "vitest";
import { summarizeDeals } from "./pipeline-analytics";

describe("summarizeDeals", () => {
  it("sums open and won values and the win rate of closed deals", () => {
    const s = summarizeDeals([
      { status: "open", value: 100 }, { status: undefined, value: 50 }, { status: "won", value: 300 },
      { status: "won", value: 200 }, { status: "lost", value: 999 },
    ]);
    expect(s).toEqual({ openCount: 2, openValue: 150, wonCount: 2, wonValue: 500, lostCount: 1, winRate: 67 });
  });
  it("has no win rate before any deal closes", () => {
    expect(summarizeDeals([{ status: "open", value: 10 }]).winRate).toBeNull();
  });
});
