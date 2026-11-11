"use client";

/**
 * "Send card" (`send_card`) and "Send gallery" (`send_gallery`): Instagram
 * generic-template cards. Each card has a title (≤ 80), an optional
 * subtitle (≤ 80), an https image and tap link, and 0–3 buttons that open a
 * link or go to a step; a gallery holds 1–10 cards. Limits are enforced as
 * the author types (ig-node-config.ts); a button that goes to a step routes
 * like a reply button, a link button does not continue the flow.
 */

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { IgCard, IgCardButton } from "@/lib/flows/types";
import { INSTAGRAM_LIMITS, validHttpsUrl } from "@/lib/instagram/graph-limits";
import { isCurrencyCode, MoneyError, minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import { useWorkspaceCapabilities } from "../palette";
import { NextNodeRow, NodeKeySelect } from "../forms/fields";
import type { BuilderNode } from "../shared";
import { addCard, addCardButton, MAX_BUTTONS, MAX_CARDS, postbackIds, readCard, removeCard, setButtonType, storeCard } from "./ig-node-config";

type Patch = (patch: Record<string, unknown>) => void;
type T = ReturnType<typeof useTranslations>;
const label = "text-muted-foreground mb-1 block text-xs";
const help = "text-muted-foreground mt-1 text-[10px]";

function UrlInput({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const tc = useTranslations("Flows.nodes.card");
  const bad = value !== "" && !validHttpsUrl(value);
  return (
    <>
      <Input id={id} type="url" inputMode="url" value={value} placeholder={placeholder ?? "https://"} aria-invalid={bad || undefined}
        maxLength={INSTAGRAM_LIMITS.urlChars} onChange={(e) => onChange(e.target.value.trim())} className="bg-muted" />
      {bad && <p className="mt-1 text-[10px] text-amber-500">{tc("urlInvalid")}</p>}
    </>
  );
}

/** One card's fields. `used` holds the step's postback ids, so new ones stay unique across its cards. */
function CardFields({ id, card, used, allNodes, currentKey, onChange, t }: {
  id: string;
  card: IgCard;
  used: string[];
  allNodes: BuilderNode[];
  currentKey: string;
  onChange: (card: IgCard) => void;
  t: T;
}) {
  const tc = useTranslations("Flows.nodes.card");
  const tb = useTranslations("Flows.buyButton");
  const caps = useWorkspaceCapabilities();
  const buttons = card.buttons ?? [];
  // Stage 5: a buy button needs a payment provider; one already placed stays editable.
  const canBuy = !!caps?.payments;
  const set = (patch: Partial<IgCard>) => onChange({ ...card, ...patch });
  const setButton = (i: number, next: IgCardButton) => set({ buttons: buttons.map((b, j) => (j === i ? next : b)) });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label htmlFor={`${id}-title`} className={label}>{tc("title")}</label>
          <Input id={`${id}-title`} value={card.title} aria-invalid={!card.title.trim() || undefined}
            onChange={(e) => set({ title: e.target.value })} className="bg-muted" />
          {!card.title.trim() && <p className="mt-1 text-[10px] text-amber-500">{tc("titleRequired")}</p>}
        </div>
        <div>
          <label htmlFor={`${id}-subtitle`} className={label}>{tc("subtitle")}</label>
          <Input id={`${id}-subtitle`} value={card.subtitle ?? ""} onChange={(e) => set({ subtitle: e.target.value })} className="bg-muted" />
        </div>
        <div>
          <label htmlFor={`${id}-image`} className={label}>{tc("image")}</label>
          <UrlInput id={`${id}-image`} value={card.image_url ?? ""} onChange={(image_url) => set({ image_url })} />
          <p className={help}>{tc("imageHelp")}</p>
        </div>
        <div>
          <label htmlFor={`${id}-link`} className={label}>{tc("link")}</label>
          <UrlInput id={`${id}-link`} value={card.default_url ?? ""} onChange={(default_url) => set({ default_url })} />
        </div>
      </div>

      <fieldset>
        <legend className={label}>{tc("buttons")}</legend>
        <div className="flex flex-col gap-2">
          {buttons.map((b, i) => (
            <div key={i} className="border-border bg-muted/40 grid grid-cols-1 gap-2 rounded-md border p-2 md:grid-cols-[9rem_1fr_1.4fr_auto]">
              <Select value={b.type} onValueChange={(type) => setButton(i, setButtonType(b, type as IgCardButton["type"], used))}>
                <SelectTrigger className="bg-muted" aria-label={tc("buttonType")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="postback">{tc("buttonTypePostback")}</SelectItem>
                  <SelectItem value="web_url">{tc("buttonTypeUrl")}</SelectItem>
                  {(canBuy || b.type === "buy") && <SelectItem value="buy">{tb("label")}</SelectItem>}
                </SelectContent>
              </Select>
              <Input value={b.title} aria-label={tc("buttonTitle")} placeholder={tc("buttonTitle")} className="bg-muted"
                onChange={(e) => setButton(i, { ...b, title: e.target.value })} />
              {b.type === "web_url" ? (
                <div><UrlInput id={`${id}-button-${i}-url`} value={b.url} onChange={(url) => setButton(i, { ...b, url })} /></div>
              ) : b.type === "postback" ? (
                <NodeKeySelect value={b.next_node_key || null} nodes={allNodes} excludeKey={currentKey}
                  onChange={(v) => setButton(i, { ...b, next_node_key: v ?? "" })} placeholder={t("nextNodePlaceholder")} />
              ) : (
                <BuyButtonFields id={`${id}-button-${i}`} amountMinor={b.amount_minor} currency={b.currency}
                  onChange={(amount_minor, currency) => setButton(i, { ...b, amount_minor, currency })} />
              )}
              <Button type="button" variant="ghost" size="sm" aria-label={t("removeButton")}
                onClick={() => set({ buttons: buttons.filter((_, j) => j !== i) })}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        {buttons.some((b) => b.type === "buy") && <p className={help}>{canBuy || !caps ? tb("help") : tb("needsPayments")}</p>}
        {buttons.length < MAX_BUTTONS ? (
          <Button type="button" variant="outline" size="sm" className="mt-2"
            onClick={() => onChange(addCardButton(card, "postback", used, t("defaultOptionTitle")))}>
            <Plus className="mr-1 h-3.5 w-3.5" />{tc("addButton")}
          </Button>
        ) : (
          <p className={help}>{tc("maxButtons", { max: MAX_BUTTONS })}</p>
        )}
      </fieldset>
    </div>
  );
}

/**
 * Stage 5 buy button: an amount (typed in major units, stored in minor units)
 * and an ISO currency. The engine (5G) turns it into a checkout link.
 */
export function BuyButtonFields({ id, amountMinor, currency, onChange }: {
  id: string;
  amountMinor: number;
  currency: string;
  onChange: (amountMinor: number, currency: string) => void;
}) {
  const tb = useTranslations("Flows.buyButton");
  const validCurrency = isCurrencyCode(currency);
  const shown = validCurrency && amountMinor > 0 ? minorToDecimalString(amountMinor, currency) : "";
  const [draft, setDraft] = useState(shown);
  const [bad, setBad] = useState(false);
  const commit = (raw: string, code: string) => {
    setDraft(raw);
    if (!raw.trim() || !isCurrencyCode(code)) { setBad(false); onChange(0, code); return; }
    try {
      onChange(parseMoney(raw, code), code);
      setBad(false);
    } catch (err) {
      if (!(err instanceof MoneyError)) throw err;
      setBad(true);
    }
  };
  return (
    <div className="grid grid-cols-[1fr_5rem] gap-2">
      <Input id={`${id}-amount`} inputMode="decimal" value={draft} aria-label={tb("amount")} placeholder={tb("amount")}
        aria-invalid={bad || undefined} onChange={(e) => commit(e.target.value, currency)} className="bg-muted" />
      <Input id={`${id}-currency`} value={currency} maxLength={3} aria-label={tb("currency")} placeholder="USD"
        aria-invalid={!validCurrency || undefined}
        onChange={(e) => commit(draft, e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} className="bg-muted uppercase" />
    </div>
  );
}

export function IgCardForm({ node, allNodes, onUpdateConfig, t }: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: Patch;
  t: T;
}) {
  const tg = useTranslations("Flows.nodes.gallery");
  const gallery = node.node_type === "send_gallery";
  const raw = gallery ? (Array.isArray(node.config.cards) ? node.config.cards : []) : [node.config.card];
  const cards = raw.length ? raw.map(readCard) : [readCard(null)];
  const used = postbackIds(cards);
  const save = (next: IgCard[]) =>
    onUpdateConfig(gallery ? { cards: next.map(storeCard) } : { card: storeCard(next[0]) });
  const setCard = (i: number, card: IgCard) => save(cards.map((c, j) => (j === i ? card : c)));
  return (
    <>
      {cards.map((card, i) => (
        <div key={i} className={gallery ? "border-border rounded-md border p-3" : undefined}>
          {gallery && (
            <div className="mb-2 flex items-center justify-between">
              <span className="text-foreground text-xs font-semibold">{tg("cardN", { n: i + 1 })}</span>
              <Button type="button" variant="ghost" size="sm" disabled={cards.length <= 1} aria-label={tg("removeCard")}
                onClick={() => save(removeCard(cards, i))} className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
          <CardFields id={`card-${node.node_key}-${i}`} card={card} used={used} allNodes={allNodes} currentKey={node.node_key}
            onChange={(next) => setCard(i, next)} t={t} />
        </div>
      ))}
      {gallery && (cards.length < MAX_CARDS ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => save(addCard(cards))}>
          <Plus className="mr-1 h-3.5 w-3.5" />{tg("addCard")}
        </Button>
      ) : (
        <p className={help}>{tg("maxCards", { max: MAX_CARDS })}</p>
      ))}
      <NextNodeRow value={typeof node.config.next_node_key === "string" ? node.config.next_node_key : ""} allNodes={allNodes}
        currentKey={node.node_key} onChange={(v) => onUpdateConfig({ next_node_key: v })} label={t("advancesTo")} />
    </>
  );
}
