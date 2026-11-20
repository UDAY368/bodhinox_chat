"use client"

/**
 * Confirming (Apple's way): a sheet with the risky choice in red, never the browser's confirm().
 * A bottom sheet on phones, a centred dialog from 640px up.
 *
 * Two ways to use it:
 * - <ConfirmDialog open onOpenChange title onConfirm /> when the page owns the state. While
 *   onConfirm's promise runs both buttons are disabled; on success the sheet closes, on failure it
 *   stays open (onConfirm should show its own error).
 * - const confirm = useConfirm(); if (await confirm({ title, destructive: true })) { ... } anywhere
 *   under <ConfirmProvider> (mounted once in the dashboard shell).
 */

import * as React from "react"
import { AlertDialog } from "@base-ui/react/alert-dialog"
import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export type ConfirmOptions = {
  title: string
  body?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export type ConfirmDialogProps = ConfirmOptions & {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useTranslations("UiKit")
  const [busy, setBusy] = React.useState(false)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const confirmRef = React.useRef<HTMLButtonElement>(null)

  const handleConfirm = async () => {
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 transition-opacity duration-(--motion-base) ease-(--motion-ease-out) data-ending-style:opacity-0 data-starting-style:opacity-0"
        />
        <AlertDialog.Popup
          data-slot="confirm-dialog"
          initialFocus={destructive ? cancelRef : confirmRef}
          className={cn(
            "material-sheet fixed z-50 flex flex-col gap-4 border border-border p-5 text-popover-foreground shadow-[0_24px_80px_rgb(0_0_0/0.22)] outline-none transition duration-(--motion-base) ease-(--motion-ease-out) data-ending-style:opacity-0 data-starting-style:opacity-0",
            // Phones: a bottom sheet.
            "inset-x-0 bottom-0 rounded-t-sheet pb-[max(1.25rem,env(safe-area-inset-bottom))] data-ending-style:translate-y-full data-starting-style:translate-y-full",
            // 640px up: a centred dialog.
            "sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-sheet sm:pb-5 sm:data-ending-style:-translate-y-1/2 sm:data-ending-style:scale-95 sm:data-starting-style:-translate-y-1/2 sm:data-starting-style:scale-95"
          )}
        >
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className="text-headline text-foreground">{title}</AlertDialog.Title>
            {body ? (
              <AlertDialog.Description render={<div />} className="text-callout text-muted-foreground">
                {body}
              </AlertDialog.Description>
            ) : null}
          </div>
          {/* Cancel first in the DOM (focus order); on phones the risky choice sits on top. */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              ref={cancelRef}
              variant="outline"
              size="lg"
              className="sm:h-8 sm:px-3.5"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel ?? t("cancel")}
            </Button>
            <Button
              ref={confirmRef}
              variant={destructive ? "destructive" : "default"}
              size="lg"
              className={cn(
                "sm:h-8 sm:px-3.5",
                destructive && "bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90"
              )}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={handleConfirm}
            >
              {busy ? <Loader2Icon className="animate-spin" aria-hidden /> : null}
              {busy ? <span className="sr-only">{t("working")}</span> : null}
              {confirmLabel ?? t("confirm")}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = React.createContext<ConfirmFn | null>(null)

/** Mount once (the dashboard shell); useConfirm() then works anywhere below it. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{ options: ConfirmOptions; open: boolean } | null>(null)
  const resolver = React.useRef<((value: boolean) => void) | null>(null)

  const settle = React.useCallback((value: boolean) => {
    resolver.current?.(value)
    resolver.current = null
  }, [])

  const confirm = React.useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        settle(false) // a second request cancels a pending one
        resolver.current = resolve
        setState({ options, open: true })
      }),
    [settle]
  )

  // Never leave a caller awaiting forever if the provider goes away.
  React.useEffect(() => () => settle(false), [settle])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        title=""
        {...state?.options}
        open={state?.open ?? false}
        onOpenChange={(open) => {
          if (open) return
          settle(false)
          // Keep the options while the sheet animates out.
          setState((current) => (current ? { ...current, open: false } : current))
        }}
        onConfirm={() => settle(true)}
      />
    </ConfirmContext.Provider>
  )
}

/** `await confirm({ title, body, destructive })` resolves true on confirm, false on cancel or dismiss. */
export function useConfirm(): ConfirmFn {
  const confirm = React.useContext(ConfirmContext)
  if (!confirm) {
    throw new Error("useConfirm must be used inside <ConfirmProvider> (mounted in the dashboard shell).")
  }
  return confirm
}
