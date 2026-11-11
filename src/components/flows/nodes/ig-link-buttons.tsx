"use client";

/**
 * Instagram-only link buttons on a "Buttons" step (`send_buttons.link_buttons`):
 * each opens an https link and does not continue the flow (a link tap never
 * reaches the webhook or opens the 24-hour window). Reply buttons plus link
 * buttons stay within Instagram's 3 per message. Shown only in an Instagram
 * flow; a WhatsApp flow never carries them.
 */

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INSTAGRAM_LIMITS, validHttpsUrl } from "@/lib/instagram/graph-limits";
import { addLinkButton, canAddButton, clipChars, MAX_BUTTONS, readLinkButtons, type LinkButton } from "./ig-node-config";

export function IgLinkButtons({ value, replyButtons, onChange, removeLabel }: {
  value: unknown;
  /** How many reply buttons the step has (they share the 3-button limit). */
  replyButtons: number;
  onChange: (links: LinkButton[] | undefined) => void;
  removeLabel: string;
}) {
  const tb = useTranslations("Flows.nodes.buttons");
  const tc = useTranslations("Flows.nodes.card");
  const links = readLinkButtons(value);
  const set = (next: LinkButton[]) => onChange(next.length ? next : undefined);
  return (
    <fieldset>
      <legend className="text-muted-foreground mb-1 block text-xs">{tb("linkButtons")}</legend>
      <div className="flex flex-col gap-2">
        {links.map((link, i) => {
          const bad = link.url !== "" && !validHttpsUrl(link.url);
          return (
            <div key={i} className="border-border bg-muted/40 grid grid-cols-1 gap-2 rounded-md border p-2 md:grid-cols-[1fr_1.5fr_auto]">
              <Input value={link.title} aria-label={tc("buttonTitle")} placeholder={tc("buttonTitle")} className="bg-muted"
                onChange={(e) => set(links.map((l, j) => (j === i ? { ...l, title: clipChars(e.target.value, INSTAGRAM_LIMITS.buttonTitleChars) } : l)))} />
              <div>
                <Input type="url" inputMode="url" value={link.url} aria-label={tc("buttonUrl")} placeholder="https://" className="bg-muted"
                  aria-invalid={bad || undefined} maxLength={INSTAGRAM_LIMITS.urlChars}
                  onChange={(e) => set(links.map((l, j) => (j === i ? { ...l, url: e.target.value.trim() } : l)))} />
                {bad && <p className="mt-1 text-[10px] text-amber-500">{tc("urlInvalid")}</p>}
              </div>
              <Button type="button" variant="ghost" size="sm" aria-label={removeLabel} onClick={() => set(links.filter((_, j) => j !== i))}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          );
        })}
      </div>
      {canAddButton(replyButtons, links.length) ? (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => set(addLinkButton(links, replyButtons))}>
          <Plus className="mr-1 h-3.5 w-3.5" />{tb("addLinkButton")}
        </Button>
      ) : (
        <p className="text-muted-foreground mt-1 text-[10px]">{tb("maxButtons", { max: MAX_BUTTONS })}</p>
      )}
      <p className="text-muted-foreground mt-1 text-[10px]">{tb("linkButtonsHelp")}</p>
    </fieldset>
  );
}
