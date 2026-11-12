"use client";

/**
 * The message step's editor drawn as the message itself (ManyChat-style):
 * one grey bubble holding the text composer and the footnote, with the reply
 * buttons or list options hanging under it as white rows. Each row's title is
 * edited in place; its ">" cell opens where the button leads, plus removal
 * and the reply id under Advanced. A dashed "+ Add …" closes the bubble.
 *
 * Also the "Send within 24 hour window" line: WhatsApp allows a regular
 * message only within 24 hours of the customer's last message, so a text
 * step can switch to an approved template (and back) in place.
 */

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleHelp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { slugify, type BuilderNode } from "../shared";
import { NodeKeySelect } from "./fields";

/** The bubble: a grey block whose rows sit flush under its text. */
export function MessageBubble({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-bubble="" className={cn("overflow-hidden rounded-[15px] border border-border bg-muted transition-shadow focus-within:ring-2 focus-within:ring-primary/30", className)}>
      {children}
    </div>
  );
}

/** A one-line field inside the bubble (the footnote, a list's button title). */
export function BubbleInput({ label, value, onChange, placeholder, maxLength, className, icon }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <label className={cn("flex items-center gap-2 border-t border-border px-3.5", className)}>
      <span className="sr-only">{label}</span>
      {icon}
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength}
        className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground" />
    </label>
  );
}

/**
 * One reply button or list option under the bubble. The title is edited in
 * place (centered, like the customer sees it); ">" opens its settings.
 */
export function ReplyRow({ title, onTitle, titleLabel, maxLength, next, onNext, onRemove, replyId, onReplyId, showAdvanced, allNodes, currentKey, removeLabel, extra }: {
  title: string;
  onTitle: (title: string) => void;
  titleLabel: string;
  maxLength: number;
  next: string;
  onNext: (key: string) => void;
  onRemove?: () => void;
  replyId: string;
  onReplyId: (id: string) => void;
  showAdvanced: boolean;
  allNodes: BuilderNode[];
  currentKey: string;
  removeLabel: string;
  /** More settings in the popover (a list option's description). */
  extra?: ReactNode;
}) {
  const tc = useTranslations("Flows.builder.composer");
  const target = next ? allNodes.find((n) => n.node_key === next) : undefined;
  const nextId = useId();
  // Controlled, so removing the row closes its settings instead of leaving them open on the next row.
  const [open, setOpen] = useState(false);
  const status = target ? tc("goesTo", { step: target.node_key }) : tc("notConnected");
  return (
    <div className="flex items-stretch border-t border-border bg-card" data-reply-row="">
      <input value={title} onChange={(e) => onTitle(e.target.value)} maxLength={maxLength} aria-label={titleLabel} placeholder={titleLabel}
        className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-center text-sm font-medium text-primary outline-none placeholder:text-primary/40 focus:bg-primary/5" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger aria-label={tc("rowSettings", { title: title || titleLabel })} title={status} data-connected={target ? "" : undefined}
          className={cn("flex w-12 shrink-0 items-center justify-center border-l border-border transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
            target ? "text-primary" : "text-primary/45")}>
          <ChevronRight className="h-4 w-4" />
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-72 flex-col gap-3 p-3">
          <div>
            <label htmlFor={nextId} className="mb-1 block text-xs font-medium">{tc("whenPressed")}</label>
            <NodeKeySelect id={nextId} value={next || null} nodes={allNodes} excludeKey={currentKey} onChange={(key) => onNext(key ?? "")} />
          </div>
          {extra}
          {showAdvanced && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {tc("replyId")}
                <Input value={replyId} onChange={(e) => onReplyId(slugify(e.target.value, replyId))} className="bg-muted mt-1 font-mono text-xs" />
              </label>
            </div>
          )}
          {onRemove && (
            <Button variant="ghost" size="sm" onClick={() => { setOpen(false); onRemove(); }} className="self-start text-red-500 hover:bg-red-500/10 hover:text-red-500">
              <Trash2 className="h-3.5 w-3.5" />{removeLabel}
            </Button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The dashed "+ Add …" that closes a bubble. */
export function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex w-full items-center justify-center gap-1.5 border-t border-dashed border-border bg-card/40 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
      <Plus className="h-3.5 w-3.5" />{label}
    </button>
  );
}

// ------------------------------------------------------------ 24-hour window

/** What switching a step across the 24-hour window turns it into, or null when it cannot switch. */
export function switchSendWindow(node: BuilderNode, outside: boolean): Partial<BuilderNode> | null {
  const next = typeof node.config.next_node_key === "string" ? node.config.next_node_key : "";
  // The typing delay belongs to the step, not its kind: it carries across.
  const timing = typeof node.config.delay_seconds === "number" ? { delay_seconds: node.config.delay_seconds } : {};
  if (outside && node.node_type === "send_message") {
    return { node_type: "send_template", config: { template_name: "", body_params: [], buttons: [], next_node_key: next, ...timing } };
  }
  // A template whose quick replies route to steps would lose those routes: it stays.
  const routed = Array.isArray(node.config.buttons) && node.config.buttons.length > 0;
  if (!outside && node.node_type === "send_template" && !routed) {
    return { node_type: "send_message", config: { text: "", next_node_key: next, ...timing } };
  }
  return null;
}

/** The WhatsApp message steps the line is shown on. */
export const WINDOW_STEPS = new Set(["send_message", "send_buttons", "send_list", "send_template"]);

export function SendWindowLine({ node, onSwitch }: { node: BuilderNode; onSwitch: (patch: Partial<BuilderNode>) => void }) {
  const tc = useTranslations("Flows.builder.composer");
  const outside = node.node_type === "send_template";
  const toOther = switchSendWindow(node, !outside);
  return (
    <div className="flex flex-wrap items-center gap-1 text-sm" data-testid="send-window">
      <span>{tc("send")}</span>
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex items-center gap-0.5 border-b border-primary/40 font-medium text-primary transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
          {outside ? tc("windowOutside") : tc("windowWithin")}
          <ChevronDown className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem disabled={!outside || !toOther} onClick={() => toOther && outside && onSwitch(toOther)}>
            <span className="flex flex-col">
              <span>{tc("windowWithin")}</span>
              <span className="text-muted-foreground text-xs">{outside && !toOther ? tc("keepTemplateRoutes") : tc("withinHelp")}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={outside || !toOther} onClick={() => toOther && !outside && onSwitch(toOther)}>
            <span className="flex flex-col">
              <span>{tc("windowOutside")}</span>
              <span className="text-muted-foreground text-xs">{!outside && !toOther ? tc("onlyPlainText") : tc("outsideHelp")}</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-muted-foreground inline-flex" title={tc("windowHelp")}>
        <CircleHelp className="h-4 w-4" aria-hidden />
        <span className="sr-only">{tc("windowHelp")}</span>
      </span>
    </div>
  );
}
