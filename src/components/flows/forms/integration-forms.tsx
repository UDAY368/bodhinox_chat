"use client";

/**
 * Forms for send_template, api_request, assign_agent and connect_flow.
 * Mounted by NodeConfigForm alongside the other per-node forms.
 */

import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import type { ApiRequestNodeConfig, SendTemplateNodeConfig } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";
import { FLOW_OFFER_MAX_MINUTES } from "@/lib/whatsapp/template-send-params";
import { useApprovedTemplates, useAssignableMembers, useFlowList, type FlowTemplate } from "./use-pickers";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;
interface FormProps { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";
const MAX_ROUTES = 5;
const MAX_PAIRS = 20;

/** Highest {{n}} in a template body: the number of values it needs. */
function bodyVariableCount(body: string): number {
  return Math.max(0, ...[...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));
}

const templateKey = (name: string, language?: string | null) => `${name}::${language ?? ""}`;

// ============================================================
// send_template
// ============================================================

export function SendTemplateForm({ node, allNodes, onUpdateConfig, t }: FormProps) {
  const cfg = node.config as unknown as SendTemplateNodeConfig;
  const templates = useApprovedTemplates();
  const params = cfg.body_params ?? [];
  const buttons = cfg.buttons ?? [];

  // Picking a template sizes the body values and rebuilds the quick-reply ports,
  // keeping any route already drawn for the same button position.
  const pick = (template: FlowTemplate) => {
    const count = bodyVariableCount(template.body_text);
    const quickReplies = (template.buttons ?? [])
      .map((b, index) => ({ ...b, index }))
      .filter((b) => b.type === "QUICK_REPLY");
    const cards = template.template_kind === "carousel" ? template.cards ?? [] : [];
    onUpdateConfig({
      template_name: template.name,
      language: template.language ?? undefined,
      body_params: Array.from({ length: count }, (_, i) => params[i] ?? ""),
      // Extras only for the kinds that use them; switching templates clears the rest.
      location: template.header_type === "location" ? cfg.location ?? { latitude: "", longitude: "" } : undefined,
      offer_expires_in_minutes: template.lto?.has_expiration ? cfg.offer_expires_in_minutes ?? 60 : undefined,
      coupon_code: (template.buttons ?? []).some((b) => b.type === "COPY_CODE") ? cfg.coupon_code ?? "" : undefined,
      card_params: cards.length
        ? cards.map((c, ci) => Array.from({ length: bodyVariableCount(c.body_text) }, (_, i) => cfg.card_params?.[ci]?.[i] ?? ""))
        : undefined,
      buttons: quickReplies.map((b) => ({
        index: b.index,
        reply_id: `tpl_${b.index + 1}`,
        title: b.text,
        next_node_key: buttons.find((old) => old.index === b.index)?.next_node_key ?? "",
      })),
    });
  };

  const selected = templates.find((x) => templateKey(x.name, x.language) === templateKey(cfg.template_name, cfg.language));
  return (
    <>
      <div>
        <label htmlFor={`tpl-${node.node_key}`} className={label}>{t("templateLabel")}</label>
        <Select
          value={cfg.template_name ? templateKey(cfg.template_name, cfg.language) : ""}
          onValueChange={(v) => { const tpl = templates.find((x) => templateKey(x.name, x.language) === v); if (tpl) pick(tpl); }}
        >
          <SelectTrigger id={`tpl-${node.node_key}`} className="bg-muted"><SelectValue placeholder={t("pickTemplate")} /></SelectTrigger>
          <SelectContent>
            {templates.map((x) => (
              <SelectItem key={x.id} value={templateKey(x.name, x.language)}>{x.name}{x.language ? ` (${x.language})` : ""}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className={help}>{t("templateHelp")}</p>
      </div>
      {selected && <p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs text-muted-foreground">{selected.body_text}</p>}
      {params.map((value, i) => (
        <div key={i}>
          <label htmlFor={`tpl-${node.node_key}-p${i}`} className={label}>{t("templateParam", { n: i + 1 })}</label>
          <Input
            id={`tpl-${node.node_key}-p${i}`}
            value={value}
            onChange={(e) => onUpdateConfig({ body_params: params.map((p, j) => (j === i ? e.target.value : p)) })}
            className="bg-muted"
          />
        </div>
      ))}
      {cfg.location && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <p className="text-xs font-medium">{t("templateLocation")}</p>
          <div className="grid grid-cols-2 gap-2">
            {(["latitude", "longitude"] as const).map((k) => (
              <div key={k}>
                <label htmlFor={`tpl-${node.node_key}-${k}`} className={label}>{t(k === "latitude" ? "templateLatitude" : "templateLongitude")}</label>
                <Input
                  id={`tpl-${node.node_key}-${k}`}
                  inputMode="decimal"
                  value={String(cfg.location?.[k] ?? "")}
                  onChange={(e) => onUpdateConfig({ location: { ...cfg.location, [k]: e.target.value } })}
                  className="bg-muted"
                />
              </div>
            ))}
          </div>
          {(["name", "address"] as const).map((k) => (
            <Input
              key={k}
              aria-label={t(k === "name" ? "templateLocationName" : "templateLocationAddress")}
              placeholder={t(k === "name" ? "templateLocationName" : "templateLocationAddress")}
              value={cfg.location?.[k] ?? ""}
              onChange={(e) => onUpdateConfig({ location: { ...cfg.location, [k]: e.target.value || undefined } })}
              className="bg-muted"
            />
          ))}
        </div>
      )}
      {cfg.offer_expires_in_minutes !== undefined && (
        <div>
          <label htmlFor={`tpl-${node.node_key}-offer`} className={label}>{t("templateOfferMinutes")}</label>
          <Input
            id={`tpl-${node.node_key}-offer`}
            type="number"
            min={1}
            max={FLOW_OFFER_MAX_MINUTES}
            value={cfg.offer_expires_in_minutes}
            onChange={(e) => onUpdateConfig({ offer_expires_in_minutes: e.target.value === "" ? 0 : Number(e.target.value) })}
            className="bg-muted"
          />
          <p className={help}>{t("templateOfferHelp")}</p>
        </div>
      )}
      {cfg.coupon_code !== undefined && (
        <div>
          <label htmlFor={`tpl-${node.node_key}-coupon`} className={label}>{t("templateCoupon")}</label>
          <Input
            id={`tpl-${node.node_key}-coupon`}
            value={cfg.coupon_code}
            onChange={(e) => onUpdateConfig({ coupon_code: e.target.value })}
            className="bg-muted"
          />
          <p className={help}>{t("templateCouponHelp")}</p>
        </div>
      )}
      {(cfg.card_params ?? []).map((values, ci) =>
        values.map((value, i) => (
          <div key={`c${ci}-${i}`}>
            <label htmlFor={`tpl-${node.node_key}-c${ci}-${i}`} className={label}>{t("templateCardParam", { card: ci + 1, n: i + 1 })}</label>
            <Input
              id={`tpl-${node.node_key}-c${ci}-${i}`}
              value={value}
              onChange={(e) =>
                onUpdateConfig({
                  card_params: (cfg.card_params ?? []).map((list, x) => (x === ci ? list.map((v, y) => (y === i ? e.target.value : v)) : list)),
                })
              }
              className="bg-muted"
            />
          </div>
        )),
      )}
      {buttons.length > 0 ? (
        buttons.map((b, i) => (
          <NextNodeRow
            key={b.index}
            value={b.next_node_key}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ buttons: buttons.map((x, j) => (j === i ? { ...x, next_node_key: v } : x)) })}
            label={t("templateButtonNext", { title: b.title })}
          />
        ))
      ) : (
        <NextNodeRow
          value={cfg.next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label={t("advancesTo")}
        />
      )}
    </>
  );
}

// ============================================================
// api_request
// ============================================================

type Pair = { key: string; value: string };

function PairsEditor({ id, title, pairs, onChange, t }: { id: string; title: string; pairs: Pair[]; onChange: (p: Pair[]) => void; t: T }) {
  return (
    <fieldset className="space-y-2">
      <legend className={label}>{title}</legend>
      {pairs.map((p, i) => (
        <div key={i} className="flex gap-2">
          <Input aria-label={t("pairKey", { n: i + 1 })} id={`${id}-k${i}`} value={p.key} placeholder={t("pairKeyPlaceholder")}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className="bg-muted font-mono text-xs" />
          <Input aria-label={t("pairValue", { n: i + 1 })} value={p.value} placeholder={t("pairValuePlaceholder")}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="bg-muted text-xs" />
          <Button type="button" variant="ghost" size="sm" aria-label={t("removeRow")} onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      {pairs.length < MAX_PAIRS && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
          <Plus className="size-3.5" /> {t("addRow")}
        </Button>
      )}
    </fieldset>
  );
}

interface TestResult { status: number | null; error: string | null; duration_ms: number; mapped: Record<string, string>; preview: string | null }

export function ApiRequestForm({ node, allNodes, onUpdateConfig, t }: FormProps) {
  const cfg = node.config as unknown as ApiRequestNodeConfig;
  const key = node.node_key;
  const routes = cfg.routes ?? [];
  const mappings = cfg.mappings ?? [];
  const sendsBody = cfg.method !== "GET" && cfg.method !== "DELETE";
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | { failed: string } | null>(null);
  // Sample values for the test only; never saved with the step.
  const [samples, setSamples] = useState<Record<string, string>>({});
  const sampleKeys = [...new Set(
    [...JSON.stringify([cfg.url, cfg.params, cfg.headers, sendsBody ? cfg.body : ""])
      .matchAll(/\{\{\s*(vars|contact)\.([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => `${m[1]}.${m[2]}`),
  )];

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    const scope = (prefix: string) => Object.fromEntries(sampleKeys
      .filter((k) => k.startsWith(prefix) && samples[k])
      .map((k) => [k.slice(prefix.length), samples[k]]));
    try {
      const res = await authFetch("/api/flows/test-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: {
            method: cfg.method, url: cfg.url, params: cfg.params, headers: cfg.headers,
            body: sendsBody ? cfg.body : undefined,
            // Unfinished mapping rows would make the whole test invalid.
            mappings: mappings.filter((m) => m.path.trim() && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(m.var_key)),
          },
          vars: scope("vars."),
          contact: scope("contact."),
        }),
      });
      const json = await res.json().catch(() => ({}));
      setResult(res.ok ? (json as TestResult) : { failed: typeof json.error === "string" ? json.error : t("testFailed") });
    } catch {
      setResult({ failed: t("testFailed") });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="grid grid-cols-[7rem_1fr] gap-2">
        <div>
          <label htmlFor={`method-${key}`} className={label}>{t("apiMethod")}</label>
          <Select value={cfg.method ?? "GET"} onValueChange={(method) => onUpdateConfig({ method })}>
            <SelectTrigger id={`method-${key}`} className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor={`url-${key}`} className={label}>{t("apiUrl")}</label>
          <Input id={`url-${key}`} value={cfg.url ?? ""} placeholder="https://api.example.com/orders/{{vars.order_id}}"
            onChange={(e) => onUpdateConfig({ url: e.target.value })} className="bg-muted font-mono text-xs" />
        </div>
      </div>
      <p className={help}>{t.raw("apiValuesHelp")}</p>
      <PairsEditor id={`params-${key}`} title={t("apiParams")} pairs={cfg.params ?? []} onChange={(params) => onUpdateConfig({ params })} t={t} />
      <PairsEditor id={`headers-${key}`} title={t("apiHeaders")} pairs={cfg.headers ?? []} onChange={(headers) => onUpdateConfig({ headers })} t={t} />
      {sendsBody && (
        <div>
          <label htmlFor={`body-${key}`} className={label}>{t("apiBody")}</label>
          <Textarea id={`body-${key}`} rows={4} value={cfg.body ?? ""} placeholder={'{"name": "{{contact.name}}"}'}
            onChange={(e) => onUpdateConfig({ body: e.target.value })} className="bg-muted font-mono text-xs" />
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className={label}>{t("apiMappings")}</legend>
        {mappings.map((m, i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label={t("mappingPath", { n: i + 1 })} value={m.path} placeholder="data.status"
              onChange={(e) => onUpdateConfig({ mappings: mappings.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} className="bg-muted font-mono text-xs" />
            <Input aria-label={t("mappingVar", { n: i + 1 })} value={m.var_key} placeholder={t("varKeyPlaceholder")}
              onChange={(e) => onUpdateConfig({ mappings: mappings.map((x, j) => (j === i ? { ...x, var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") } : x)) })} className="bg-muted font-mono text-xs" />
            <Button type="button" variant="ghost" size="sm" aria-label={t("removeRow")} onClick={() => onUpdateConfig({ mappings: mappings.filter((_, j) => j !== i) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        {mappings.length < MAX_PAIRS && (
          <Button type="button" variant="outline" size="sm" onClick={() => onUpdateConfig({ mappings: [...mappings, { path: "", var_key: "" }] })}>
            <Plus className="size-3.5" /> {t("addMapping")}
          </Button>
        )}
        <p className={help}>{t("apiMappingsHelp")}</p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className={label}>{t("apiRoutes")}</legend>
        {routes.map((r, i) => (
          <div key={i} className="grid grid-cols-[6rem_1fr_auto] items-end gap-2">
            <div>
              <label htmlFor={`route-${key}-${i}`} className={label}>{t("apiStatus")}</label>
              <Input id={`route-${key}-${i}`} value={r.status} placeholder="200 / 2xx"
                onChange={(e) => onUpdateConfig({ routes: routes.map((x, j) => (j === i ? { ...x, status: e.target.value } : x)) })} className="bg-muted font-mono text-xs" />
            </div>
            <NextNodeRow value={r.next_node_key} allNodes={allNodes} currentKey={key} label={t("thenAdvanceTo")}
              onChange={(v) => onUpdateConfig({ routes: routes.map((x, j) => (j === i ? { ...x, next_node_key: v } : x)) })} />
            <Button type="button" variant="ghost" size="sm" aria-label={t("removeRow")} onClick={() => onUpdateConfig({ routes: routes.filter((_, j) => j !== i) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        {routes.length < MAX_ROUTES && (
          <Button type="button" variant="outline" size="sm" onClick={() => onUpdateConfig({ routes: [...routes, { status: "", next_node_key: "" }] })}>
            <Plus className="size-3.5" /> {t("addRoute")}
          </Button>
        )}
        <NextNodeRow value={cfg.fallback_next ?? ""} allNodes={allNodes} currentKey={key} label={t("apiFallback")}
          onChange={(v) => onUpdateConfig({ fallback_next: v })} />
        <p className={help}>{t("apiFallbackHelp")}</p>
      </fieldset>

      <div className="space-y-2">
        {sampleKeys.length > 0 && (
          <fieldset className="space-y-2">
            <legend className={label}>{t("testSamples")}</legend>
            {sampleKeys.map((k) => (
              <div key={k} className="grid grid-cols-[10rem_1fr] items-center gap-2">
                <label htmlFor={`sample-${key}-${k}`} className="truncate font-mono text-[11px] text-muted-foreground">{k}</label>
                <Input id={`sample-${key}-${k}`} value={samples[k] ?? ""} className="bg-muted text-xs"
                  onChange={(e) => setSamples((s) => ({ ...s, [k]: e.target.value }))} />
              </div>
            ))}
          </fieldset>
        )}
        <Button type="button" variant="outline" size="sm" onClick={runTest} disabled={testing || !cfg.url}>
          {testing && <Loader2 className="size-3.5 animate-spin" />} {t("testRequest")}
        </Button>
        {result && ("failed" in result ? (
          <p role="alert" className="text-xs text-red-500">{result.failed}</p>
        ) : (
          <div className="space-y-1 text-xs" data-testid="api-test-result">
            <p className="text-foreground">
              {result.status !== null ? t("testStatus", { status: result.status, ms: result.duration_ms }) : t(`testError_${result.error}`)}
            </p>
            {Object.keys(result.mapped).length > 0 && (
              <ul className="font-mono text-[11px] text-muted-foreground">
                {Object.entries(result.mapped).map(([k, v]) => <li key={k}>{`${k} = ${v}`}</li>)}
              </ul>
            )}
            {result.preview && <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px]">{result.preview}</pre>}
          </div>
        ))}
      </div>
    </>
  );
}

// ============================================================
// assign_agent and connect_flow
// ============================================================

export function AssignAgentForm({ node, allNodes, onUpdateConfig, t }: FormProps) {
  const cfg = node.config as { mode?: string; agent_id?: string; next_node_key?: string };
  const members = useAssignableMembers();
  const mode = cfg.mode ?? "round_robin";
  return (
    <>
      <div>
        <label htmlFor={`mode-${node.node_key}`} className={label}>{t("assignMode")}</label>
        <Select value={mode} onValueChange={(v) => onUpdateConfig(v === "round_robin" ? { mode: v, agent_id: undefined } : { mode: v })}>
          <SelectTrigger id={`mode-${node.node_key}`} className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="round_robin">{t("assignRoundRobin")}</SelectItem>
            <SelectItem value="specific">{t("assignSpecific")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {mode === "specific" && (
        <div>
          <label htmlFor={`agent-${node.node_key}`} className={label}>{t("assignAgent")}</label>
          <Select value={cfg.agent_id ?? ""} onValueChange={(agent_id) => onUpdateConfig({ agent_id })}>
            <SelectTrigger id={`agent-${node.node_key}`} className="bg-muted"><SelectValue placeholder={t("pickAgent")} /></SelectTrigger>
            <SelectContent>
              {members.map((m) => <SelectItem key={m.user_id} value={m.user_id}>{m.full_name || m.user_id}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <p className={help}>{t("assignHelp")}</p>
      <NextNodeRow value={cfg.next_node_key ?? ""} allNodes={allNodes} currentKey={node.node_key} label={t("thenAdvanceTo")}
        onChange={(v) => onUpdateConfig({ next_node_key: v })} />
    </>
  );
}

export function ConnectFlowForm({ node, onUpdateConfig, t }: FormProps) {
  const flows = useFlowList();
  const flowId = typeof node.config.flow_id === "string" ? node.config.flow_id : "";
  return (
    <div>
      <label htmlFor={`connect-${node.node_key}`} className={label}>{t("connectTarget")}</label>
      <Select value={flowId} onValueChange={(flow_id) => onUpdateConfig({ flow_id })}>
        <SelectTrigger id={`connect-${node.node_key}`} className="bg-muted"><SelectValue placeholder={t("pickFlow")} /></SelectTrigger>
        <SelectContent>
          {flows.map((f) => (
            <SelectItem key={f.id} value={f.id}>{f.name}{f.status !== "active" ? ` (${t(f.status === "draft" ? "flowStatusDraft" : f.status === "paused" ? "flowStatusPaused" : "flowStatusArchived")})` : ""}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className={help}>{t("connectHelp")}</p>
    </div>
  );
}
