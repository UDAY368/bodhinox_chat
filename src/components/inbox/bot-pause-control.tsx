'use client'
import { useState } from 'react'
import { createClient } from '@/lib/data/client'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/use-auth'
export function BotPauseControl({ conversationId, paused: initial }: { conversationId: string; paused: boolean }) {
  const { canSendMessages } = useAuth()
  const [paused, setPaused] = useState(initial)
  const [busy, setBusy] = useState(false)
  if (!paused) return null
  return <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-sm"><span>Bot replies paused after human takeover</span><Button variant="outline" size="sm" disabled={busy || !canSendMessages} onClick={async () => {
    setBusy(true)
    const { error } = await createClient().from('conversations').update({ bot_paused: false, ai_autoreply_disabled: false, updated_at: new Date().toISOString() }).eq('id', conversationId)
    if (error) toast.error(error.message)
    else { setPaused(false); toast.success('Bot replies resumed') }
    setBusy(false)
  }}>Resume bots</Button></div>
}
