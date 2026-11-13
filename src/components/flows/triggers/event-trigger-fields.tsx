"use client";

/**
 * Settings for the automation list's event triggers: a new contact's first
 * message (no settings), a tag added to the contact (which tag), and a message
 * outside working hours (how often). The publish validator checks the same
 * settings on the server.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadFlowTags, type FlowTag } from "../load-tags";
import { FrequencyField } from "./ig-trigger-fields";

type Config = Record<string, unknown>;
type Props = { config: Config; onChange: (c: Config) => void };
const label = "text-muted-foreground mb-1 block text-xs";
const help = "text-muted-foreground mt-1 text-[10px]";

export function ContactCreatedTriggerFields() {
  const t = useTranslations("Flows.triggers.contactCreated");
  return <p className="text-muted-foreground text-xs md:col-span-2">{t("help")}</p>;
}

export function TagAddedTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.tagAdded");
  const [tags, setTags] = useState<FlowTag[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadFlowTags().then((list) => { if (live) setTags(list); });
    return () => { live = false; };
  }, []);
  const value = typeof config.tag_id === "string" ? config.tag_id : "";
  return (
    <div className="space-y-3 md:col-span-2">
      <p className="text-muted-foreground text-xs">{t("help")}</p>
      <div className="max-w-xs">
        <label htmlFor="trigger-tag" className={label}>{t("tag")}</label>
        <Select value={value || undefined} onValueChange={(tagId) => onChange({ ...config, tag_id: tagId })} disabled={!tags?.length}>
          <SelectTrigger id="trigger-tag" className="bg-muted">
            <SelectValue placeholder={tags === null ? t("loading") : tags.length ? t("pick") : t("none")} />
          </SelectTrigger>
          <SelectContent>
            {(tags ?? []).map((tag) => <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>)}
            {value && tags && !tags.some((tag) => tag.id === value) && <SelectItem value={value}>{t("missing")}</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      <p className={help}>{t("conversationNote")}</p>
    </div>
  );
}

export function OutsideHoursTriggerFields({ config, onChange }: Props) {
  const t = useTranslations("Flows.triggers.outsideHours");
  return (
    <div className="space-y-3 md:col-span-2">
      <p className="text-muted-foreground text-xs">
        {t.rich("help", { link: (chunks) => <Link href="/settings?tab=inbox" className="text-primary underline-offset-2 hover:underline">{chunks}</Link> })}
      </p>
      <div className="max-w-xs"><FrequencyField id="trigger-frequency" config={config} onChange={onChange} /></div>
      <p className={help}>{t("noHours")}</p>
    </div>
  );
}
