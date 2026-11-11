// Stage 5 step forms, rendered to static markup with a key-echoing
// translator: the Actions list, Randomizer, Smart delay (and its Instagram
// 24-hour warning), the Condition form per channel, Ask Question's
// "Save answer to", the card Buy button and the AI goals editor.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  editor: { channelScope: "instagram", flow: { id: "flow-1" }, state: { nodes: [] } } as Record<string, unknown>,
  caps: null as Record<string, boolean> | null,
}));
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useTranslations: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ""}${key}`,
}));
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  authFetch: vi.fn(async () => new Response("{}", { status: 503 })),
}));
vi.mock("../flow-editor-state", async (original) => ({
  ...(await original<typeof import("../flow-editor-state")>()),
  useFlowEditor: () => h.editor,
}));
vi.mock("../palette", async (original) => ({
  ...(await original<typeof import("../palette")>()),
  useWorkspaceCapabilities: () => h.caps,
}));

import type { BuilderNode } from "../shared";
import { IgCardForm } from "../nodes/ig-card-form";
import { ActionsForm } from "./actions-form";
import { AiReplyForm } from "./ai-reply-form";
import { ConditionForm, QuestionForm } from "./question-forms";
import { RandomizerForm } from "./randomizer-form";
import { SmartDelayForm } from "./smart-delay-form";

const t = ((key: string) => `form.${key}`) as never;
const noop = () => {};
const node = (node_type: BuilderNode["node_type"], config: Record<string, unknown>, node_key = "n1"): BuilderNode => ({ node_key, node_type, config });

beforeEach(() => {
  h.editor = { channelScope: "instagram", flow: { id: "flow-1" }, state: { nodes: [] } };
  h.caps = null;
});

describe("Actions form", () => {
  it("lists the actions in order with move, remove and add controls", () => {
    const html = renderToStaticMarkup(
      <ActionsForm node={node("actions", { actions: [{ type: "add_tag", tag_id: "" }, { type: "pause_automations", minutes: null }] })} allNodes={[]} onUpdateConfig={noop} />,
    );
    expect(html).toContain("1. Flows.nodes.actions.types.add_tag");
    expect(html).toContain("2. Flows.nodes.actions.types.pause_automations");
    expect(html).toContain('aria-label="Flows.nodes.actions.moveUp"');
    expect(html).toContain('aria-label="Flows.nodes.actions.remove"');
    expect(html).toContain("Flows.nodes.actions.add");
    expect(html).not.toContain("Flows.nodes.actions.empty");
  });

  it("asks for at least one action", () => {
    const html = renderToStaticMarkup(<ActionsForm node={node("actions", { actions: [] })} allNodes={[]} onUpdateConfig={noop} />);
    expect(html).toContain("Flows.nodes.actions.empty");
  });
});

describe("Randomizer form", () => {
  it("shows each path's share and flags a total other than 100", () => {
    const ok = renderToStaticMarkup(<RandomizerForm node={node("randomizer", { paths: [{ id: "A", weight: 50 }, { id: "B", weight: 50 }], sticky: true })} allNodes={[]} onUpdateConfig={noop} />);
    expect(ok).toContain("Flows.nodes.randomizer.sticky");
    expect(ok).not.toContain("totalInvalid");
    const bad = renderToStaticMarkup(<RandomizerForm node={node("randomizer", { paths: [{ id: "A", weight: 70 }, { id: "B", weight: 50 }] })} allNodes={[]} onUpdateConfig={noop} />);
    expect(bad).toContain("Flows.nodes.randomizer.totalInvalid");
  });
});

describe("Smart delay form", () => {
  it("warns about Instagram's 24-hour window on a long wait, only on Instagram", () => {
    const long = node("smart_delay", { mode: "duration", amount: 2, unit: "days" });
    expect(renderToStaticMarkup(<SmartDelayForm node={long} allNodes={[]} onUpdateConfig={noop} instagram />)).toContain("instagramWarning");
    expect(renderToStaticMarkup(<SmartDelayForm node={long} allNodes={[]} onUpdateConfig={noop} instagram={false} />)).not.toContain("instagramWarning");
    const short = node("smart_delay", { mode: "duration", amount: 2, unit: "hours" });
    expect(renderToStaticMarkup(<SmartDelayForm node={short} allNodes={[]} onUpdateConfig={noop} instagram />)).not.toContain("instagramWarning");
  });

  it("the date tab says a past date stops the automation", () => {
    const html = renderToStaticMarkup(<SmartDelayForm node={node("smart_delay", { mode: "until_date" })} allNodes={[]} onUpdateConfig={noop} instagram />);
    expect(html).toContain("Flows.nodes.smartDelay.pastDate");
    expect(html).toContain('aria-selected="true"');
  });
});

describe("Condition form", () => {
  const followGate = node("condition", { match: "all", rules: [{ subject: "ig_profile", subject_key: "follows_business", operator: "equals", value: "true" }] });

  it("on Instagram: an all / any toggle, the follow fact and a yes / no choice", () => {
    const html = renderToStaticMarkup(<ConditionForm node={followGate} allNodes={[followGate]} onUpdateConfig={noop} t={t} scope="instagram" />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Flows.conditions.question");
    expect(html).toContain('data-subject="ig_profile"');
    expect(html).toContain("Flows.conditions.igFacts.follows_business");
    expect(html).toContain("Flows.conditions.yes");
    expect(html).toContain("Flows.conditions.add");
  });

  it("on WhatsApp: the form is as before (match select, no Stage 5 subjects or picker)", () => {
    const rule = node("condition", { rules: [{ subject: "tag", subject_key: "", operator: "present" }] });
    const html = renderToStaticMarkup(<ConditionForm node={rule} allNodes={[rule]} onUpdateConfig={noop} t={t} scope="whatsapp" />);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("form.matchLabel");
    expect(html).toContain("form.addRule");
    expect(html).not.toContain("Flows.conditions.add");
  });
});

describe("Ask Question form", () => {
  const ask = node("collect_input", { prompt_text: "Your email?", var_key: "email", validation: "email", save_to: { target: "contact_field", key: "email" } });

  it("Instagram flows can save the answer to a field and run actions on a valid answer", () => {
    const html = renderToStaticMarkup(<QuestionForm node={ask} allNodes={[ask]} onUpdateConfig={noop} t={t} instagram />);
    expect(html).toContain("Flows.saveTo.label");
    expect(html).toContain("Flows.saveTo.conflictNote");
    expect(html).toContain("Flows.nodes.actions.onSuccess");
    expect(html).not.toContain("Flows.nodes.actions.empty");
  });

  it("WhatsApp flows keep the form they had", () => {
    const html = renderToStaticMarkup(<QuestionForm node={ask} allNodes={[ask]} onUpdateConfig={noop} t={t} />);
    expect(html).not.toContain("Flows.saveTo.label");
  });
});

describe("Card buy button", () => {
  const card = (buttons: unknown[]) => node("send_card", { card: { title: "Hoodie", buttons } });

  it("edits a placed buy button's amount and currency", () => {
    const html = renderToStaticMarkup(<IgCardForm node={card([{ type: "buy", title: "Buy", amount_minor: 2500, currency: "USD" }])} allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(html).toContain('value="25.00"');
    expect(html).toContain('value="USD"');
    expect(html).toContain("Flows.buyButton.help");
  });

  it("offers the buy type only with the payments capability", () => {
    h.caps = { payments: false };
    const without = renderToStaticMarkup(<IgCardForm node={card([{ type: "web_url", title: "Go", url: "" }])} allNodes={[]} onUpdateConfig={noop} t={t} />);
    expect(without).not.toContain("Flows.buyButton.label");
  });
});

describe("AI step", () => {
  it("Instagram flows get tasks, context, goals and the finish port", () => {
    const ai = node("ai_reply", { goals: [{ type: "capture_lead", fields: ["email"], on_refusal: "handoff" }], next_node_key: "", handoff_next: "" });
    const html = renderToStaticMarkup(<AiReplyForm node={ai} allNodes={[ai]} onUpdateConfig={noop} t={t} instagram />);
    expect(html).toContain("Flows.aiGoals.goalText");
    expect(html).toContain("Flows.aiGoals.types.capture_lead");
    expect(html).toContain("Flows.aiGoals.finish");
    expect(renderToStaticMarkup(<AiReplyForm node={ai} allNodes={[ai]} onUpdateConfig={noop} t={t} />)).not.toContain("Flows.aiGoals");
  });
});
