import { describe, expect, it } from 'vitest'
import { consentKeyword } from '@/lib/contacts/consent'
import en from '../../../messages/en.json'
import es from '../../../messages/es.json'
import ko from '../../../messages/ko.json'
import pt from '../../../messages/pt.json'
import { validateFlowForActivation } from './validate'
import { FLOW_TEMPLATE_CATEGORIES, getFlowTemplate, listFlowTemplates } from './templates'

const templates = listFlowTemplates()

/** Keyword lists per template slug, read straight from each locale's catalogue. */
function catalogueKeywords(messages: { StarterFlows: Record<string, unknown> }): Array<[string, string[]]> {
  return Object.entries(messages.StarterFlows).flatMap(([slug, entry]) => {
    const raw = (entry as { keywords?: unknown }).keywords
    return typeof raw === 'string' ? [[slug, raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)] as [string, string[]]] : []
  })
}

const RESERVED_CONSENT_WORDS = ['stop', 'start', 'subscribe', 'unsubscribe']

describe.each([['en', en], ['es', es], ['pt', pt], ['ko', ko]] as const)('%s starter keywords', (_locale, messages) => {
  const lists = catalogueKeywords(messages)

  it('has keyword lists for every keyword-triggered template', () => {
    for (const t of templates.filter(t => t.trigger_type === 'keyword')) expect(lists.map(([slug]) => slug)).toContain(t.slug)
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

  it.each(templates.map(t => [t.slug, t] as const))('%s passes activation validation as-is', (_slug, template) => {
    const issues = validateFlowForActivation(
      { name: template.name, trigger_type: template.trigger_type, trigger_config: template.trigger_config as Record<string, unknown>, entry_node_id: template.entry_node_id },
      template.nodes.map(n => ({ node_key: n.node_key, node_type: n.node_type, config: n.config as Record<string, unknown> })),
    )
    expect(issues.filter(i => i.severity === 'error')).toEqual([])
  })

  it('needs no workspace-specific node types', () => {
    const workspaceBound = new Set(['send_template', 'api_request', 'connect_flow', 'assign_agent', 'set_tag', 'send_media'])
    for (const template of templates) {
      expect(template.nodes.filter(n => workspaceBound.has(n.node_type)).map(n => `${template.slug}.${n.node_key}`)).toEqual([])
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
