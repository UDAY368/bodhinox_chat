import type { DataClient } from '@/lib/data/types'
import { authFetch } from '@/lib/auth/client'
import { daysAgoStart, startOfLocalDay } from './date-utils'
import type {
  ActivityItem,
  DashboardCharts,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
} from './types'
import { getT } from '@/lib/i18n/translate'

/** Broadcast statuses with a translated label in the activity feed. */
const BROADCAST_STATUS_KEYS = new Set(['draft', 'scheduled', 'sending', 'sent', 'failed'])

// ------------------------------------------------------------
// Counts use head-only queries; anything that would read rows past
// the data API's 1,000-row cap (messages per day, response pairs,
// open deal totals) comes pre-aggregated from GET /api/dashboard/charts
// (src/lib/dashboard/charts.ts), grouped in SQL on the workspace
// timezone's days. RLS scopes every query to the current workspace.
// ------------------------------------------------------------

type DB = DataClient

// --- 1. Metric cards ---------------------------------------------------

/** Fetches the SQL chart aggregates for a 7, 30 or 90 day range. */
export async function fetchDashboardCharts(
  days: number,
  fetcher: typeof authFetch = authFetch,
): Promise<DashboardCharts> {
  const response = await fetcher(`/api/dashboard/charts?days=${days}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Dashboard charts failed (${response.status})`)
  return (await response.json()) as DashboardCharts
}

export async function loadMetrics(db: DB, charts: Promise<DashboardCharts>): Promise<MetricsBundle> {
  const todayStart = startOfLocalDay().toISOString()
  const yesterdayStart = daysAgoStart(1).toISOString()

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    chartData,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', todayStart),
    db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    db.from('contacts').select('id', { count: 'exact', head: true }).gte('created_at', todayStart),
    db
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
    charts,
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', todayStart),
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_type', 'agent')
      .gte('created_at', yesterdayStart)
      .lt('created_at', todayStart),
  ])

  const openDealsValue = chartData.dealsByStage.reduce((sum, s) => sum + s.value, 0)
  const openDealsCount = chartData.dealsByStage.reduce((sum, s) => sum + s.count, 0)

  return {
    activeConversations: {
      current: openConvCur.count ?? 0,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: (newConvToday.count ?? 0) - (newConvYesterday.count ?? 0),
    },
    newContactsToday: {
      current: newContactsToday.count ?? 0,
      previous: newContactsYesterday.count ?? 0,
    },
    openDealsValue,
    openDealsCount,
    messagesSentToday: {
      current: messagesToday.count ?? 0,
      previous: messagesYesterday.count ?? 0,
    },
  }
}

// --- 2. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(
  db: DB,
  charts: Promise<DashboardCharts>,
): Promise<PipelineDonutData> {
  const [stagesRes, chartData] = await Promise.all([
    db.from('pipeline_stages').select('id, name, color, pipeline_id, position').order('position'),
    charts,
  ])
  if (stagesRes.error) throw stagesRes.error

  const stages =
    (stagesRes.data ?? []) as { id: string; name: string; color: string }[]
  const byStage = new Map(chartData.dealsByStage.map((s) => [s.stageId, s]))

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.value ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 3. Activity feed --------------------------------------------------

export async function loadActivity(db: DB, limit = 20): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contacts, deals, broadcasts, autoLogs] = await Promise.all([
    db
      .from('messages')
      .select('id, content_text, sender_type, created_at, conversation_id, conversations(contact_id, contacts(name, phone))')
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('contacts')
      .select('id, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(10),
    db
      .from('deals')
      .select('id, title, updated_at, stage:pipeline_stages(name)')
      .order('updated_at', { ascending: false })
      .limit(10),
    db
      .from('broadcasts')
      .select('id, name, status, total_recipients, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
    db
      .from('automation_logs')
      .select('id, trigger_event, status, created_at, automation:automations(name), contact:contacts(name, phone)')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const items: ActivityItem[] = []
  const t = getT('Dashboard.activityFeed.items')

  // PostgREST returns nested selections as arrays by default, even when
  // the foreign key is 1:1. We normalise by taking [0] on each level.
  for (const m of (msgs.data ?? []) as unknown as Array<{
    id: string
    content_text: string | null
    created_at: string
    conversation_id: string
    conversations:
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }[]
      | { contact_id: string | null; contacts: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null }
      | null
  }>) {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations
    const contact = Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts
    const who = contact?.name || contact?.phone || t('unknown')
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: t('newMessage', { who }),
      at: m.created_at,
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of (contacts.data ?? []) as Array<{ id: string; name: string | null; phone: string; created_at: string }>) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: t('newContact', { name: c.name || c.phone }),
      at: c.created_at,
      href: '/contacts',
    })
  }

  for (const d of (deals.data ?? []) as unknown as Array<{
    id: string
    title: string
    updated_at: string
    stage: { name: string }[] | { name: string } | null
  }>) {
    const stage = Array.isArray(d.stage) ? d.stage[0] : d.stage
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: stage?.name
        ? t('dealInStage', { title: d.title, stage: stage.name })
        : t('dealUpdated', { title: d.title }),
      at: d.updated_at,
      href: '/pipelines',
    })
  }

  for (const b of (broadcasts.data ?? []) as Array<{
    id: string
    name: string
    status: string
    total_recipients: number
    created_at: string
  }>) {
    const count = String(b.total_recipients)
    const status = BROADCAST_STATUS_KEYS.has(b.status)
      ? t(`broadcastStatusNames.${b.status}`)
      : b.status
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text:
        b.status === 'sent'
          ? t('broadcastSent', { name: b.name, count })
          : t('broadcastStatus', { name: b.name, status, count }),
      at: b.created_at,
      href: '/broadcasts',
    })
  }

  for (const l of (autoLogs.data ?? []) as unknown as Array<{
    id: string
    trigger_event: string
    status: string
    created_at: string
    automation: { name: string }[] | { name: string } | null
    contact: { name: string | null; phone: string }[] | { name: string | null; phone: string } | null
  }>) {
    const automation = Array.isArray(l.automation) ? l.automation[0] : l.automation
    const contact = Array.isArray(l.contact) ? l.contact[0] : l.contact
    const who = contact?.name || contact?.phone || t('aContact')
    const autoName = automation?.name || t('automationFallback')
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: t(l.status === 'failed' ? 'automationFailed' : 'automationTriggered', { name: autoName, who }),
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}
