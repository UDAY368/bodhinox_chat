"use client";

// An Android-style phone frame for Instagram previews: a single front camera
// in the status bar, Android status icons, and the gesture bar at the bottom.
// The screen is always dark (Instagram's dark theme), whatever the app theme,
// because it shows what a customer's phone looks like; the frame itself uses
// the app's border tokens. Drawn here: no third-party device artwork.

import type { ReactNode } from "react";
import { BatteryFull, SignalHigh, Wifi } from "lucide-react";

import { cn } from "@/lib/utils";

/** The hh:mm on the status bar, in the viewer's locale and 24-hour form like most Android phones. */
function clock(now: Date): string {
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function AndroidPhone({ header, children, footer, className, label }: {
  /** The app bar under the status bar (back arrow, title). */
  header?: ReactNode;
  children: ReactNode;
  /** Pinned above the gesture bar (a message box, for example). */
  footer?: ReactNode;
  className?: string;
  /** The accessible name of the preview. */
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("border-border mx-auto w-full max-w-[18rem] rounded-[2.25rem] border-[6px] bg-neutral-900 p-1 shadow-md", className)}>
      <div className="flex h-[30rem] flex-col overflow-hidden rounded-[1.75rem] bg-black text-white">
        <div className="relative flex h-7 shrink-0 items-center justify-between px-5 text-[11px] font-medium" aria-hidden>
          <span suppressHydrationWarning>{clock(new Date())}</span>
          <span className="absolute top-1.5 left-1/2 size-3 -translate-x-1/2 rounded-full bg-neutral-800 ring-1 ring-neutral-700" />
          <span className="flex items-center gap-1">
            <Wifi className="size-3" />
            <SignalHigh className="size-3" />
            <BatteryFull className="size-3.5" />
          </span>
        </div>
        {header && <div className="shrink-0 border-b border-white/10">{header}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0">{footer}</div>}
        <div className="flex h-5 shrink-0 items-center justify-center" aria-hidden>
          <span className="h-1 w-24 rounded-full bg-white/60" />
        </div>
      </div>
    </div>
  );
}
