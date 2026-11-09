"use client";

/**
 * Form for the book_appointment step: which services to offer (none = every
 * bookable one), online/offline, the location, whether the customer picks
 * the practitioner, how many days to look ahead, and where the run goes when
 * the time is booked, nothing can be booked, or the customer cancels. The
 * step waits for replies, so its reply timeout lives here too (the shared
 * TimingFields only knows the older waiting steps). Mounted by NodeConfigForm.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import { BOOK_APPOINTMENT_LIMITS } from "@/lib/flows/appointment-node";
import type { BookAppointmentNodeConfig, NodeTiming } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

type T = ReturnType<typeof useTranslations>;
type Patch = (patch: Record<string, unknown>) => void;

const label = "mb-1 block text-xs text-muted-foreground";
const help = "mt-1 text-[10px] text-muted-foreground";
const ANY = "__any";

interface Choice {
  id: string;
  name: string;
  archived_at?: string | null;
  /** Services only: paid services cannot be booked from a flow (audit finding 21). */
  payment_required?: boolean;
}

/** Live services and locations for the pickers; empty when the plan has no appointments or the load fails. */
function useAppointmentChoices(path: "services" | "locations"): Choice[] {
  const [items, setItems] = useState<Choice[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/appointments/${path}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as Record<string, unknown>;
        const list = Array.isArray(body[path]) ? (body[path] as Choice[]) : [];
        if (!cancelled) setItems(list.filter((c) => typeof c.id === "string" && !c.archived_at));
      } catch {
        // Leave the picker empty; the step still offers every service.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);
  return items;
}

export function BookAppointmentForm({ node, allNodes, onUpdateConfig, t }: { node: BuilderNode; allNodes: BuilderNode[]; onUpdateConfig: Patch; t: T }) {
  const ta = useTranslations("Flows.builder.appointment");
  const tp = useTranslations("Flows.builder.ports");
  const cfg = node.config as unknown as Partial<BookAppointmentNodeConfig> & NodeTiming;
  const services = useAppointmentChoices("services");
  const locations = useAppointmentChoices("locations");
  const id = (field: string) => `appointment-${node.node_key}-${field}`;
  const picked = Array.isArray(cfg.service_ids) ? cfg.service_ids : [];
  const toggle = (serviceId: string, on: boolean) => {
    const next = on ? [...picked, serviceId] : picked.filter((s) => s !== serviceId);
    onUpdateConfig({ service_ids: next.slice(0, BOOK_APPOINTMENT_LIMITS.maxServices) });
  };
  const port = (field: "success_next" | "unavailable_next" | "cancelled_next", key: string) => (
    <NextNodeRow
      label={tp(key)}
      value={cfg[field] ?? ""}
      allNodes={allNodes}
      currentKey={node.node_key}
      onChange={(v) => onUpdateConfig({ [field]: v })}
    />
  );
  return (
    <>
      <fieldset>
        <legend className={label}>{ta("services")}</legend>
        {services.length === 0 ? (
          <p className={help}>{ta("noServices")}</p>
        ) : (
          <div className="space-y-1.5">
            {services.map((s) => {
              const checked = picked.includes(s.id);
              const paid = s.payment_required === true;
              // A paid service can be unticked (publishing refuses it) but never newly picked.
              return (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    disabled={!checked && (paid || picked.length >= BOOK_APPOINTMENT_LIMITS.maxServices)}
                    onCheckedChange={(on) => toggle(s.id, on === true)}
                  />
                  <span className="truncate">{s.name}</span>
                  {paid && <span className="shrink-0 text-[10px] text-muted-foreground">{ta("paidServiceNote")}</span>}
                </label>
              );
            })}
          </div>
        )}
        <p className={help}>{ta("servicesAllHelp", { max: BOOK_APPOINTMENT_LIMITS.maxServices })}</p>
      </fieldset>
      <div>
        <label htmlFor={id("mode")} className={label}>{ta("serviceMode")}</label>
        <Select
          value={cfg.service_mode ?? ANY}
          onValueChange={(v) => onUpdateConfig({ service_mode: v === ANY ? undefined : v })}
        >
          <SelectTrigger id={id("mode")} className="w-full bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{ta("modeBoth")}</SelectItem>
            <SelectItem value="online">{ta("modeOnline")}</SelectItem>
            <SelectItem value="offline">{ta("modeOffline")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label htmlFor={id("location")} className={label}>{ta("location")}</label>
        <Select
          value={cfg.location_id || ANY}
          onValueChange={(v) => onUpdateConfig({ location_id: v === ANY ? undefined : v })}
        >
          <SelectTrigger id={id("location")} className="w-full bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{ta("anyLocation")}</SelectItem>
            {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
            {cfg.location_id && !locations.some((l) => l.id === cfg.location_id) && (
              <SelectItem value={cfg.location_id}>{cfg.location_id.slice(0, 8)}…</SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label htmlFor={id("staff")} className={label}>{ta("staffMode")}</label>
        <Select value={cfg.staff_mode ?? "any"} onValueChange={(v) => onUpdateConfig({ staff_mode: v })}>
          <SelectTrigger id={id("staff")} className="w-full bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{ta("staffAny")}</SelectItem>
            <SelectItem value="choose">{ta("staffChoose")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label htmlFor={id("days")} className={label}>{ta("daysAhead")}</label>
        <Input
          id={id("days")}
          type="number"
          inputMode="numeric"
          min={BOOK_APPOINTMENT_LIMITS.daysMin}
          max={BOOK_APPOINTMENT_LIMITS.daysMax}
          value={typeof cfg.days_ahead === "number" ? String(cfg.days_ahead) : ""}
          placeholder={String(BOOK_APPOINTMENT_LIMITS.defaultDays)}
          onChange={(e) => {
            const n = Number(e.target.value);
            onUpdateConfig({ days_ahead: e.target.value === "" || !Number.isFinite(n) ? undefined : Math.trunc(n) });
          }}
          className="bg-muted"
        />
        <p className={help}>{ta("daysAheadHelp")}</p>
      </div>
      {port("success_next", "success")}
      {port("unavailable_next", "unavailable")}
      {port("cancelled_next", "cancelled")}
      <p className={help}>{ta("variablesHelp")}</p>
      <div>
        <label htmlFor={id("timeout")} className={label}>{t("timeoutLabel")}</label>
        <Input
          id={id("timeout")}
          type="number"
          inputMode="numeric"
          min={1}
          max={10080}
          value={typeof cfg.timeout_minutes === "number" ? String(cfg.timeout_minutes) : ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            const timeout_minutes = e.target.value === "" || !Number.isFinite(n) ? undefined : Math.trunc(n);
            onUpdateConfig(timeout_minutes === undefined ? { timeout_minutes, after_timeout: undefined } : { timeout_minutes });
          }}
          className="bg-muted"
        />
        <p className={help}>{t("timeoutHelp")}</p>
      </div>
      {typeof cfg.timeout_minutes === "number" && (
        <NextNodeRow
          label={t("afterTimeoutLabel")}
          value={cfg.after_timeout ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ after_timeout: v })}
        />
      )}
    </>
  );
}
