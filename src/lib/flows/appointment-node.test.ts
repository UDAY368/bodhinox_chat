import { describe, expect, it } from "vitest";
import type { BuilderNode } from "@/components/flows/shared";
import {
  appointmentDaysAhead, appointmentPortFor, appointmentReplyIds, appointmentServiceIds, bookAppointmentEdges, bookAppointmentIssues, bookAppointmentPaidIssues,
  dayLabel, pagedRows, parseAppointmentReply, readAppointmentState, rowTitle, singleListRows, slotDays,
} from "./appointment-node";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from "./edges";
import { choose, startPreview } from "./preview";
import { validateFlowForActivation } from "./validate";

const SVC = "11111111-1111-4111-8111-111111111111";
const LOC = "33333333-3333-4333-8333-333333333333";
const keys = new Set(["ok", "no", "bye"]);
const node = (config: Record<string, unknown>) => ({ node_key: "book", config });
const fields = (config: Record<string, unknown>) => bookAppointmentIssues(node(config), keys).map((i) => i.field);

describe("book_appointment authoring rules", () => {
  it("accepts a minimal step: every service, the success port only", () => {
    expect(bookAppointmentIssues(node({ success_next: "ok" }), keys)).toEqual([]);
    expect(bookAppointmentIssues(node({ service_ids: [SVC], service_mode: "online", location_id: LOC, staff_mode: "choose", days_ahead: 14,
      success_next: "ok", unavailable_next: "no", cancelled_next: "bye" }), keys)).toEqual([]);
  });

  it("requires a known success port and checks the optional ones", () => {
    expect(fields({})).toEqual(["success_next"]);
    expect(fields({ success_next: "gone", unavailable_next: "nope" })).toEqual(["success_next", "unavailable_next"]);
  });

  it("refuses bad services, mode, location, practitioner mode and days", () => {
    expect(fields({ success_next: "ok", service_ids: ["x"] })).toEqual(["service_ids"]);
    expect(fields({ success_next: "ok", service_ids: Array(10).fill(SVC).map((s, i) => s.replace(/1$/, String(i))) })).toEqual(["service_ids"]);
    expect(fields({ success_next: "ok", service_ids: [SVC, SVC] })).toEqual(["service_ids"]);
    expect(fields({ success_next: "ok", service_mode: "hybrid" })).toEqual(["service_mode"]);
    expect(fields({ success_next: "ok", location_id: "somewhere" })).toEqual(["location_id"]);
    expect(fields({ success_next: "ok", staff_mode: "random" })).toEqual(["staff_mode"]);
    for (const days of [0, 15, 2.5, "7"]) expect(fields({ success_next: "ok", days_ahead: days })).toEqual(["days_ahead"]);
  });

  it("reads config defensively", () => {
    expect(appointmentServiceIds({ service_ids: [SVC, "bad", SVC] })).toEqual([SVC]);
    expect(appointmentDaysAhead({})).toBe(7);
    expect(appointmentDaysAhead({ days_ahead: 40 })).toBe(14);
    expect(appointmentPortFor({ success_next: "ok", unavailable_next: "" }, "unavailable")).toBeNull();
    expect(bookAppointmentEdges({ success_next: "ok", cancelled_next: "bye" })).toEqual(["ok", "bye"]);
  });
});

describe("book_appointment replies and state", () => {
  it("round-trips every row id and refuses anything else", () => {
    expect(parseAppointmentReply(appointmentReplyIds.service(SVC))).toEqual({ kind: "service", id: SVC });
    expect(parseAppointmentReply(appointmentReplyIds.anyStaff)).toEqual({ kind: "staff", id: null });
    expect(parseAppointmentReply(appointmentReplyIds.day("2026-11-09"))).toEqual({ kind: "day", day: "2026-11-09" });
    expect(parseAppointmentReply(appointmentReplyIds.slot("2026-11-09T04:30:00.000Z"))).toEqual({ kind: "slot", startAt: new Date("2026-11-09T04:30:00.000Z") });
    expect(parseAppointmentReply(appointmentReplyIds.more)).toEqual({ kind: "more" });
    expect(parseAppointmentReply(appointmentReplyIds.cancel)).toEqual({ kind: "cancel" });
    for (const bad of ["yes", "appt:svc:x", "appt:day:9 Nov", "appt:slot:-1", 42, null]) expect(parseAppointmentReply(bad)).toBeNull();
  });

  it("keeps only well-formed progress", () => {
    expect(readAppointmentState({})).toBeNull();
    expect(readAppointmentState({ _appointment: { stage: "other" } })).toBeNull();
    expect(readAppointmentState({ _appointment: { stage: "slot", service_id: SVC, location_id: "x", staff_id: null, day: "2026-11-09", page: 2, retried: true } }))
      .toEqual({ stage: "slot", service_id: SVC, staff_id: null, day: "2026-11-09", page: 2, retried: true });
  });

  it("never builds more than WhatsApp's ten rows", () => {
    const labels = { more: "More dates", cancel: "Cancel" };
    const items = Array.from({ length: 20 }, (_, i) => i);
    const first = pagedRows(items, 0, (i) => ({ id: String(i), title: String(i) }), labels);
    expect(first).toHaveLength(10);
    expect(first.slice(-2).map((r) => r.id)).toEqual([appointmentReplyIds.more, appointmentReplyIds.cancel]);
    const last = pagedRows(items, 2, (i) => ({ id: String(i), title: String(i) }), labels);
    expect(last.map((r) => r.id)).toEqual(["16", "17", "18", "19", appointmentReplyIds.cancel]);
    expect(pagedRows(items.slice(0, 9), 0, (i) => ({ id: String(i), title: "" }), labels, 9)).toHaveLength(10);
  });

  it("fits titles and labels days without a time-zone shift", () => {
    expect([...rowTitle("A very long practitioner name here")]).toHaveLength(24);
    expect(rowTitle(" Short ")).toBe("Short");
    expect(dayLabel("2026-11-09", "en")).toMatch(/Mon/);
    expect(slotDays([{ localDate: "2026-11-10" }, { localDate: "2026-11-09" }, { localDate: "2026-11-10" }])).toEqual(["2026-11-09", "2026-11-10"]);
  });
});

const flowNodes: BuilderNode[] = [
  { node_key: "start", node_type: "start", config: { next_node_key: "book" } },
  { node_key: "book", node_type: "book_appointment", config: { success_next: "ok", unavailable_next: "no", cancelled_next: "" } },
  { node_key: "ok", node_type: "send_message", config: { text: "See you at {{vars.appointment_local_time}}", next_node_key: "end" } },
  { node_key: "no", node_type: "handoff", config: {} },
  { node_key: "end", node_type: "end", config: {} },
];

describe("book_appointment in the builder", () => {
  it("validates for activation and counts its variables as collected", () => {
    const issues = validateFlowForActivation(
      { name: "Booking", trigger_type: "keyword", trigger_config: { keywords: ["book"] }, entry_node_id: "start" },
      flowNodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config })),
    );
    expect(issues).toEqual([]);
  });

  it("refuses to publish a step that picks a paid service, which a flow cannot charge for (audit #21)", () => {
    const PAID = "55555555-5555-4555-8555-555555555555";
    const withServices = (ids: string[]) => flowNodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type,
      config: n.node_key === "book" ? { ...n.config, service_ids: ids } : n.config }));
    const flow = { name: "Booking", trigger_type: "keyword" as const, trigger_config: { keywords: ["book"] }, entry_node_id: "start" };
    const paidServices = new Set([PAID]);
    expect(validateFlowForActivation(flow, withServices([SVC]), { paidServices })).toEqual([]);
    // Every service (none picked): the runtime offers only the free ones, so this stays publishable.
    expect(validateFlowForActivation(flow, withServices([]), { paidServices })).toEqual([]);
    const issues = validateFlowForActivation(flow, withServices([SVC, PAID.toUpperCase()]), { paidServices });
    expect(issues).toEqual([expect.objectContaining({ severity: "error", node_key: "book", field: "service_ids" })]);
    // The builder has no paid list and checks shape only.
    expect(validateFlowForActivation(flow, withServices([PAID]))).toEqual([]);
    expect(bookAppointmentPaidIssues(node({ service_ids: [PAID] }), new Set())).toEqual([]);
  });

  it("allows a reply timeout", () => {
    const nodes = flowNodes.map((n) => (n.node_key === "book" ? { ...n, config: { ...n.config, timeout_minutes: 30, after_timeout: "no" } } : n));
    const issues = validateFlowForActivation(
      { name: "Booking", trigger_type: "keyword", trigger_config: { keywords: ["book"] }, entry_node_id: "start" },
      nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config })),
    );
    expect(issues).toEqual([]);
  });

  it("draws its ports and edges, connects and unlinks them", () => {
    const book = flowNodes[1];
    expect(outgoingSlots(book).map((s) => s.id)).toEqual(["success", "unavailable", "cancelled"]);
    expect(deriveCanvasEdges(flowNodes).filter((e) => e.source === "book").map((e) => e.sourceHandle).sort()).toEqual(["success", "unavailable"]);
    expect(applyEdgeConnection(book, "success", "end")).toEqual({ success_next: "end" });
    expect(applyEdgeConnection(book, "cancelled", "end")).toEqual({ cancelled_next: "end" });
    expect(applyEdgeConnection(book, "paid", "end")).toBeNull();
    const unlinked = unlinkNodeReferences(flowNodes, "ok").find((n) => n.node_key === "book")!;
    expect(unlinked.config.success_next).toBe("");
    expect(unlinkNodeReferences(flowNodes, "no").find((n) => n.node_key === "book")!.config.unavailable_next).toBe("");
  });

  it("previews as a note with the three outcomes", () => {
    const state = startPreview(flowNodes, "start");
    expect(state.messages.at(-1)).toMatchObject({ from: "system", note: "book_appointment" });
    expect(state.waiting?.options.map((o) => o.id)).toEqual(["success", "unavailable", "cancelled"]);
    const booked = choose(state, "success");
    expect(booked.messages.at(-2)).toMatchObject({ from: "bot", text: "See you at {{vars.appointment_local_time}}" });
    expect(choose(state, "cancelled").ended).toBe(true);
  });
});

describe("singleListRows", () => {
  it("fits nine choices and Cancel in WhatsApp's ten rows without a More row", () => {
    const rows = singleListRows(Array.from({ length: 9 }, (_, i) => i), (i) => ({ id: `r${i}`, title: `R${i}` }), "Cancel");
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.id)).not.toContain(appointmentReplyIds.more);
    expect(rows.at(-1)).toEqual({ id: appointmentReplyIds.cancel, title: "Cancel" });
  });

  it("never exceeds ten rows", () => {
    expect(singleListRows(Array.from({ length: 12 }, (_, i) => i), (i) => ({ id: `r${i}`, title: `R${i}` }), "Cancel")).toHaveLength(10);
  });
});
