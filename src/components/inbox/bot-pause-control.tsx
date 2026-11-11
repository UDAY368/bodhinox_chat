'use client'
// Pause or resume automated replies in a conversation (Stage 5: timed pauses).
// Paused: who paused, until when, and Resume. Not paused: a small "Pause
// automations" menu with the pause lengths, for this conversation or all of
// the contact's conversations. Writes go through POST /api/inbox/pause.
import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { PauseCircle } from 'lucide-react'
import { createClient } from '@/lib/data/client'
import { authFetch } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/use-auth'
import { PAUSE_MINUTES_CHOICES } from '@/lib/flows/types'
import { pauseActive } from '@/lib/inbox/pause-state'

interface PauseState {
  paused: boolean
  until: string | null
  by: string | null
}

async function loadPause(conversationId: string): Promise<PauseState | null> {
  const { data, error } = await createClient().from('conversations')
    .select('bot_paused,bot_paused_until,bot_paused_by').eq('id', conversationId).maybeSingle()
  if (error || !data) return null
  const row = data as { bot_paused?: boolean; bot_paused_until?: string | null; bot_paused_by?: string | null }
  const paused = pauseActive(row)
  return { paused, until: paused ? row.bot_paused_until ?? null : null, by: paused ? row.bot_paused_by ?? null : null }
}

async function loadMemberName(userId: string): Promise<string | null> {
  try {
    const res = await authFetch('/api/account/members', { cache: 'no-store' })
    if (!res.ok) return null
    const json = (await res.json()) as { members?: { user_id: string; full_name: string | null }[] }
    return json.members?.find((m) => m.user_id === userId)?.full_name?.trim() || null
  } catch {
    return null
  }
}

export function BotPauseControl({ conversationId, paused: initial }: { conversationId: string; paused: boolean }) {
  const t = useTranslations('Inbox.pause')
  const format = useFormatter()
  const { canSendMessages } = useAuth()
  const [state, setState] = useState<PauseState>({ paused: initial, until: null, by: null })
  const [byName, setByName] = useState<string | null>(null)
  const [wholeContact, setWholeContact] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadPause(conversationId).then((loaded) => { if (!cancelled && loaded) setState(loaded) }).catch(() => {})
    return () => { cancelled = true }
  }, [conversationId])

  useEffect(() => {
    let cancelled = false
    if (state.by) loadMemberName(state.by).then((name) => { if (!cancelled) setByName(name) })
    else setByName(null)
    return () => { cancelled = true }
  }, [state.by])

  // A timed pause ends by itself: hide it once its time has passed.
  useEffect(() => {
    if (!state.paused || !state.until) return
    const ms = new Date(state.until).getTime() - Date.now()
    if (!(ms > 0)) { setState({ paused: false, until: null, by: null }); return }
    const timer = setTimeout(() => setState({ paused: false, until: null, by: null }), Math.min(ms, 2_147_000_000))
    return () => clearTimeout(timer)
  }, [state.paused, state.until])

  const submit = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const res = await authFetch('/api/inbox/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, ...body }),
      })
      if (!res.ok) throw new Error('pause failed')
      const json = (await res.json()) as { paused: boolean; until: string | null; paused_by: string | null }
      setState({ paused: json.paused, until: json.until, by: json.paused_by })
    } catch {
      toast.error(t('failed'))
    } finally {
      setBusy(false)
    }
  }

  if (!state.paused) {
    if (!canSendMessages) return null
    return (
      <div className="flex items-center justify-end border-t px-4 py-1.5 text-sm">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs"
          >
            <PauseCircle className="size-3.5" aria-hidden />
            {t('pause')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {PAUSE_MINUTES_CHOICES.map((minutes) => (
                <DropdownMenuItem key={String(minutes)} onClick={() => submit({ action: 'pause', minutes, scope: wholeContact ? 'contact' : 'conversation' })}>
                  {t(`choices.${minutes === null ? 'forever' : String(minutes)}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={wholeContact} onCheckedChange={(checked) => setWholeContact(checked === true)}>
              {t('allConversations')}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  const who = state.by ? (byName ? t('pausedBy', { name: byName }) : t('paused')) : t('paused')
  const when = state.until
    ? t('until', { time: format.dateTime(new Date(state.until), { dateStyle: 'medium', timeStyle: 'short' }) })
    : t('untilResumed')
  return (
    <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-sm" role="status">
      <span className="flex min-w-0 items-center gap-2">
        <PauseCircle className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate">{who} · {when}</span>
      </span>
      <Button variant="outline" size="sm" disabled={busy || !canSendMessages}
        onClick={() => submit({ action: 'resume', scope: wholeContact ? 'contact' : 'conversation' })}>
        {t('resume')}
      </Button>
    </div>
  )
}
