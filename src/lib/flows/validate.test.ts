import { describe, it, expect } from "vitest";
import { validateFlowForActivation, reachableFromEntry, findAutoAdvancingCycles, channelScopeIssues, parseChannelScope } from "./validate";

const validFlow = {
  name: "Welcome",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["support"] },
  entry_node_id: "start",
};

const validNodes = [
  { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
  {
    node_key: "menu",
    node_type: "send_buttons",
    config: {
      text: "How can we help?",
      buttons: [
        { reply_id: "a", title: "A", next_node_key: "ho" },
        { reply_id: "b", title: "B", next_node_key: "ho" },
      ],
    },
  },
  { node_key: "ho", node_type: "handoff", config: {} },
];

describe("validateFlowForActivation — happy path", () => {
  it("produces no issues on a well-formed flow", () => {
    expect(validateFlowForActivation(validFlow, validNodes)).toEqual([]);
  });
});

describe("validateFlowForActivation — flow-level", () => {
  it("flags empty name", () => {
    expect(
      validateFlowForActivation({ ...validFlow, name: "" }, validNodes),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "flow", field: "name" }),
      ]),
    );
  });

  it("flags whitespace-only name", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, name: "   " },
      validNodes,
    );
    expect(issues.some((i) => i.field === "name")).toBe(true);
  });

  it("flags missing entry_node_id", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: null },
      validNodes,
    );
    expect(issues.some((i) => i.field === "entry_node_id")).toBe(true);
  });

  it("flags entry_node_id that doesn't exist in nodes", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "ghost" },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.field === "entry_node_id" &&
          i.message.includes('"ghost"'),
      ),
    ).toBe(true);
  });

  it("flags empty node list", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: null },
      [],
    );
    expect(
      issues.some((i) => i.message.includes("at least one node")),
    ).toBe(true);
  });

  it("flags duplicate node_key", () => {
    const dupes = [
      { node_key: "a", node_type: "start", config: { next_node_key: "b" } },
      { node_key: "a", node_type: "end", config: {} },
      { node_key: "b", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "a" },
      dupes,
    );
    expect(
      issues.some(
        (i) =>
          i.message.includes("Duplicate node_key") &&
          i.node_key === "a",
      ),
    ).toBe(true);
  });
});

describe("validateFlowForActivation — trigger", () => {
  it("accepts an ad-click trigger for any ad or listed ad ids, and refuses bad ids", () => {
    const adIssues = (trigger_config: Record<string, unknown>) =>
      validateFlowForActivation({ ...validFlow, trigger_type: "ad_click", trigger_config }, validNodes)
        .filter((i) => i.field === "trigger_config.ad_ids");
    expect(adIssues({})).toEqual([]);
    expect(adIssues({ ad_ids: [] })).toEqual([]);
    expect(adIssues({ ad_ids: ["1234567890"] })).toEqual([]);
    expect(adIssues({ ad_ids: ["act_123"] })).toHaveLength(1);
    expect(adIssues({ ad_ids: "1234567890" })).toHaveLength(1);
    expect(adIssues({ ad_ids: Array.from({ length: 51 }, (_, i) => String(i + 1)) })).toHaveLength(1);
  });

  it("flags keyword trigger with no keywords", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_config: { keywords: [] },
      },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.scope === "trigger" &&
          i.message.includes("at least one keyword"),
      ),
    ).toBe(true);
  });

  it("flags keyword trigger missing keywords field entirely", () => {
    const issues = validateFlowForActivation(
      { ...validFlow, trigger_config: {} },
      validNodes,
    );
    expect(issues.some((i) => i.scope === "trigger")).toBe(true);
  });

  it("warns when keywords contain blanks", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_config: { keywords: ["support", "", " "] },
      },
      validNodes,
    );
    expect(
      issues.some(
        (i) =>
          i.scope === "trigger" &&
          i.severity === "warning" &&
          i.message.includes("blank"),
      ),
    ).toBe(true);
  });

  it("first_inbound_message trigger needs no config", () => {
    const issues = validateFlowForActivation(
      {
        ...validFlow,
        trigger_type: "first_inbound_message",
        trigger_config: {},
      },
      validNodes,
    );
    expect(issues.filter((i) => i.scope === "trigger")).toEqual([]);
  });
});

describe("validateFlowForActivation — nodes", () => {
  it("flags send_buttons without text", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          buttons: [{ reply_id: "x", title: "X", next_node_key: "h" }],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.node_key === "b" && i.field === "text"),
    ).toBe(true);
  });

  it("flags send_buttons with zero buttons", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: { text: "Hi", buttons: [] },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "b" &&
          i.field === "buttons" &&
          i.message.includes("at least one"),
      ),
    ).toBe(true);
  });

  it("flags send_buttons with more than 3 buttons (Meta limit)", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "1", title: "1", next_node_key: "h" },
            { reply_id: "2", title: "2", next_node_key: "h" },
            { reply_id: "3", title: "3", next_node_key: "h" },
            { reply_id: "4", title: "4", next_node_key: "h" },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "b" &&
          i.field === "buttons" &&
          i.message.includes("at most 3"),
      ),
    ).toBe(true);
  });

  it("flags button title over 20 chars", () => {
    const longTitle = "x".repeat(21);
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "1", title: longTitle, next_node_key: "h" },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "b" &&
          i.field === "buttons.0.title" &&
          i.message.includes("over 20"),
      ),
    ).toBe(true);
  });

  it("flags button pointing at non-existent next node", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "1", title: "Go", next_node_key: "ghost" },
          ],
        },
      },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.field === "buttons.0.next_node_key" &&
          i.message.includes("ghost"),
      ),
    ).toBe(true);
  });

  it("flags duplicate button reply_ids", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Hi",
          buttons: [
            { reply_id: "x", title: "X1", next_node_key: "h" },
            { reply_id: "x", title: "X2", next_node_key: "h" },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.message.includes("Duplicate button reply id")),
    ).toBe(true);
  });

  it("flags send_list with more than 10 rows total", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      reply_id: `r${i}`,
      title: `Row ${i}`,
      next_node_key: "h",
    }));
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "l" } },
      {
        node_key: "l",
        node_type: "send_list",
        config: {
          text: "Pick",
          button_label: "Pick",
          sections: [{ rows: eleven }],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "l" &&
          i.field === "sections" &&
          i.message.includes("at most 10"),
      ),
    ).toBe(true);
  });

  it("flags list row title over 24 chars", () => {
    const longTitle = "x".repeat(25);
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "l" } },
      {
        node_key: "l",
        node_type: "send_list",
        config: {
          text: "Pick",
          button_label: "Pick",
          sections: [
            {
              rows: [
                {
                  reply_id: "x",
                  title: longTitle,
                  next_node_key: "h",
                },
              ],
            },
          ],
        },
      },
      { node_key: "h", node_type: "handoff", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.message.includes("exceeds 24 chars")),
    ).toBe(true);
  });

  it("warns about unreachable nodes", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "h" } },
      { node_key: "h", node_type: "handoff", config: {} },
      // Orphaned — nothing points at it.
      { node_key: "orphan", node_type: "end", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "orphan" &&
          i.severity === "warning" &&
          i.message.includes("unreachable"),
      ),
    ).toBe(true);
  });

  it("doesn't crash on unknown node_type — flags it", () => {
    const nodes = [
      { node_key: "s", node_type: "wibble", config: {} },
    ];
    const issues = validateFlowForActivation(
      { ...validFlow, entry_node_id: "s" },
      nodes,
    );
    expect(
      issues.some((i) => i.message.includes("Unknown node type")),
    ).toBe(true);
  });
});

describe("validateFlowForActivation — send_media", () => {
  const baseFlow = { ...validFlow, entry_node_id: "s" };
  const nodesWith = (mediaConfig: Record<string, unknown>) => [
    { node_key: "s", node_type: "start", config: { next_node_key: "m" } },
    { node_key: "m", node_type: "send_media", config: mediaConfig },
    { node_key: "h", node_type: "handoff", config: {} },
  ];

  it("passes on a fully-populated send_media node", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "document",
        media_url: "https://cdn.example/invoice.pdf",
        caption: "Your invoice",
        filename: "invoice.pdf",
        next_node_key: "h",
      }),
    );
    expect(issues).toEqual([]);
  });

  it("flags missing media_url", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "",
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "media_url"),
    ).toBe(true);
  });

  it("flags missing media_type", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_url: "https://cdn.example/x.png",
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "media_type"),
    ).toBe(true);
  });

  it("flags next_node_key pointing at a non-existent node", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        next_node_key: "ghost",
      }),
    );
    expect(
      issues.some(
        (i) =>
          i.node_key === "m" &&
          i.field === "next_node_key" &&
          i.message.includes("ghost"),
      ),
    ).toBe(true);
  });

  it("flags caption exceeding 1024 chars", () => {
    const issues = validateFlowForActivation(
      baseFlow,
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        caption: "x".repeat(1025),
        next_node_key: "h",
      }),
    );
    expect(
      issues.some((i) => i.node_key === "m" && i.field === "caption"),
    ).toBe(true);
  });

  it("contributes its next_node_key to reachability", () => {
    const set = reachableFromEntry(
      "s",
      nodesWith({
        media_type: "image",
        media_url: "https://cdn.example/x.png",
        next_node_key: "h",
      }),
    );
    expect(set).toEqual(new Set(["s", "m", "h"]));
  });
});

describe("reachableFromEntry", () => {
  it("walks the graph from the entry", () => {
    const set = reachableFromEntry("start", validNodes);
    expect(set.has("start")).toBe(true);
    expect(set.has("menu")).toBe(true);
    expect(set.has("ho")).toBe(true);
  });

  it("returns the entry alone when no edges lead out", () => {
    const set = reachableFromEntry("only", [
      { node_key: "only", node_type: "handoff", config: {} },
    ]);
    expect(set).toEqual(new Set(["only"]));
  });

  it("survives a cycle (visited guard)", () => {
    const nodes = [
      { node_key: "a", node_type: "start", config: { next_node_key: "b" } },
      {
        node_key: "b",
        node_type: "send_buttons",
        config: {
          text: "Loop",
          buttons: [{ reply_id: "x", title: "Back", next_node_key: "a" }],
        },
      },
    ];
    const set = reachableFromEntry("a", nodes);
    expect(set).toEqual(new Set(["a", "b"]));
  });
});

describe("auto-advancing cycles", () => {
  const loopNodes = [
    { node_key: "start", node_type: "start", config: { next_node_key: "hello" } },
    {
      node_key: "hello",
      node_type: "send_message",
      config: { text: "Hi", next_node_key: "check" },
    },
    {
      node_key: "check",
      node_type: "condition",
      config: {
        subject: "var",
        subject_key: "x",
        operator: "present",
        true_next: "hello",
        false_next: "done",
      },
    },
    { node_key: "done", node_type: "end", config: {} },
  ];

  it("rejects a loop made only of auto-advancing nodes", () => {
    const issues = validateFlowForActivation(validFlow, loopNodes);
    const cycle = issues.filter((i) => i.message.includes("hello, check"));
    expect(cycle).toHaveLength(1);
    expect(cycle[0]).toMatchObject({
      severity: "error",
      scope: "node",
      node_key: "hello",
    });
  });

  it("rejects a self-looping node", () => {
    expect(
      findAutoAdvancingCycles([
        {
          node_key: "spam",
          node_type: "send_message",
          config: { text: "x", next_node_key: "spam" },
        },
      ]),
    ).toEqual([["spam"]]);
  });

  it("accepts a loop that passes through a node waiting for input", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
      {
        node_key: "menu",
        node_type: "send_buttons",
        config: {
          text: "Pick",
          buttons: [
            { reply_id: "again", title: "Again", next_node_key: "info" },
            { reply_id: "stop", title: "Stop", next_node_key: "done" },
          ],
        },
      },
      {
        node_key: "info",
        node_type: "send_message",
        config: { text: "Info", next_node_key: "menu" },
      },
      { node_key: "done", node_type: "end", config: {} },
    ];
    expect(findAutoAdvancingCycles(nodes)).toEqual([]);
    expect(validateFlowForActivation(validFlow, nodes)).toEqual([]);
  });

  it("finds no cycle in the well-formed flow", () => {
    expect(findAutoAdvancingCycles(validNodes)).toEqual([]);
  });
});

describe("validateFlowForActivation — conversion_event", () => {
  const withConversion = (config: Record<string, unknown>) => [
    { node_key: "start", node_type: "start", config: { next_node_key: "conv" } },
    { node_key: "conv", node_type: "conversion_event", config },
    { node_key: "ho", node_type: "handoff", config: {} },
  ];
  const nodeIssues = (config: Record<string, unknown>) =>
    validateFlowForActivation(validFlow, withConversion(config)).filter((i) => i.node_key === "conv");

  it("accepts a conversion event that continues to a known step", () => {
    expect(nodeIssues({ event_name: "LeadSubmitted", next_node_key: "ho" })).toEqual([]);
    expect(nodeIssues({ event_name: "QualifiedLead", value_var: "order_total", currency: "INR", next_node_key: "ho" })).toEqual([]);
  });

  it("flags an unknown event, a bad variable or currency, and a missing or dangling next step", () => {
    const fields = (config: Record<string, unknown>) => nodeIssues(config).map((i) => i.field);
    expect(fields({ event_name: "Refund", next_node_key: "ho" })).toEqual(["event_name"]);
    expect(fields({ event_name: "AddToCart", value_var: "order total", currency: "INR", next_node_key: "ho" })).toEqual(["value_var"]);
    expect(fields({ event_name: "AddToCart", value_var: "total", currency: "inr", next_node_key: "ho" })).toEqual(["currency"]);
    expect(fields({ event_name: "AddToCart" })).toEqual(["next_node_key"]);
    expect(fields({ event_name: "AddToCart", next_node_key: "gone" })).toEqual(["next_node_key"]);
  });

  it("rejects Purchase, which payment links and orders report under the order's event id", () => {
    const issues = nodeIssues({ event_name: "Purchase", value_var: "total", currency: "INR", next_node_key: "ho" });
    expect(issues.map((i) => [i.field, i.severity])).toEqual([["event_name", "error"]]);
    expect(issues[0].message).not.toBe(nodeIssues({ event_name: "Refund", next_node_key: "ho" })[0].message);
  });

  it("requires the value variable and currency together, since a value is never sent without its currency", () => {
    const fields = (config: Record<string, unknown>) => nodeIssues(config).map((i) => i.field);
    expect(fields({ event_name: "InitiateCheckout", value_var: "total", next_node_key: "ho" })).toEqual(["currency"]);
    expect(fields({ event_name: "InitiateCheckout", currency: "INR", next_node_key: "ho" })).toEqual(["value_var"]);
    expect(fields({ event_name: "InitiateCheckout", value_var: "", currency: "", next_node_key: "ho" })).toEqual([]);
  });

  it("treats the step as auto-advancing when looking for loops", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "conv" } },
      { node_key: "conv", node_type: "conversion_event", config: { event_name: "LeadSubmitted", next_node_key: "msg" } },
      { node_key: "msg", node_type: "send_message", config: { text: "hi", next_node_key: "conv" } },
    ];
    expect(findAutoAdvancingCycles(nodes)).toHaveLength(1);
  });
});

describe("channel scope (Phase 11)", () => {
  const igNodes = (extra: Array<{ node_key: string; node_type: string; config: Record<string, unknown> }>) => [
    { node_key: "start", node_type: "start", config: { next_node_key: extra[0]?.node_key ?? "ho" } },
    ...extra,
    { node_key: "ho", node_type: "handoff", config: {} },
  ];
  const errorsOf = (issues: ReturnType<typeof validateFlowForActivation>) => issues.filter((i) => i.severity === "error");

  it("leaves a WhatsApp flow (or one without a scope) exactly as before", () => {
    const template = igNodes([{ node_key: "tpl", node_type: "send_template", config: { template_name: "promo", language: "en", next_node_key: "ho" } }]);
    const before = validateFlowForActivation(validFlow, template);
    expect(validateFlowForActivation({ ...validFlow, channel_scope: "whatsapp" }, template)).toEqual(before);
    expect(channelScopeIssues("whatsapp", "ad_click", template)).toEqual([]);
    expect(channelScopeIssues(undefined, "ad_click", template)).toEqual([]);
  });

  it("blocks publishing an Instagram or 'any' flow with a step Instagram cannot run, on that step", () => {
    const nodes = igNodes([{ node_key: "tpl", node_type: "send_template", config: { template_name: "promo", language: "en", next_node_key: "ho" } }]);
    for (const channel_scope of ["instagram", "any"] as const) {
      expect(errorsOf(validateFlowForActivation({ ...validFlow, channel_scope }, nodes)))
        .toContainEqual(expect.objectContaining({ scope: "node", node_key: "tpl", field: "node_type" }));
    }
  });

  it("blocks a WhatsApp-only trigger on Instagram", () => {
    for (const trigger_type of ["template_reply", "order_received", "ad_click"] as const) {
      expect(channelScopeIssues("any", trigger_type, validNodes))
        .toContainEqual(expect.objectContaining({ severity: "error", scope: "trigger", field: "trigger_type" }));
    }
    expect(channelScopeIssues("instagram", "keyword", validNodes)).toEqual([]);
  });

  it("allows the steps Instagram supports and warns on long text", () => {
    expect(channelScopeIssues("instagram", "keyword", validNodes)).toEqual([]);
    const long = igNodes([{ node_key: "say", node_type: "send_message", config: { text: "x".repeat(1001), next_node_key: "ho" } }]);
    expect(channelScopeIssues("instagram", "keyword", long)).toEqual([expect.objectContaining({ severity: "warning", node_key: "say" })]);
    const media = (media_type: string, extra: Record<string, unknown> = {}) =>
      channelScopeIssues("instagram", "keyword", igNodes([{ node_key: "m", node_type: "send_media", config: { media_type, media_url: "https://x.test/a", next_node_key: "ho", ...extra } }]));
    expect(media("image")).toEqual([]);
    expect(media("document", { filename: "menu.pdf" })).toEqual([]);
    expect(media("document", { filename: "menu.docx" })).toHaveLength(1);
  });

  it("parses a request's scope", () => {
    expect(parseChannelScope(undefined)).toBeUndefined();
    expect(parseChannelScope("any")).toBe("any");
    expect(parseChannelScope("instagram")).toBe("instagram");
    for (const bad of [null, "", "sms", 1, ["any"]]) expect(parseChannelScope(bad)).toBeNull();
  });
});
