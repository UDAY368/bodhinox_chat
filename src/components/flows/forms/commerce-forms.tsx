"use client";

/**
 * Forms for the catalogue steps: send_product, send_product_list and
 * send_catalog. Products are stored by their catalogue content id
 * (retailer_id); at run time the step sends from the conversation's number
 * with the catalogue linked to it. Mounted by NodeConfigForm.
 */

import { Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProductPicker } from "@/components/commerce/catalog/product-picker";
import { COMMERCE_NODE_LIMITS } from "@/lib/flows/commerce-nodes";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;
type Section = { title: string; product_retailer_ids: string[] };

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function TextField({ id, labelText, value, max, onChange, multiline }: {
  id: string; labelText: string; value: string; max: number; onChange: (v: string) => void; multiline?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>{labelText}</label>
      {multiline ? (
        <Textarea id={id} value={value} maxLength={max} rows={3} onChange={(e) => onChange(e.target.value)} className="bg-muted" />
      ) : (
        <Input id={id} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} className="bg-muted" />
      )}
    </div>
  );
}

export function CommerceStepForm({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const tc = useTranslations("Commerce.catalog.flowStep");
  const cfg = node.config;
  const id = (field: string) => `commerce-${node.node_key}-${field}`;
  const L = COMMERCE_NODE_LIMITS;
  const footer = (
    <TextField id={id("footer")} labelText={tc("footer", { max: L.footer })} value={str(cfg.footer_text)} max={L.footer}
      onChange={(v) => onUpdateConfig({ footer_text: v || undefined })} />
  );
  const next = (
    <NextNodeRow label={t("advancesTo")} value={str(cfg.next_node_key)} allNodes={allNodes} currentKey={node.node_key}
      onChange={(v) => onUpdateConfig({ next_node_key: v })} />
  );

  if (node.node_type === "send_product") {
    const chosen = str(cfg.product_retailer_id);
    return (
      <>
        <div>
          <span className={label}>{tc("product")}</span>
          {chosen && <p className="mb-1 truncate font-mono text-xs text-foreground">{chosen}</p>}
          <ProductPicker selected={chosen ? [chosen] : []} keyOf={(p) => p.retailer_id}
            onToggle={(p) => onUpdateConfig({ product_retailer_id: p.retailer_id === chosen ? "" : p.retailer_id })} />
        </div>
        <TextField id={id("body")} labelText={tc("bodyOptional", { max: L.body })} value={str(cfg.body_text)} max={L.body} multiline
          onChange={(v) => onUpdateConfig({ body_text: v })} />
        {footer}
        <p className={help}>{tc("numberHelp")}</p>
        {next}
      </>
    );
  }

  if (node.node_type === "send_catalog") {
    const thumb = str(cfg.thumbnail_product_retailer_id);
    return (
      <>
        <TextField id={id("body")} labelText={tc("body", { max: L.body })} value={str(cfg.body_text)} max={L.body} multiline
          onChange={(v) => onUpdateConfig({ body_text: v })} />
        {footer}
        <div>
          <span className={label}>{tc("thumbnail")}</span>
          {thumb && <p className="mb-1 truncate font-mono text-xs text-foreground">{thumb}</p>}
          <ProductPicker selected={thumb ? [thumb] : []} keyOf={(p) => p.retailer_id}
            onToggle={(p) => onUpdateConfig({ thumbnail_product_retailer_id: p.retailer_id === thumb ? undefined : p.retailer_id })} />
        </div>
        <p className={help}>{tc("numberHelp")}</p>
        {next}
      </>
    );
  }

  // send_product_list
  const sections: Section[] = Array.isArray(cfg.sections)
    ? (cfg.sections as Section[]).map((s) => ({ title: str(s?.title), product_retailer_ids: Array.isArray(s?.product_retailer_ids) ? s.product_retailer_ids : [] }))
    : [];
  const total = sections.reduce((sum, s) => sum + s.product_retailer_ids.length, 0);
  const setSections = (next: Section[]) => onUpdateConfig({ sections: next });
  const update = (index: number, patch: Partial<Section>) => setSections(sections.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  return (
    <>
      <TextField id={id("header")} labelText={tc("header", { max: L.header })} value={str(cfg.header_text)} max={L.header}
        onChange={(v) => onUpdateConfig({ header_text: v })} />
      <TextField id={id("body")} labelText={tc("body", { max: L.body })} value={str(cfg.body_text)} max={L.body} multiline
        onChange={(v) => onUpdateConfig({ body_text: v })} />
      {footer}
      <p className={help}>{tc("listLimits", { products: L.maxProducts, sections: L.maxSections, count: total })}</p>
      {sections.map((section, index) => (
        <div key={index} className="space-y-2 rounded-md border border-border p-2">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextField id={id(`section-${index}`)} labelText={tc("sectionTitle", { max: L.sectionTitle })} value={section.title}
                max={L.sectionTitle} onChange={(v) => update(index, { title: v })} />
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={tc("removeSection")} disabled={sections.length <= 1}
              onClick={() => setSections(sections.filter((_, i) => i !== index))}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          {section.product_retailer_ids.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {section.product_retailer_ids.map((rid) => (
                <li key={rid} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  {rid}
                  <button type="button" aria-label={tc("removeProduct", { id: rid })}
                    onClick={() => update(index, { product_retailer_ids: section.product_retailer_ids.filter((x) => x !== rid) })}>
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ProductPicker
            selected={section.product_retailer_ids}
            keyOf={(p) => p.retailer_id}
            disabled={total >= L.maxProducts}
            onToggle={(p) => {
              const has = section.product_retailer_ids.includes(p.retailer_id);
              // A product appears once per message: picking it here moves it from another section.
              setSections(sections.map((s, i) => ({
                ...s,
                product_retailer_ids: i === index
                  ? (has ? s.product_retailer_ids.filter((x) => x !== p.retailer_id) : [...s.product_retailer_ids, p.retailer_id])
                  : s.product_retailer_ids.filter((x) => x !== p.retailer_id),
              })));
            }}
          />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" disabled={sections.length >= L.maxSections}
        onClick={() => setSections([...sections, { title: "", product_retailer_ids: [] }])}>
        <Plus className="h-3.5 w-3.5" />
        {tc("addSection")}
      </Button>
      <p className={help}>{tc("numberHelp")}</p>
      {next}
    </>
  );
}
