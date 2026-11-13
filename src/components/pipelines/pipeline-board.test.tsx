// Viewers cannot move deals: the board renders no drag handles and the card
// menu has no "Move to" items when the page leaves out onDealMoved.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ defaultCurrency: "USD" }) }));

import { PipelineBoard } from "./pipeline-board";
import { DealCard } from "./deal-card";
import type { Deal, PipelineStage } from "@/types";

const stages = [
  { id: "s1", name: "New", color: "#000", position: 0 },
  { id: "s2", name: "Won", color: "#0f0", position: 1 },
] as unknown as PipelineStage[];
const deal = { id: "d1", title: "Big deal", stage_id: "s1", value: 10, currency: "USD", status: "open" } as unknown as Deal;

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      {node}
    </NextIntlClientProvider>,
  );

describe("pipeline board for viewers", () => {
  it("renders draggable cards when deals can be moved", () => {
    const html = wrap(<PipelineBoard stages={stages} deals={[deal]} onDealMoved={() => {}} onAddDeal={() => {}} onEditDeal={() => {}} />);
    expect(html).toContain('aria-roledescription="draggable"');
    expect(html).toContain("cursor-grab");
  });

  it("renders no drag handle without onDealMoved", () => {
    const html = wrap(<PipelineBoard stages={stages} deals={[deal]} onAddDeal={() => {}} onEditDeal={() => {}} />);
    expect(html).not.toContain('aria-roledescription="draggable"');
    expect(html).not.toContain("cursor-grab");
    expect(html).toContain("Big deal");
  });

  it("shows no card action menu when neither move nor delete is allowed", () => {
    expect(wrap(<DealCard deal={deal} stage={stages[0]} onEdit={() => {}} stages={stages} />)).not.toContain("Sales.pipeline.dealActions");
    expect(wrap(<DealCard deal={deal} stage={stages[0]} onEdit={() => {}} stages={stages} onMove={() => {}} />)).toContain("Sales.pipeline.dealActions");
  });
});
