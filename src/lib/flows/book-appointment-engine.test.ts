import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

const SVC_A = "11111111-1111-4111-8111-111111111111";
const SVC_B = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const APPT = "44444444-4444-4444-8444-444444444444";

const slot = (localDate: string, hhmm: string, iso: string) => ({ startAt: iso, endAt: iso, localDate, hhmm, staffIds: [], remaining: 1 });

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  dispatches: new Map<string, Promise<unknown>>(),
  keys: [] as string[],
  sendText: vi.fn<(args: { text: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.text" })),
  sendList: vi.fn<(args: { bodyText: string; sections: Array<{ rows: Array<{ id: string; title: string }> }> }) => Promise<{ whatsapp_message_id: string }>>(
    async () => ({ whatsapp_message_id: "wamid.list" })),
  services: vi.fn(),
  location: vi.fn(),
  staff: vi.fn(),
  slots: vi.fn(),
  book: vi.fn(),
  paidOnly: vi.fn(),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false }));
vi.mock("@/lib/jobs/dispatch", () => ({
  dispatchOnce: async (_a: string, key: string, send: () => Promise<unknown>) => {
    h.keys.push(key);
    if (!h.dispatches.has(key)) h.dispatches.set(key, send());
    return h.dispatches.get(key);
  },
}));
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: async () => "job" }));
vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { databaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});
vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: h.sendList,
}));
vi.mock("./appointment-runtime", () => ({
  appointmentServices: h.services,
  appointmentLocation: h.location,
  appointmentStaff: h.staff,
  appointmentSlots: h.slots,
  bookFlowAppointment: h.book,
  appointmentPaidOnly: h.paidOnly,
}));

import { dispatchInboundToFlows, handleFlowTimer } from "./engine";
import { appointmentReplyIds } from "./appointment-node";
import type { ParsedInbound } from "./types";

const PORTS = { success_next: "thanks", unavailable_next: "sorry", cancelled_next: "bye" };

function setup(config: Record<string, unknown> = PORTS) {
  h.tables = {
    flows: [{ id: "f1", status: "active", created_at: "2026-01-01T00:00:00Z", account_id: "acct-1", user_id: "u-1",
      fallback_policy: {}, entry_node_id: "start", test_numbers: [], trigger_type: "keyword", trigger_config: { keywords: ["book"] } }],
    flow_nodes: [
      { flow_id: "f1", node_key: "start", node_type: "start", config: { next_node_key: "book" } },
      { flow_id: "f1", node_key: "book", node_type: "book_appointment", config },
      { flow_id: "f1", node_key: "thanks", node_type: "send_message", config: { text: "Booked for {{vars.appointment_local_time}}", next_node_key: "done" } },
      { flow_id: "f1", node_key: "sorry", node_type: "send_message", config: { text: "Sorry", next_node_key: "done" } },
      { flow_id: "f1", node_key: "bye", node_type: "send_message", config: { text: "Bye", next_node_key: "done" } },
      { flow_id: "f1", node_key: "done", node_type: "end", config: {} },
    ],
    flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone: "15551234567" }],
  };
}

let inbound = 0;
const dispatch = (message: ParsedInbound) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message, isFirstInboundMessage: false,
});
const start = () => dispatch({ kind: "text", text: "book", meta_message_id: `wamid.in.${++inbound}` });
const tap = (replyId: string) => dispatch({ kind: "interactive_reply", reply_id: replyId, reply_title: "x", meta_message_id: `wamid.in.${++inbound}` });
const run = () => h.tables.flow_runs[0] as Record<string, unknown> & { vars: Record<string, unknown> };
const lastList = () => h.sendList.mock.calls.at(-1)![0];
const rowIds = () => lastList().sections[0].rows.map((r) => r.id);
const events = (type: string) => h.tables.flow_run_events.filter((e) => e.event_type === type);

const MON = slot("2026-11-09", "10:00", "2026-11-09T04:30:00.000Z");
const MON2 = slot("2026-11-09", "10:30", "2026-11-09T05:00:00.000Z");
const TUE = slot("2026-11-10", "09:00", "2026-11-10T03:30:00.000Z");

beforeEach(() => {
  h.dispatches.clear();
  h.keys.length = 0;
  for (const fn of [h.sendText, h.sendList, h.services, h.location, h.staff, h.slots, h.book, h.paidOnly]) fn.mockReset();
  h.paidOnly.mockResolvedValue(false);
  h.sendText.mockImplementation(async () => ({ whatsapp_message_id: "wamid.text" }));
  h.sendList.mockImplementation(async () => ({ whatsapp_message_id: "wamid.list" }));
  h.services.mockResolvedValue([{ id: SVC_A, name: "General consultation" }, { id: SVC_B, name: "Dental" }]);
  h.location.mockResolvedValue(LOC);
  h.staff.mockResolvedValue([]);
  h.slots.mockImplementation(async (_acct: string, input: { fromDay?: string }) =>
    input.fromDay ? [MON, MON2, TUE].filter((s) => s.localDate === input.fromDay) : [MON, MON2, TUE]);
  h.book.mockResolvedValue({ ok: true, appointmentId: APPT, localTime: "2026-11-09 10:00", replayed: false });
  setup();
});

describe("book_appointment step", () => {
  it("walks service, day and time, each question its own outbound intent, then books and continues on success", async () => {
    expect((await start()).outcome).toBe("started");
    expect(rowIds()).toEqual([appointmentReplyIds.service(SVC_A), appointmentReplyIds.service(SVC_B), appointmentReplyIds.cancel]);
    expect(run().current_node_key).toBe("book");

    await tap(appointmentReplyIds.service(SVC_B));
    expect(rowIds()).toEqual([appointmentReplyIds.day("2026-11-09"), appointmentReplyIds.day("2026-11-10"), appointmentReplyIds.cancel]);
    await tap(appointmentReplyIds.day("2026-11-09"));
    expect(rowIds()).toEqual([appointmentReplyIds.slot(MON.startAt), appointmentReplyIds.slot(MON2.startAt), appointmentReplyIds.cancel]);
    expect(lastList().sections[0].rows[0].title).toBe("10:00");
    const seq = run().transition_seq as number;

    const result = await tap(appointmentReplyIds.slot(MON.startAt));
    expect(result.consumed).toBe(true);
    expect(h.book).toHaveBeenCalledWith("acct-1", expect.objectContaining({
      runId: run().id, nodeKey: "book", transitionSeq: seq, contactId: "ct-1", serviceId: SVC_B, locationId: LOC, staffId: null,
      startAt: new Date(MON.startAt),
    }));
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Booked for 2026-11-09 10:00"]);
    expect(run().status).toBe("completed");
    // Ids and local time only: no progress state, no manage link.
    expect(run().vars).toEqual({ appointment_id: APPT, appointment_local_time: "2026-11-09 10:00" });
    const prompts = h.keys.filter((k) => k.includes(":book:"));
    expect(new Set(prompts).size).toBe(3);
    for (const k of prompts) expect(k).toMatch(/^flow:.+:book:\d+:0$/);
  });

  it("skips the service question when only one service is offered", async () => {
    h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
    await start();
    expect(rowIds()[0]).toBe(appointmentReplyIds.day("2026-11-09"));
    expect((run().vars._appointment as Record<string, unknown>)).toMatchObject({ stage: "day", service_id: SVC_A, location_id: LOC, staff_id: null });
  });

  it("asks for the practitioner when the customer chooses", async () => {
    setup({ ...PORTS, staff_mode: "choose" });
    h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
    const doc = "55555555-5555-4555-8555-555555555555";
    h.staff.mockResolvedValue([{ id: doc, name: "Dr Rao" }, { id: "66666666-6666-4666-8666-666666666666", name: "Dr Iyer" }]);
    await start();
    expect(rowIds()).toEqual([appointmentReplyIds.anyStaff, appointmentReplyIds.staff(doc), appointmentReplyIds.staff("66666666-6666-4666-8666-666666666666"), appointmentReplyIds.cancel]);
    await tap(appointmentReplyIds.staff(doc));
    expect(h.slots).toHaveBeenLastCalledWith("acct-1", expect.objectContaining({ staffId: doc }));
    await tap(appointmentReplyIds.day("2026-11-10"));
    await tap(appointmentReplyIds.slot(TUE.startAt));
    expect(h.book).toHaveBeenCalledWith("acct-1", expect.objectContaining({ staffId: doc }));
  });

  it("takes the unavailable port at once when nothing can be booked", async () => {
    h.services.mockResolvedValue([]);
    await start();
    expect(h.sendList).not.toHaveBeenCalled();
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(events("error").map((e) => (e.payload as { reason: string }).reason)).toContain("appointment_no_slots");
  });

  it("says the services are paid-only rather than out of slots when that is why nothing is offered (audit #21)", async () => {
    h.services.mockResolvedValue([]);
    h.paidOnly.mockResolvedValue(true);
    await start();
    expect(h.paidOnly).toHaveBeenCalledWith("acct-1", PORTS);
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    const reasons = events("error").map((e) => (e.payload as { reason: string }).reason);
    expect(reasons).toContain("appointment_paid_only");
    expect(reasons).not.toContain("appointment_no_slots");
  });

  it("ends the run when the unavailable port is unwired", async () => {
    setup({ success_next: "thanks" });
    h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
    h.slots.mockResolvedValue([]);
    await start();
    expect(run().status).toBe("completed");
    expect(run().end_reason).toBe("appointment_unavailable");
  });

  it("re-offers that day once when the slot was just taken, then gives up", async () => {
    h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
    h.book.mockResolvedValue({ ok: false, code: "slot_unavailable" });
    await start();
    await tap(appointmentReplyIds.day("2026-11-09"));
    await tap(appointmentReplyIds.slot(MON.startAt));
    expect(lastList().bodyText).toContain("\n\n");
    expect(rowIds()[0]).toBe(appointmentReplyIds.slot(MON.startAt));
    // A new transition, so the second tap books under a new source_ref.
    const firstSeq = h.book.mock.calls[0][1].transitionSeq;
    await tap(appointmentReplyIds.slot(MON2.startAt));
    expect(h.book.mock.calls[1][1].transitionSeq).toBe(firstSeq + 1);
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(events("error").map((e) => (e.payload as { reason: string }).reason)).toEqual(["appointment_slot_unavailable", "appointment_slot_unavailable"]);
  });

  it("takes the unavailable port on a customer conflict without re-offering", async () => {
    h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
    h.book.mockResolvedValue({ ok: false, code: "customer_conflict" });
    await start();
    await tap(appointmentReplyIds.day("2026-11-09"));
    await tap(appointmentReplyIds.slot(MON.startAt));
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(run().vars._appointment).toBeUndefined();
  });

  it("re-prompts an off-script reply twice as distinct intents, then takes the unavailable port", async () => {
    await start();
    await dispatch({ kind: "text", text: "tomorrow?", meta_message_id: "wamid.x1" });
    await tap(appointmentReplyIds.day("2026-11-09")); // a day tap while the service is asked
    expect(h.sendList).toHaveBeenCalledTimes(3);
    const keys = h.keys.filter((k) => k.includes(":book:"));
    expect(keys.map((k) => k.split(":").at(-1))).toEqual(["0", "1", "2"]);
    expect(run().current_node_key).toBe("book");
    await dispatch({ kind: "text", text: "??", meta_message_id: "wamid.x3" });
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(events("input_invalid")).toHaveLength(3);
    // Customer text is never logged.
    expect(JSON.stringify(h.tables.flow_run_events)).not.toContain("tomorrow");
  });

  it("follows the cancelled port when the customer taps Cancel", async () => {
    await start();
    await tap(appointmentReplyIds.cancel);
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Bye"]);
    expect(h.book).not.toHaveBeenCalled();
  });

  it("pages days with More", async () => {
    h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
    const many = Array.from({ length: 10 }, (_, i) => slot(`2026-11-${String(10 + i).padStart(2, "0")}`, "09:00", `2026-11-${String(10 + i).padStart(2, "0")}T03:30:00.000Z`));
    h.slots.mockResolvedValue(many);
    await start();
    expect(rowIds()).toHaveLength(10);
    expect(rowIds().slice(-2)).toEqual([appointmentReplyIds.more, appointmentReplyIds.cancel]);
    await tap(appointmentReplyIds.more);
    expect(rowIds()).toEqual([appointmentReplyIds.day("2026-11-18"), appointmentReplyIds.day("2026-11-19"), appointmentReplyIds.cancel]);
  });

  it("ignores a stale tap from an earlier list after the run moved on", async () => {
    await start();
    await tap(appointmentReplyIds.service(SVC_A));
    await tap(appointmentReplyIds.service(SVC_B)); // the old service list again
    expect(events("input_invalid")).toHaveLength(1);
    expect((run().vars._appointment as Record<string, unknown>).service_id).toBe(SVC_A);
  });

  it("lists nine services and Cancel in one list, with no More row, and books the ninth", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}-0000-4000-8000-00000000000${i}`, name: `Service ${i + 1}` }));
    h.services.mockResolvedValue(nine);
    await start();
    expect(rowIds()).toEqual([...nine.map((s) => appointmentReplyIds.service(s.id)), appointmentReplyIds.cancel]);
    expect(rowIds()).not.toContain(appointmentReplyIds.more);
    await tap(appointmentReplyIds.service(nine[8].id));
    expect(events("input_invalid")).toHaveLength(0);
    expect((run().vars._appointment as Record<string, unknown>)).toMatchObject({ stage: "day", service_id: nine[8].id });
  });

  it("drops the step's progress from run vars when the reply timeout fires", async () => {
    setup({ ...PORTS, timeout_minutes: 30, after_timeout: "sorry" });
    await start();
    await tap(appointmentReplyIds.service(SVC_A));
    expect(run().vars._appointment).toBeDefined();
    const seq = run().transition_seq as number;
    expect(await handleFlowTimer({ accountId: "acct-1", runId: String(run().id), nodeKey: "book", seq, kind: "timeout" })).toBe("fired");
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(run().vars).not.toHaveProperty("_appointment");
    expect(events("timeout")).toHaveLength(1);
  });

  describe("a retried inbound job for a time tap", () => {
    const reachTimeQuestion = async () => {
      h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
      await start();
      await tap(appointmentReplyIds.day("2026-11-09"));
      expect((run().vars._appointment as Record<string, unknown>).stage).toBe("slot");
    };
    // What the first worker left behind when it stopped after recording the tap
    // (and possibly after the booking committed) but before the step moved on.
    const recordTap = (metaMessageId: string, transitionSeq: unknown) => h.tables.flow_run_events.push({
      flow_run_id: run().id, event_type: "reply_received", node_key: "book",
      payload: { meta_message_id: metaMessageId, reply_kind: "interactive_reply", reply_id: appointmentReplyIds.slot(MON.startAt), text_length: null, transition_seq: transitionSeq },
    });
    const retry = (metaMessageId: string) => dispatch({ kind: "interactive_reply", reply_id: appointmentReplyIds.slot(MON.startAt), reply_title: "10:00", meta_message_id: metaMessageId });

    it("finishes through the success port with the replayed booking", async () => {
      await reachTimeQuestion();
      const seq = run().transition_seq as number;
      recordTap("wamid.crashed", seq);
      h.book.mockResolvedValue({ ok: true, appointmentId: APPT, localTime: "2026-11-09 10:00", replayed: true });
      const result = await retry("wamid.crashed");
      expect(result.outcome).not.toBe("duplicate_inbound_ignored");
      expect(h.book).toHaveBeenCalledTimes(1);
      expect(h.book).toHaveBeenCalledWith("acct-1", expect.objectContaining({ runId: run().id, nodeKey: "book", transitionSeq: seq }));
      expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Booked for 2026-11-09 10:00"]);
      expect(run().vars).toEqual({ appointment_id: APPT, appointment_local_time: "2026-11-09 10:00" });
      // The tap is not recorded twice.
      expect(events("reply_received").filter((e) => (e.payload as { meta_message_id: string }).meta_message_id === "wamid.crashed")).toHaveLength(1);
    });

    it("stays ignored when the tap was recorded at an earlier transition", async () => {
      await reachTimeQuestion();
      recordTap("wamid.old", (run().transition_seq as number) - 1);
      expect((await retry("wamid.old")).outcome).toBe("duplicate_inbound_ignored");
      expect(h.book).not.toHaveBeenCalled();
    });

    it("stays ignored for a tap recorded before transitions were recorded", async () => {
      await reachTimeQuestion();
      recordTap("wamid.legacy", undefined);
      expect((await retry("wamid.legacy")).outcome).toBe("duplicate_inbound_ignored");
      expect(h.book).not.toHaveBeenCalled();
    });

    it("records the transition on every reply it receives", async () => {
      await reachTimeQuestion();
      const seq = run().transition_seq as number;
      await tap(appointmentReplyIds.slot(MON.startAt));
      expect((events("reply_received").at(-1)!.payload as { transition_seq: number }).transition_seq).toBe(seq);
    });
  });

  it("takes the unavailable port when the booking fails outright", async () => {
    h.services.mockResolvedValue([{ id: SVC_A, name: "Consultation" }]);
    h.book.mockRejectedValue(new Error("db down"));
    await start();
    await tap(appointmentReplyIds.day("2026-11-09"));
    await tap(appointmentReplyIds.slot(MON.startAt));
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(events("error").map((e) => (e.payload as { reason: string }).reason)).toEqual(["appointment_lookup_failed"]);
  });

  it("takes the unavailable port when a lookup fails outright", async () => {
    await start();
    h.slots.mockRejectedValue(new Error("db down"));
    await tap(appointmentReplyIds.service(SVC_A));
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(JSON.stringify(events("error"))).not.toContain("db down");
  });
});
