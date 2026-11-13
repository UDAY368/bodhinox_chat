import { describe, expect, it } from "vitest";

import { byPrecedence, outsideHoursApplies } from "./triggers";
import { validateFlowForActivation } from "./validate";
import { triggerAvailableOn } from "@/lib/channels/capabilities";

// The automation list's flow triggers: contact_created, tag_added, outside_hours.

const NODES = [
  { node_key: "start", node_type: "start", config: { next_node_key: "hi" } },
  { node_key: "hi", node_type: "send_message", config: { text: "Hello", next_node_key: "" } },
];
const flow = (trigger_type: string, trigger_config: Record<string, unknown>) =>
  ({ name: "Event", trigger_type, trigger_config, entry_node_id: "start" }) as Parameters<typeof validateFlowForActivation>[0];
const triggerErrors = (trigger_type: string, trigger_config: Record<string, unknown>) =>
  validateFlowForActivation(flow(trigger_type, trigger_config), NODES).filter((i) => i.scope === "trigger" && i.severity === "error");

const CLOSED_ALL_WEEK = { timezone: "UTC", working_hours: { mon: [{ start: "09:00", end: "10:00" }] } };
const text = { kind: "text", text: "hello", meta_message_id: "m" } as const;

describe("outsideHoursApplies", () => {
  it("is true for a message while closed and false while open", () => {
    expect(outsideHoursApplies(text, CLOSED_ALL_WEEK, false, new Date("2026-11-11T22:00:00Z"))).toBe(true);
    // Monday 2026-11-09 09:30 UTC is inside the one open range.
    expect(outsideHoursApplies(text, CLOSED_ALL_WEEK, false, new Date("2026-11-09T09:30:00Z"))).toBe(false);
  });

  it("never fires without working hours, for a cart or a form, or for our own postback", () => {
    expect(outsideHoursApplies(text, { timezone: "UTC", working_hours: {} }, false)).toBe(false);
    const night = new Date("2026-11-11T22:00:00Z");
    expect(outsideHoursApplies({ kind: "order" } as never, CLOSED_ALL_WEEK, false, night)).toBe(false);
    expect(outsideHoursApplies({ kind: "form" } as never, CLOSED_ALL_WEEK, false, night)).toBe(false);
    expect(outsideHoursApplies(text, CLOSED_ALL_WEEK, true, night)).toBe(false);
  });
});

describe("event trigger precedence", () => {
  it("ranks contact_created above first_inbound_message, and outside_hours below it but above default_reply", () => {
    const at = "2026-01-01T00:00:00Z";
    const rows = ["default_reply", "outside_hours", "first_inbound_message", "keyword", "contact_created"]
      .map((trigger_type) => ({ trigger_type: trigger_type as never, created_at: at, status: "active" as const }));
    expect(byPrecedence(rows).map((r) => r.trigger_type)).toEqual(["keyword", "contact_created", "first_inbound_message", "outside_hours", "default_reply"]);
  });
});

describe("event trigger validation", () => {
  it("needs a tag id for tag_added", () => {
    expect(triggerErrors("tag_added", {})).toHaveLength(1);
    expect(triggerErrors("tag_added", { tag_id: "not-a-uuid" })).toHaveLength(1);
    expect(triggerErrors("tag_added", { tag_id: "00000000-0000-4000-8000-000000000001" })).toEqual([]);
  });

  it("needs a known frequency for outside_hours, and nothing for contact_created", () => {
    expect(triggerErrors("outside_hours", {})).toHaveLength(1);
    expect(triggerErrors("outside_hours", { frequency: "hourly" })).toHaveLength(1);
    expect(triggerErrors("outside_hours", { frequency: "once_per_24h" })).toEqual([]);
    expect(triggerErrors("contact_created", {})).toEqual([]);
  });

  it("offers all three on both channels", () => {
    for (const trigger of ["contact_created", "tag_added", "outside_hours"] as const) {
      expect(triggerAvailableOn(trigger, "whatsapp")).toBe(true);
      expect(triggerAvailableOn(trigger, "instagram")).toBe(true);
    }
  });
});
