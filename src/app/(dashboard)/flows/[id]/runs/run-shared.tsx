"use client";

// Shared by the run history and run detail pages.
import { format } from "date-fns";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  PauseCircle,
  PlayCircle,
  UserPlus,
} from "lucide-react";

import { cn } from "@/lib/utils";

export interface RunRow {
  id: string;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "cancelled"
    | "failed";
  current_node_key: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  flow_version_id: string | null;
  version: number | null;
  contact: { id: string; name: string | null; phone: string } | null;
}

export const RUN_STATUSES: RunRow["status"][] = ["active", "completed", "handed_off", "timed_out", "paused_by_agent", "cancelled", "failed"];

export function runStatusKey(status: RunRow["status"]): string {
  return status === "active"
    ? "statusActive"
    : status === "completed"
    ? "statusCompleted"
    : status === "handed_off"
    ? "statusHandedOff"
    : status === "timed_out"
    ? "statusTimedOut"
    : status === "paused_by_agent"
    ? "statusPaused"
    : status === "cancelled"
    ? "statusCancelled"
    : "statusFailed";
}

export interface EventRow {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export const STATUS_META: Record<
  RunRow["status"],
  { classes: string; icon: typeof Clock }
> = {
  active: {
    classes: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
    icon: PlayCircle,
  },
  completed: {
    classes: "border-border bg-muted text-muted-foreground",
    icon: CircleCheck,
  },
  handed_off: {
    classes: "border-amber-600/40 bg-amber-500/10 text-amber-300",
    icon: UserPlus,
  },
  timed_out: {
    classes: "border-border bg-muted/60 text-muted-foreground",
    icon: Clock,
  },
  paused_by_agent: {
    classes: "border-border bg-muted text-muted-foreground",
    icon: PauseCircle,
  },
  failed: {
    classes: "border-red-600/40 bg-red-500/10 text-red-300",
    icon: CircleAlert,
  },
  cancelled: {
    classes: "border-border bg-muted text-muted-foreground",
    icon: PauseCircle,
  },
};

const EVENT_COLOR: Record<string, string> = {
  started: "text-emerald-300",
  node_entered: "text-muted-foreground",
  message_sent: "text-sky-300",
  reply_received: "text-primary",
  fallback_fired: "text-amber-300",
  handoff: "text-amber-300",
  timeout: "text-muted-foreground",
  error: "text-red-300",
  completed: "text-emerald-300",
  delay_scheduled: "text-sky-300",
  input_invalid: "text-amber-300",
  attribute_set: "text-muted-foreground",
  migrated: "text-sky-300",
  replayed: "text-amber-300",
};

export function EventLine({ ev }: { ev: EventRow }) {
  const cls = EVENT_COLOR[ev.event_type] ?? "text-muted-foreground";
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1 text-xs">
      <span className="w-32 shrink-0 text-[10px] text-muted-foreground">
        {format(new Date(ev.created_at), "HH:mm:ss")}
      </span>
      <span className={cn("w-32 shrink-0 font-mono text-[10px]", cls)}>
        {ev.event_type}
      </span>
      {ev.node_key && (
        <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          {ev.node_key}
        </code>
      )}
      {Object.keys(ev.payload).length > 0 && (
        <span className="min-w-0 break-words text-[10px] text-muted-foreground">
          {summarizePayload(ev.payload)}
        </span>
      )}
    </div>
  );
}

function summarizePayload(payload: Record<string, unknown>): string {
  // Show the keys that matter most to a human debugger; full JSON is
  // available via the "Captured vars" details panel for the run.
  const keys = ["reply_id", "captured_key", "reason", "advancing_to"];
  for (const k of keys) {
    if (k in payload && payload[k] !== null && payload[k] !== undefined) {
      // An error's detail (e.g. Meta's reason for refusing a send) is what explains it.
      const detail = k === "reason" && typeof payload.detail === "string" && payload.detail ? ` — ${payload.detail.slice(0, 300)}` : "";
      return `${k}=${String(payload[k]).slice(0, 80)}${detail}`;
    }
  }
  return "";
}
