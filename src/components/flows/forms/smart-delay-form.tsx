"use client";

/**
 * The Smart delay step (Stage 5), two tabs:
 * - Duration: a number and unit (or the number in a custom field), at most
 *   365 days.
 * - Date: a fixed date and time, or the date in a custom field plus or minus
 *   minutes; a date already past stops the automation there.
 * Optionally only continue within send hours and weekdays, in the step's time
 * zone (the workspace's when unset). On Instagram a wait that can pass 23
 * hours shows the 24-hour messaging-window warning: the send after it is
 * re-checked and dropped when the window has closed (5B).
 */

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { listTimeZones } from "@/lib/automations/time-of-day";
import { FLOW_STEP_LIMITS, type SendWindow, type SmartDelayUnit } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";
import { useCustomFields } from "./use-pickers";

type Patch = (patch: Record<string, unknown>) => void;
const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";
const UNITS: SmartDelayUnit[] = ["seconds", "minutes", "hours", "days"];
const UNIT_SECONDS: Record<SmartDelayUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
const WARN_SECONDS = 23 * 3600;
const NONE = "__none__";

/** Seconds a duration waits, or null when it is read from a field (unknown until the run). */
export function delaySeconds(cfg: Record<string, unknown>): number | null {
  if (cfg.mode === "until_date") return null;
  if (typeof cfg.amount_field_id === "string" && cfg.amount_field_id) return null;
  const amount = typeof cfg.amount === "number" && Number.isFinite(cfg.amount) ? cfg.amount : 0;
  const unit = (UNITS as string[]).includes(cfg.unit as string) ? (cfg.unit as SmartDelayUnit) : "hours";
  return amount * UNIT_SECONDS[unit];
}

/** Whether the duration is within 365 days (and not negative). */
export function delayWithinLimit(cfg: Record<string, unknown>): boolean {
  const seconds = delaySeconds(cfg);
  return seconds === null || (seconds >= 0 && seconds <= FLOW_STEP_LIMITS.smartDelayMaxDays * 86400);
}

/**
 * Whether the wait can pass 23 hours, so an Instagram send after it may find
 * the messaging window closed: a long duration, a field-driven one, any date,
 * or a send window that can hold the run over.
 */
export function mayOutlastWindow(cfg: Record<string, unknown>): boolean {
  const seconds = delaySeconds(cfg);
  return seconds === null || seconds > WARN_SECONDS || !!cfg.send_window;
}

const readWindow = (value: unknown): SendWindow | null => {
  const w = value as SendWindow | null;
  return w && typeof w === "object" && typeof w.from === "string" && typeof w.to === "string" && Array.isArray(w.weekdays) ? w : null;
};

/** `datetime-local` value (local wall time) for an ISO date, and back. */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function SmartDelayForm({ node, allNodes, onUpdateConfig, instagram }: {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: Patch;
  instagram: boolean;
}) {
  const t = useTranslations("Flows.nodes.smartDelay");
  const tf = useTranslations("Flows.builder.form");
  const fields = useCustomFields();
  const cfg = node.config;
  const mode = cfg.mode === "until_date" ? "until_date" : "duration";
  const unit = (UNITS as string[]).includes(cfg.unit as string) ? (cfg.unit as SmartDelayUnit) : "hours";
  const amountField = typeof cfg.amount_field_id === "string" ? cfg.amount_field_id : "";
  const dateField = typeof cfg.date_field_id === "string" ? cfg.date_field_id : "";
  const sendWindow = readWindow(cfg.send_window);
  const id = (s: string) => `delay-${node.node_key}-${s}`;
  const tab = (value: "duration" | "until_date", text: string) => (
    <button type="button" role="tab" aria-selected={mode === value} onClick={() => onUpdateConfig(value === "duration"
      ? { mode: value, date: undefined, date_field_id: undefined, offset_minutes: undefined, amount: typeof cfg.amount === "number" ? cfg.amount : 1, unit }
      : { mode: value, amount: undefined, unit: undefined, amount_field_id: undefined })}
      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${mode === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
      {text}
    </button>
  );
  return (
    <>
      <p className="text-xs font-medium text-foreground">{t("title")}</p>
      <div role="tablist" className="flex gap-0.5 rounded-lg border border-border bg-muted p-0.5">
        {tab("duration", t("duration"))}
        {tab("until_date", t("untilDate"))}
      </div>

      {mode === "duration" ? (
        <div className="space-y-2">
          <label htmlFor={id("amount")} className={label}>{t("waitFor")}</label>
          <div className="flex gap-2">
            <Input id={id("amount")} type="number" inputMode="numeric" min={0} disabled={!!amountField}
              value={typeof cfg.amount === "number" ? String(cfg.amount) : ""} className="bg-muted"
              onChange={(e) => onUpdateConfig({ amount: e.target.value === "" ? undefined : Math.max(0, Math.trunc(Number(e.target.value))) })} />
            <Select value={unit} onValueChange={(u) => onUpdateConfig({ unit: u })}>
              <SelectTrigger className="w-32 bg-muted" aria-label={tf("delayUnit")}><SelectValue /></SelectTrigger>
              <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{tf(`unit_${u}`)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor={id("amount-field")} className={label}>{t("fromField")}</label>
            <Select value={amountField || NONE} onValueChange={(v) => onUpdateConfig({ amount_field_id: v === NONE ? undefined : v })}>
              <SelectTrigger id={id("amount-field")} className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{tf("none")}</SelectItem>
                {fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.field_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!delayWithinLimit(cfg) && <p className="text-[10px] text-amber-500">{t("max")}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <label htmlFor={id("date-field")} className={label}>{t("dynamicDate")}</label>
            <Select value={dateField || NONE} onValueChange={(v) => onUpdateConfig(v === NONE ? { date_field_id: undefined } : { date_field_id: v, date: undefined })}>
              <SelectTrigger id={id("date-field")} className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("specificDate")}</SelectItem>
                {fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.field_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {dateField ? (
            <div>
              <label htmlFor={id("offset")} className={label}>{t("offset")}</label>
              <Input id={id("offset")} type="number" inputMode="numeric" value={typeof cfg.offset_minutes === "number" ? String(cfg.offset_minutes) : ""}
                onChange={(e) => onUpdateConfig({ offset_minutes: e.target.value === "" ? undefined : Math.trunc(Number(e.target.value)) })} className="bg-muted" />
            </div>
          ) : (
            <div>
              <label htmlFor={id("date")} className={label}>{t("specificDate")}</label>
              <Input id={id("date")} type="datetime-local" value={toLocalInput(cfg.date)} onChange={(e) => onUpdateConfig({ date: fromLocalInput(e.target.value) })} className="bg-muted" />
            </div>
          )}
          <p className={help}>{t("pastDate")}</p>
        </div>
      )}

      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id("window")} className="text-xs text-foreground">{t("sendWindow")}</label>
          <Switch id={id("window")} checked={!!sendWindow}
            onCheckedChange={(on) => onUpdateConfig({ send_window: on ? { from: "09:00", to: "18:00", weekdays: [1, 2, 3, 4, 5] } : undefined })} />
        </div>
        {sendWindow && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={id("from")} className={label}>{t("from")}</label>
                <Input id={id("from")} type="time" value={sendWindow.from} onChange={(e) => onUpdateConfig({ send_window: { ...sendWindow, from: e.target.value } })} className="bg-muted" />
              </div>
              <div>
                <label htmlFor={id("to")} className={label}>{t("to")}</label>
                <Input id={id("to")} type="time" value={sendWindow.to} onChange={(e) => onUpdateConfig({ send_window: { ...sendWindow, to: e.target.value } })} className="bg-muted" />
              </div>
            </div>
            <fieldset>
              <legend className={label}>{t("weekdays")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                  const on = sendWindow.weekdays.includes(day);
                  const name = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + day)));
                  return (
                    <button key={day} type="button" aria-pressed={on}
                      onClick={() => onUpdateConfig({ send_window: { ...sendWindow, weekdays: on ? sendWindow.weekdays.filter((d) => d !== day) : [...sendWindow.weekdays, day].sort() } })}
                      className={`rounded-md border px-2 py-1 text-[11px] ${on ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground"}`}>
                      {name}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div>
              <label htmlFor={id("tz")} className={label}>{t("timezone")}</label>
              <Select value={typeof cfg.timezone === "string" && cfg.timezone ? cfg.timezone : NONE} onValueChange={(v) => onUpdateConfig({ timezone: v === NONE ? undefined : v })}>
                <SelectTrigger id={id("tz")} className="bg-muted"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tf("none")}</SelectItem>
                  {listTimeZones(typeof cfg.timezone === "string" ? cfg.timezone : undefined).map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      {instagram && mayOutlastWindow(cfg) && (
        <p role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">{t("instagramWarning")}</p>
      )}
      <NextNodeRow value={typeof cfg.next_node_key === "string" ? cfg.next_node_key : ""} allNodes={allNodes} currentKey={node.node_key}
        onChange={(v) => onUpdateConfig({ next_node_key: v })} label={tf("thenAdvanceTo")} />
    </>
  );
}
