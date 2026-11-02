import { describe, expect, it } from "vitest";
import { clockValue, compareValues, conditionRules, predicateHolds, ruleHolds } from "./conditions";
import { normalizeCollectedInput } from "./input-validation";
import { parseDateInput } from "./input-formats";

describe("predicateHolds", () => {
  it("keeps the original operators' meaning", () => {
    expect(predicateHolds("present", "")).toBe(false);
    expect(predicateHolds("absent", undefined)).toBe(true);
    expect(predicateHolds("equals", "a", "a")).toBe(true);
    expect(predicateHolds("contains", "abc", "b")).toBe(true);
    expect(predicateHolds("equals", undefined, "")).toBe(false);
  });

  it("compares numbers, dates and clock times, and never strings", () => {
    expect(predicateHolds("gt", "10", "9")).toBe(true); // numerically, not "10" < "9"
    expect(predicateHolds("lte", "2026-01-31", "2026-02-01")).toBe(true);
    expect(predicateHolds("between", "15", "10", "20")).toBe(true);
    expect(predicateHolds("between", "25/12/2026", "2026-12-01", "2026-12-31")).toBe(true);
    expect(predicateHolds("gt", "abc", "1")).toBe(false);
    expect(compareValues("apple", "banana")).toBeNull();
  });

  it("fails every comparison on a missing subject, even not_equals", () => {
    for (const op of ["equals", "not_equals", "contains", "gt", "lt", "between"] as const) {
      expect(predicateHolds(op, undefined, "x", "y")).toBe(false);
    }
  });
});

describe("clock rules", () => {
  // 23:30 in Kolkata is 18:00 UTC.
  const clock = { now: new Date("2026-11-02T18:00:00Z"), timezone: "Asia/Kolkata" };

  it("reads the time and date in the node's timezone", () => {
    expect(clockValue("time", clock)).toBe("23:30");
    expect(clockValue("date", { ...clock, now: new Date("2026-11-02T19:00:00Z") })).toBe("2026-11-03");
  });

  it("handles a window that crosses midnight, end excluded", () => {
    expect(ruleHolds({ subject: "time", subject_key: "", operator: "between", value: "22:00", value2: "06:00" }, undefined, clock)).toBe(true);
    expect(ruleHolds({ subject: "time", subject_key: "", operator: "between", value: "09:00", value2: "23:30" }, undefined, clock)).toBe(false);
  });

  it("compares today's date against a range", () => {
    expect(ruleHolds({ subject: "date", subject_key: "", operator: "between", value: "2026-11-01", value2: "2026-11-30" }, undefined, clock)).toBe(true);
  });
});

it("treats a node saved before rules existed as one rule", () => {
  expect(conditionRules({ subject: "tag", subject_key: "t1", operator: "present", true_next: "a", false_next: "b" }))
    .toEqual([{ subject: "tag", subject_key: "t1", operator: "present", value: undefined, value2: undefined }]);
});

describe("answer formats", () => {
  it("parses real dates only, day first", () => {
    expect(parseDateInput("2026-02-28")).toBe("2026-02-28");
    expect(parseDateInput("05/03/2026")).toBe("2026-03-05");
    expect(parseDateInput("30/02/2026")).toBeNull();
    expect(parseDateInput("tomorrow")).toBeNull();
  });

  it("normalizes numbers, dates and yes/no", async () => {
    expect(await normalizeCollectedInput(" 42 ", { validation: "number" })).toBe("42");
    expect(await normalizeCollectedInput("0", { validation: "number", min: 1 })).toBeNull();
    expect(await normalizeCollectedInput("11", { validation: "number", max: 10 })).toBeNull();
    expect(await normalizeCollectedInput("1e9", { validation: "number" })).toBeNull();
    expect(await normalizeCollectedInput("1.5.2026", { validation: "date" })).toBe("2026-05-01");
    expect(await normalizeCollectedInput("Yes!", { validation: "boolean" })).toBe("true");
    expect(await normalizeCollectedInput("não", { validation: "boolean" })).toBe("false");
    expect(await normalizeCollectedInput("maybe", { validation: "boolean" })).toBeNull();
    expect(await normalizeCollectedInput("anything", {})).toBe("anything");
  });
});

it("matches a day-first date rule against today's date", () => {
  const clock = { now: new Date("2026-12-25T10:00:00Z"), timezone: "UTC" };
  expect(ruleHolds({ subject: "date", subject_key: "", operator: "equals", value: "25/12/2026" }, undefined, clock)).toBe(true);
  expect(ruleHolds({ subject: "date", subject_key: "", operator: "between", value: "20/12/2026", value2: "31/12/2026" }, undefined, clock)).toBe(true);
});
