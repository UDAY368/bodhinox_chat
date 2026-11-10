import { describe, it, expect, vi } from "vitest";
import {
  appendNode,
  applyNodePositions,
  defaultConfigFor,
  defaultSection,
  nodeTypesForScope,
  publishDraft,
  triggerTypesForScope,
  uniqueNodeKey,
} from "./flow-editor-state";
import { ADD_NODE_TYPES } from "./shared";
import { INSTAGRAM_ONLY_NODE_TYPES } from "@/lib/flows/types";
import type { BuilderState } from "./flow-editor-state";
import { aiReplyIssues } from "@/lib/flows/ai-reply-node";
import { resolveFallbackPolicy } from "@/lib/flows/fallback";
import type { BuilderNode, NodeType } from "./shared";

describe("uniqueNodeKey", () => {
  it("returns the base key when it isn't taken", () => {
    expect(uniqueNodeKey("menu", [])).toBe("menu");
    expect(
      uniqueNodeKey("menu", [
        { node_key: "other", node_type: "end", config: {} },
      ]),
    ).toBe("menu");
  });

  it("appends _2 when the base is taken", () => {
    expect(
      uniqueNodeKey("menu", [
        { node_key: "menu", node_type: "end", config: {} },
      ]),
    ).toBe("menu_2");
  });

  it("walks forward until it finds an unused suffix", () => {
    const existing: BuilderNode[] = [
      { node_key: "menu", node_type: "end", config: {} },
      { node_key: "menu_2", node_type: "end", config: {} },
      { node_key: "menu_3", node_type: "end", config: {} },
    ];
    expect(uniqueNodeKey("menu", existing)).toBe("menu_4");
  });
});

describe("applyNodePositions", () => {
  it("rounds and applies positions without changing unrelated nodes", () => {
    const nodes: BuilderNode[] = [
      {
        node_key: "start",
        node_type: "start",
        config: {},
        position_x: 0,
        position_y: 0,
      },
      {
        node_key: "message",
        node_type: "send_message",
        config: {},
        position_x: 10,
        position_y: 20,
      },
    ];

    expect(
      applyNodePositions(nodes, {
        start: { x: 10.4, y: 20.6 },
      }),
    ).toEqual([
      {
        node_key: "start",
        node_type: "start",
        config: {},
        position_x: 10,
        position_y: 21,
      },
      {
        node_key: "message",
        node_type: "send_message",
        config: {},
        position_x: 10,
        position_y: 20,
      },
    ]);
  });
});

describe("defaultConfigFor", () => {
  // The hook's addNode and the validator both depend on these defaults
  // being self-consistent. A broken default would surface as a
  // validation error on a freshly-added node, which is exactly what
  // these snapshots guard against.
  const types: NodeType[] = [
    "start",
    "send_message",
    "send_buttons",
    "send_list",
    "send_media",
    "collect_input",
    "condition",
    "set_tag",
    "handoff",
    "end",
  ];

  it("returns an object for every known node type", () => {
    for (const t of types) {
      expect(typeof defaultConfigFor(t)).toBe("object");
    }
  });

  it("send_buttons default has at least one button row", () => {
    const cfg = defaultConfigFor("send_buttons") as {
      buttons?: Array<{ reply_id: string; title: string }>;
    };
    expect(cfg.buttons?.length).toBeGreaterThan(0);
    expect(cfg.buttons?.[0].reply_id).toBeTruthy();
  });

  it("send_list default has at least one section with one row", () => {
    const cfg = defaultConfigFor("send_list") as {
      sections?: Array<{ rows: unknown[] }>;
    };
    expect(cfg.sections?.length).toBeGreaterThan(0);
    expect(cfg.sections?.[0].rows.length).toBeGreaterThan(0);
  });

  it("send_media defaults to image (the most common case)", () => {
    const cfg = defaultConfigFor("send_media") as { media_type?: string };
    expect(cfg.media_type).toBe("image");
  });

  it("collect_input ships a valid var_key that passes the validator regex", () => {
    const cfg = defaultConfigFor("collect_input") as { var_key?: string };
    // Mirrors the regex in validate.ts: alphanumeric + underscore,
    // starts with letter or underscore.
    expect(cfg.var_key).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  });

  it("ai_reply's default has empty ports, knowledge on and one turn, with no validation issues", () => {
    const cfg = defaultConfigFor("ai_reply");
    expect(cfg).toEqual({ instructions: "", use_knowledge: true, max_turns: 1, next_node_key: "", handoff_next: "" });
    const issues = aiReplyIssues({ node_key: "ai_1", node_type: "ai_reply", config: cfg }, new Set(["ai_1"]))
      .filter((i) => i.field !== "next_node_key" && i.field !== "handoff_next");
    expect(issues).toEqual([]);
  });

  it("end's default is an empty object (terminal — no config)", () => {
    expect(defaultConfigFor("end")).toEqual({});
  });
});

describe("appendNode", () => {
  const base: BuilderState = {
    name: "f",
    description: "",
    trigger_type: "manual",
    trigger_config: {},
    entry_node_id: null,
    status: "draft",
    fallback_policy: resolveFallbackPolicy(null),
    test_numbers: [],
    nodes: [{ node_key: "send_message", node_type: "send_message", config: {} }],
  };

  it("adds the node under exactly the key it was given", () => {
    // addNode picks the unique key before queueing the update and
    // returns it; the canvas then positions / wires / selects by that
    // key, so the node must land under that key, not the colliding base.
    const key = uniqueNodeKey("send_message", base.nodes);
    expect(key).toBe("send_message_2");
    const next = appendNode(base, "send_message", key);
    expect(next.nodes.map((n) => n.node_key)).toEqual(["send_message", "send_message_2"]);
    expect(next.nodes[1].config).toEqual(defaultConfigFor("send_message"));
    expect(base.nodes).toHaveLength(1);
  });

  it("makes a new start node the entry only when none is set", () => {
    expect(appendNode(base, "start", "start").entry_node_id).toBe("start");
    expect(appendNode(base, "send_message", "m").entry_node_id).toBeNull();
    expect(appendNode({ ...base, entry_node_id: "x" }, "start", "start").entry_node_id).toBe("x");
  });
});

describe("publishDraft", () => {
  const HASH = "a".repeat(64);
  const SAVED = "b".repeat(64);
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("publishes exactly the hash it was given, without saving", async () => {
    const fetcher = vi.fn(async () => respond(200, { flow: { status: "active" } }));
    expect(await publishDraft({ flowId: "f1", draftHash: HASH, fetcher })).toEqual({ kind: "published", status: "active" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ status: "active", draft_hash: HASH });
  });

  it("stops when the save first fails, so the older server draft never goes live", async () => {
    const fetcher = vi.fn();
    const outcome = await publishDraft({ flowId: "f1", draftHash: HASH, saveFirst: async () => false, fetcher });
    expect(outcome).toEqual({ kind: "save_failed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the hash of the draft it just saved", async () => {
    const fetcher = vi.fn(async () => respond(200, { flow: { status: "active" } }));
    await publishDraft({ flowId: "f1", draftHash: HASH, saveFirst: async () => SAVED, fetcher });
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).draft_hash).toBe(SAVED);
  });

  it("reports a draft another member changed apart from other failures", async () => {
    const changed = vi.fn(async () => respond(409, { error: "Draft changed", draft_hash: SAVED }));
    expect(await publishDraft({ flowId: "f1", draftHash: HASH, fetcher: changed })).toEqual({ kind: "draft_changed", message: "Draft changed" });
    const invalid = vi.fn(async () => respond(422, { error: "Cannot activate" }));
    expect(await publishDraft({ flowId: "f1", draftHash: HASH, fetcher: invalid })).toEqual({ kind: "failed", message: "Cannot activate", status: 422 });
  });
});

describe("channel palettes (Stage 1)", () => {
  it("offers a WhatsApp flow every step and trigger it offered before", () => {
    const whatsappSteps = ADD_NODE_TYPES.filter((type) => !(INSTAGRAM_ONLY_NODE_TYPES as readonly string[]).includes(type));
    expect(nodeTypesForScope("whatsapp")).toEqual(whatsappSteps);
    expect(nodeTypesForScope(undefined)).toEqual(whatsappSteps);
    expect(triggerTypesForScope("whatsapp")).toEqual(["keyword", "template_reply", "first_inbound_message", "order_received", "ad_click",
      "default_reply", "manual"]);
  });

  it("offers an Instagram flow only what Instagram runs", () => {
    const steps = nodeTypesForScope("instagram");
    for (const whatsappOnly of ["send_template", "send_form", "ask_location", "ask_address", "send_catalog"] as const)
      expect(steps).not.toContain(whatsappOnly);
    expect(steps).toEqual(expect.arrayContaining(["send_message", "send_buttons", "condition", "ai_reply", "handoff", "end"]));
    // Stage 2 (2D): the Instagram-only steps have their forms, so the Instagram palette offers them.
    for (const instagramOnly of INSTAGRAM_ONLY_NODE_TYPES) expect(steps).toContain(instagramOnly);
    expect(triggerTypesForScope("instagram")).toEqual(["keyword", "ig_comment", "ig_story_reply", "ig_story_mention", "first_inbound_message",
      "default_reply", "manual"]);
  });

  it("offers a legacy flow on both channels only what both run", () => {
    const instagram = nodeTypesForScope("instagram");
    expect(nodeTypesForScope("any")).toEqual(nodeTypesForScope("whatsapp").filter((type) => instagram.includes(type)));
    for (const instagramOnly of INSTAGRAM_ONLY_NODE_TYPES) expect(nodeTypesForScope("any")).not.toContain(instagramOnly);
    expect(triggerTypesForScope("any")).toEqual(["keyword", "first_inbound_message", "default_reply", "manual"]);
  });

  it("makes an added private reply the first step, continuing to the old entry", () => {
    const base: BuilderState = {
      name: "f", description: "", trigger_type: "ig_comment", trigger_config: {}, entry_node_id: "hello", status: "draft",
      fallback_policy: resolveFallbackPolicy(undefined), test_numbers: [],
      nodes: [{ node_key: "hello", node_type: "send_message", config: { text: "hi", next_node_key: "" } }],
    };
    const next = appendNode(base, "ig_private_reply", "private_reply");
    expect(next.entry_node_id).toBe("private_reply");
    expect(next.nodes.find((n) => n.node_key === "private_reply")?.config.next_node_key).toBe("hello");
    // Any other step keeps the entry as it was.
    expect(appendNode(base, "send_card", "card").entry_node_id).toBe("hello");
  });

  it("opens a flow in its own section, a legacy one in WhatsApp", () => {
    expect(defaultSection("instagram")).toBe("instagram");
    expect(defaultSection("any")).toBe("whatsapp");
    expect(defaultSection(undefined)).toBe("whatsapp");
  });
});
