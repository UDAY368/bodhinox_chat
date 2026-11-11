import { describe, expect, it } from 'vitest'
import { consentKeyword } from '@/lib/contacts/consent'
import en from '../../../messages/en.json'
import es from '../../../messages/es.json'
import ko from '../../../messages/ko.json'
import pt from '../../../messages/pt.json'
import { validateFlowForActivation } from './validate'
import { FLOW_TEMPLATE_CATEGORIES, flowTemplateChannels, getFlowTemplate, INSTAGRAM_TEMPLATE_LINKS_TO_BIND, listFlowTemplates,
  TEMPLATE_TAGS_TO_BIND, type FlowTemplate } from './templates'
import { startsFromComment } from './types'

const templates = listFlowTemplates()

type Catalogue = { StarterFlows: Record<string, unknown>; Instagram: { quickAutomations: { flows: Record<string, unknown> } } }

/** The Stage 5 Instagram starters' copy (StarterFlows.instagram5.templates). */
const stage5Copy = (messages: Catalogue) =>
  ((messages.StarterFlows.instagram5 as { templates?: Record<string, Record<string, string>> } | undefined)?.templates ?? {})

/**
 * Keyword lists per template slug, read straight from each locale's
 * catalogue: the WhatsApp-era starters (StarterFlows) and the Instagram
 * starters (Instagram.quickAutomations.flows and, from Stage 5,
 * StarterFlows.instagram5.templates), which can sit in one Instagram
 * section together.
 */
function catalogueKeywords(messages: Catalogue): Array<[string, string[]]> {
  return Object.entries({ ...messages.StarterFlows, ...messages.Instagram.quickAutomations.flows, ...stage5Copy(messages) }).flatMap(([slug, entry]) => {
    const raw = (entry as { keywords?: unknown }).keywords
    return typeof raw === 'string' ? [[slug, raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)] as [string, string[]]] : []
  })
}

/** Steps a template leaves for the author to bind to a workspace record or link (publishing reports them until then). */
const TO_BIND = new Set(['work_from_home.registered', ...INSTAGRAM_TEMPLATE_LINKS_TO_BIND, ...TEMPLATE_TAGS_TO_BIND])


const RESERVED_CONSENT_WORDS = ['stop', 'start', 'subscribe', 'unsubscribe']

describe.each([['en', en], ['es', es], ['pt', pt], ['ko', ko]] as const)('%s starter keywords', (_locale, messages) => {
  const lists = catalogueKeywords(messages)

  it('has keyword lists for every keyword-triggered template and every Instagram comment template', () => {
    // An intent match (Stage 5, AI) is recognised by meaning and has no keywords.
    const intent = (t: FlowTemplate) => (t.trigger_config as { match_type?: string }).match_type === 'intent'
    for (const t of templates.filter(t => (t.trigger_type === 'keyword' && !intent(t)) || t.trigger_type === 'ig_comment')) {
      expect(lists.map(([slug]) => slug)).toContain(t.slug)
    }
  })

  it.each(lists)('%s keywords are distinctive and never consent words', (_slug, keywords) => {
    for (const k of keywords) {
      // "contains" matching: short tokens like "hi" or "emi" hit unrelated words.
      expect(k.length, k).toBeGreaterThanOrEqual(/[a-z]/.test(k) ? 4 : 2)
      // Built-in STOP/START handling consumes these and skips automated replies.
      expect(consentKeyword(k), k).toBeNull()
      for (const word of RESERVED_CONSENT_WORDS) expect(new RegExp(`\\b${word}\\b`).test(k), k).toBe(false)
    }
  })

  it('never shares a keyword, or a substring of one, between two templates', () => {
    const clashes: string[] = []
    for (const [slugA, a] of lists) {
      for (const [slugB, b] of lists) {
        if (slugA === slugB) continue
        for (const ka of a) for (const kb of b) if (kb.includes(ka)) clashes.push(`${slugA}:"${ka}" in ${slugB}:"${kb}"`)
      }
    }
    expect(clashes).toEqual([])
  })
})

describe('flow template gallery', () => {
  it('offers at least 24 templates with unique slugs', () => {
    expect(templates.length).toBeGreaterThanOrEqual(24)
    expect(new Set(templates.map(t => t.slug)).size).toBe(templates.length)
  })

  it('keeps the original starter slugs', () => {
    for (const slug of ['welcome_menu', 'faq_bot', 'lead_capture']) expect(getFlowTemplate(slug)?.slug).toBe(slug)
  })

  it('does not resolve inherited object keys as templates', () => {
    expect(getFlowTemplate('constructor')).toBeNull()
    expect(getFlowTemplate('__proto__')).toBeNull()
  })

  it.each(templates.map(t => [t.slug, t] as const))('%s has a known category, a name and a description', (_slug, template) => {
    expect(FLOW_TEMPLATE_CATEGORIES).toContain(template.category)
    expect(template.name.trim()).not.toBe('')
    expect(template.description.trim()).not.toBe('')
  })

  it.each(templates.flatMap(t => flowTemplateChannels(t).map(channel => [t.slug, channel, t] as const)))(
    '%s passes activation validation as-is on %s, apart from its tag or link to bind', (_slug, channel, template) => {
      const issues = validateFlowForActivation(
        { name: template.name, trigger_type: template.trigger_type, trigger_config: template.trigger_config as Record<string, unknown>,
          entry_node_id: template.entry_node_id, channel_scope: channel },
        template.nodes.map(n => ({ node_key: n.node_key, node_type: n.node_type, config: n.config as Record<string, unknown> })),
      )
      expect(issues.filter(i => i.severity === 'error' && !TO_BIND.has(`${template.slug}.${i.node_key}`))).toEqual([])
    })

  it('offers about 12 Instagram starters, each only on Instagram, including the follow gate and the WhatsApp handover', () => {
    const instagram = templates.filter(t => t.channels?.length === 1 && t.channels[0] === 'instagram')
    expect(instagram.length).toBeGreaterThanOrEqual(12)
    for (const t of instagram) {
      expect(flowTemplateChannels(t)).toEqual(['instagram'])
      expect(t.category.startsWith('instagram_')).toBe(true)
    }
    expect(instagram.map(t => t.slug)).toEqual(expect.arrayContaining(['ig_follow_gate', 'ig_to_whatsapp', 'ig_link_drop', 'ig_story_leads']))
    // Every Instagram trigger has a starter (Stage 5 adds Live comments and starters without a trigger).
    expect(new Set(instagram.map(t => t.trigger_type))).toEqual(new Set(['ig_comment', 'ig_story_reply', 'ig_story_mention', 'keyword', 'default_reply',
      'ig_live_comment', 'manual']))
  })

  it('needs no workspace-specific node types, apart from the tags an author binds', () => {
    const workspaceBound = new Set(['send_template', 'api_request', 'connect_flow', 'assign_agent', 'set_tag', 'send_media'])
    for (const template of templates) {
      expect(template.nodes.filter(n => workspaceBound.has(n.node_type)).map(n => `${template.slug}.${n.node_key}`)
        .filter(key => !TO_BIND.has(key))).toEqual([])
    }
  })
})

describe('ayurvedic_store (J4, Phase 8)', () => {
  const template = getFlowTemplate('ayurvedic_store')!
  const byKey = new Map(template.nodes.map(n => [n.node_key, n]))

  it('offers shop, consult, my orders and talk to us from one list', () => {
    const menu = byKey.get('menu')!
    expect(menu.node_type).toBe('send_list')
    const rows = (menu.config as { sections: { rows: { reply_id: string; next_node_key: string }[] }[] }).sections[0].rows
    expect(rows.map(r => [r.reply_id, r.next_node_key])).toEqual([['shop', 'shop'], ['consult', 'consult'], ['orders', 'orders'], ['talk', 'agent']])
  })

  it('sends contact-bound storefront links with a failed port, and books only through the flow step', () => {
    expect(byKey.get('shop')).toMatchObject({ node_type: 'send_storefront_link', config: { purpose: 'shop', failed_next: 'shop_offline' } })
    expect(byKey.get('orders')).toMatchObject({ node_type: 'send_storefront_link', config: { purpose: 'status', failed_next: 'no_orders' } })
    expect(byKey.get('consult')).toMatchObject({ node_type: 'book_appointment', config: { unavailable_next: 'agent' } })
    expect(byKey.get('agent')?.node_type).toBe('handoff')
    // The link itself is never stored in run variables or the template.
    expect(JSON.stringify(template)).not.toMatch(/\/shop\//)
  })
})

describe('work_from_home (J1, Phase 12)', () => {
  const template = getFlowTemplate('work_from_home')!
  const nodes = template.nodes.map(n => ({ node_key: n.node_key, node_type: n.node_type, config: n.config as Record<string, unknown> }))

  it('tags the contact as registered (a tag the author binds), not a run variable segments cannot see', () => {
    expect(template.nodes.find(n => n.node_key === 'registered')).toMatchObject({ node_type: 'set_tag', config: { mode: 'add', tag_id: '', next_node_key: 'agent' } })
    const errors = validateFlowForActivation({ name: template.name, trigger_type: template.trigger_type,
      trigger_config: template.trigger_config as Record<string, unknown>, entry_node_id: template.entry_node_id }, nodes)
      .filter(i => i.severity === 'error')
    expect(errors).toEqual([expect.objectContaining({ node_key: 'registered', field: 'tag_id' })])
    const bound = nodes.map(n => (n.node_key === 'registered' ? { ...n, config: { ...n.config, tag_id: '00000000-0000-4000-8000-000000000001' } } : n))
    expect(validateFlowForActivation({ name: template.name, trigger_type: template.trigger_type,
      trigger_config: template.trigger_config as Record<string, unknown>, entry_node_id: template.entry_node_id }, bound)
      .filter(i => i.severity === 'error')).toEqual([])
  })
})

describe('Instagram starters (Stage 2)', () => {
  const instagram = templates.filter(t => t.channels?.length === 1 && t.channels[0] === 'instagram')
  const byKey = (template: FlowTemplate) => new Map(template.nodes.map(n => [n.node_key, n]))
  const next = (template: FlowTemplate, key: string) => (byKey(template).get(key)?.config as { next_node_key?: string }).next_node_key

  it.each(instagram.filter(t => t.trigger_type === 'ig_comment').map(t => [t.slug, t] as const))(
    '%s opens with one private reply whose button opens the window, before anything else', (_slug, template) => {
      const first = byKey(template).get(next(template, 'start')!)!
      expect(first.node_type).toBe('ig_private_reply')
      const config = first.config as { text: string; opt_in_label?: string }
      expect(config.text.trim()).not.toBe('')
      expect(config.opt_in_label?.trim()).toBeTruthy()
      // Only the first message may be a private reply.
      expect(template.nodes.filter(n => n.node_type === 'ig_private_reply')).toHaveLength(1)
      const trigger = template.trigger_config as { post_scope?: string; include_keywords?: string[]; public_replies?: string[] }
      expect(trigger.post_scope).toBe('any')
      expect(trigger.include_keywords?.length).toBeGreaterThan(0)
      expect(trigger.public_replies?.length).toBe(1)
    })

  it('runs no private reply outside a comment flow', () => {
    for (const t of instagram.filter(t => !startsFromComment(t.trigger_type))) {
      expect(t.nodes.some(n => n.node_type === 'ig_private_reply'), t.slug).toBe(false)
    }
  })

  it.each(['ig_follow_gate', 'ig_giveaway'])('%s re-checks the follow gate after the "I followed" tap', (slug) => {
    const template = getFlowTemplate(slug)!
    const nodes = byKey(template)
    expect(nodes.get('check_follow')).toMatchObject({
      node_type: 'condition',
      config: { subject: 'ig_profile', subject_key: 'follows_business', operator: 'equals', value: 'true', false_next: 'ask_follow' },
    })
    const ask = nodes.get('ask_follow')!.config as { buttons: Array<{ next_node_key: string }> }
    expect(ask.buttons.map(b => b.next_node_key)).toEqual(['check_follow'])
  })

  it('leaves every link for the author to add, and holds no placeholder URL', () => {
    for (const t of instagram) {
      for (const n of t.nodes.filter(n => n.node_type === 'send_card')) {
        const urls = ((n.config as { card: { buttons: Array<{ type: string; url?: string }> } }).card.buttons ?? [])
          .filter(b => b.type === 'web_url').map(b => b.url)
        expect(urls.every(u => u === ''), `${t.slug}.${n.node_key}`).toBe(true)
        expect(INSTAGRAM_TEMPLATE_LINKS_TO_BIND.has(`${t.slug}.${n.node_key}`)).toBe(true)
      }
      expect(JSON.stringify(t)).not.toMatch(/https?:\/\//)
    }
  })

  it('hands an Instagram DM over to WhatsApp, or keeps it on Instagram with the team', () => {
    const template = getFlowTemplate('ig_to_whatsapp')!
    const nodes = byKey(template)
    const ask = nodes.get('ask')!.config as { buttons: Array<{ reply_id: string; next_node_key: string }> }
    expect(ask.buttons.map(b => [b.reply_id, b.next_node_key])).toEqual([['yes', 'wa_link'], ['no', 'stay']])
    expect(nodes.get('wa_link')?.node_type).toBe('send_card')
    expect(nodes.get('agent')?.node_type).toBe('handoff')
  })

  // Instagram's limits (graph-limits.ts): button and quick-reply titles 20, card titles and subtitles 80, text 1000 bytes.
  const BUTTON_KEYS = /^(optIn|.*Button|budgetLow|budgetHigh|timelineNow|timelineLater|product\dTitle|optInLabel|linkLabel|followedButton|rewardButton)$/
  const TITLE_KEYS = /^(cardTitle|cardSubtitle|rewardTitle|product\dSubtitle|prize[A-C]Title|rulesTitle|winnerTitle|reminderTitle|answer)$/
  // Gallery and canvas text (never sent to Instagram).
  const NOT_SENT = /^(keywords|name|description|handoffNote|businessValue|howItWorks|note\d+|intent|instructions)$/
  describe.each([['en', en], ['es', es], ['pt', pt], ['ko', ko]] as const)('%s copy', (_locale, messages) => {
    const qa = messages.Instagram.quickAutomations as unknown as { flows: Record<string, Record<string, string>>; defaults: Record<string, Record<string, string>> }
    const entries = [...Object.values(qa.flows), ...Object.values(qa.defaults), ...Object.values(stage5Copy(messages as unknown as Catalogue))]
      .flatMap(group => Object.entries(group))

    it('fits Instagram button, card and message limits', () => {
      for (const [key, value] of entries) {
        if (NOT_SENT.test(key)) continue
        if (BUTTON_KEYS.test(key)) expect([...value].length, `${key}: ${value}`).toBeLessThanOrEqual(20)
        else if (TITLE_KEYS.test(key)) expect([...value].length, `${key}: ${value}`).toBeLessThanOrEqual(80)
        else expect(new TextEncoder().encode(value).length, `${key}: ${value}`).toBeLessThanOrEqual(1000)
      }
    })

    it('has copy for every Instagram starter', () => {
      const copy = { ...qa.flows, ...stage5Copy(messages as unknown as Catalogue) }
      for (const t of instagram) {
        expect(copy[t.slug]?.name, t.slug).toBeTruthy()
        expect(copy[t.slug]?.description, t.slug).toBeTruthy()
      }
    })
  })
})

describe('Instagram starters (Stage 5, template parity)', () => {
  const STAGE5 = ['ig_giveaway_draw', 'ig_video_channel', 'ig_comment_rsvp', 'ig_reel_product', 'ig_live_prizes', 'ig_live_offer',
    'ig_live_link', 'ig_story_collab', 'ig_sms_list', 'ig_dm_link', 'ig_ab_opening', 'ig_ai_question', 'ig_ai_conversation',
    'ig_link_follow_up', 'ig_solo_dm', 'ig_opening_dm']
  const stage5 = STAGE5.map(slug => getFlowTemplate(slug)!)
  const instagram = templates.filter(t => t.channels?.length === 1 && t.channels[0] === 'instagram')
  const UUID = '00000000-0000-4000-8000-000000000001'

  /** Fills what the author is asked to fill in: links, tags. */
  function filled(template: FlowTemplate) {
    return template.nodes.map(n => {
      const config = JSON.parse(JSON.stringify(n.config)) as Record<string, unknown>
      const cards = n.node_type === 'send_card' ? [config.card] : n.node_type === 'send_gallery' ? (config.cards as unknown[]) : []
      for (const card of cards as Array<{ buttons?: Array<{ type: string; url?: string }> }>)
        for (const b of card.buttons ?? []) if (b.type === 'web_url') b.url = 'https://shop.example/page'
      if (n.node_type === 'condition' && config.subject === 'tag') config.subject_key = UUID
      if (n.node_type === 'actions')
        config.actions = (config.actions as Array<Record<string, unknown>>).map(a => (a.type === 'add_tag' ? { ...a, tag_id: UUID } : a))
      return { node_key: n.node_key, node_type: n.node_type, config }
    })
  }

  it('adds the sixteen Stage 5 starters, each Instagram-only and in an Instagram category', () => {
    expect(stage5.every(Boolean)).toBe(true)
    for (const t of stage5) {
      expect(flowTemplateChannels(t), t.slug).toEqual(['instagram'])
      expect(t.category.startsWith('instagram_'), t.slug).toBe(true)
    }
  })

  it.each(STAGE5)('%s passes the publish validator once its links and tags are filled in', (slug) => {
    const template = getFlowTemplate(slug)!
    const flow = { name: template.name, trigger_type: template.trigger_type, channel_scope: 'instagram' as const,
      trigger_config: template.trigger_config as Record<string, unknown>, entry_node_id: template.entry_node_id }
    // A workspace capability (AI) is the workspace's own setting.
    const errors = validateFlowForActivation(flow, filled(template))
      .filter(i => i.severity === 'error' && i.code !== 'capabilityUnavailable')
    expect(errors).toEqual([])
  })

  it('reports every link and tag the author must fill in before publishing', () => {
    for (const t of stage5) {
      // Any error on the step counts (an Actions step is refused as a whole until 5B validates its tag).
      const errorNodes = new Set(validateFlowForActivation({ name: t.name, trigger_type: t.trigger_type, channel_scope: 'instagram',
        trigger_config: t.trigger_config as Record<string, unknown>, entry_node_id: t.entry_node_id },
      t.nodes.map(n => ({ node_key: n.node_key, node_type: n.node_type, config: n.config as Record<string, unknown> })))
        .filter(i => i.severity === 'error').map(i => `${t.slug}.${i.node_key}`))
      for (const key of [...INSTAGRAM_TEMPLATE_LINKS_TO_BIND, ...TEMPLATE_TAGS_TO_BIND].filter(k => k.startsWith(`${t.slug}.`)))
        expect(errorNodes.has(key), key).toBe(true)
    }
  })

  it('gives every Instagram starter gallery metadata, notes on the new ones, and covers every goal and trigger filter', () => {
    for (const t of instagram) expect(t.meta, t.slug).toBeDefined()
    for (const t of stage5) {
      expect(t.canvas_notes?.length, t.slug).toBeGreaterThan(0)
      expect(t.business_value && t.how_it_works, t.slug).toBeTruthy()
      for (const note of t.canvas_notes!) expect(note.text.length).toBeLessThanOrEqual(1000)
    }
    for (const goal of ['grow_followers', 'engage_audience', 'drive_traffic'])
      expect(instagram.some(t => t.meta!.goals.includes(goal as never)), goal).toBe(true)
    for (const trigger of ['post_comment', 'dm', 'story_reply', 'live_comment'])
      expect(instagram.some(t => t.meta!.trigger === trigger), trigger).toBe(true)
    expect(instagram.filter(t => t.meta!.recommended).length).toBeGreaterThanOrEqual(3)
  })

  it('ships three starters without a trigger, marked as such for the gallery', () => {
    const triggerless = stage5.filter(t => t.trigger_type === 'manual')
    expect(triggerless.map(t => t.slug).sort()).toEqual(['ig_link_follow_up', 'ig_opening_dm', 'ig_solo_dm'])
    for (const t of triggerless) expect(t.meta!.trigger).toBeNull()
  })

  it('opens every comment-started starter with exactly one private reply', () => {
    for (const t of stage5.filter(t => startsFromComment(t.trigger_type))) {
      const start = t.nodes.find(n => n.node_key === 'start')!
      const first = t.nodes.find(n => n.node_key === (start.config as { next_node_key: string }).next_node_key)!
      expect(first.node_type, t.slug).toBe('ig_private_reply')
      expect(t.nodes.filter(n => n.node_type === 'ig_private_reply'), t.slug).toHaveLength(1)
    }
  })

  it('keeps every wait under 24 hours and checks a tracked link before reminding', () => {
    for (const t of stage5) {
      for (const n of t.nodes.filter(n => n.node_type === 'smart_delay')) {
        const cfg = n.config as { mode: string; amount: number; unit: string }
        expect(cfg.mode).toBe('duration')
        expect(cfg.unit === 'hours' ? cfg.amount : Infinity, `${t.slug}.${n.node_key}`).toBeLessThan(24)
      }
      for (const n of t.nodes.filter(n => n.node_type === 'condition' && (n.config as { subject?: string }).subject === 'link_click')) {
        const target = t.nodes.find(x => x.node_key === (n.config as { subject_key: string }).subject_key)!
        expect((target.config as { track_clicks?: boolean }).track_clicks, `${t.slug}.${n.node_key}`).toBe(true)
      }
    }
  })

  it('splits every randomizer into paths that total 100, sticky for the giveaway draw only where it matters', () => {
    for (const t of stage5) {
      for (const n of t.nodes.filter(n => n.node_type === 'randomizer')) {
        const cfg = n.config as { paths: Array<{ weight: number; next_node_key: string }>; sticky: boolean }
        expect(cfg.paths.reduce((sum, p) => sum + p.weight, 0), `${t.slug}.${n.node_key}`).toBe(100)
        for (const p of cfg.paths) expect(t.nodes.some(x => x.node_key === p.next_node_key)).toBe(true)
      }
    }
    expect((getFlowTemplate('ig_giveaway_draw')!.nodes.find(n => n.node_key === 'draw')!.config as { sticky: boolean }).sticky).toBe(true)
    expect((getFlowTemplate('ig_live_prizes')!.nodes.find(n => n.node_key === 'spin')!.config as { sticky: boolean }).sticky).toBe(false)
  })

  it('marks the AI starters as needing AI', () => {
    expect(getFlowTemplate('ig_ai_question')!.meta!.uses_ai).toBe(true)
    expect(getFlowTemplate('ig_ai_question')!.trigger_config).toMatchObject({ match_type: 'intent' })
    expect(getFlowTemplate('ig_ai_conversation')!.meta!.uses_ai).toBe(true)
  })
})
