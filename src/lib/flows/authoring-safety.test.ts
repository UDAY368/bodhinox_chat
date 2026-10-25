import { describe, expect, it } from 'vitest'
import { validateFlowForActivation } from './validate'
import { getFlowTemplate } from './templates'
import { validateCollectedInput } from './input-validation'
import type { CollectInputNodeConfig } from './types'

const flow = { name: 'Branching', trigger_type: 'manual' as const, trigger_config: {}, entry_node_id: 'start' }
const condition = { node_key: 'check', node_type: 'condition', config: { subject: 'var', subject_key: 'rule', operator: 'equals', value: 'Yes', true_next: 'end', false_next: 'end' } }
const end = { node_key: 'end', node_type: 'end', config: {} }
const collect = { node_key: 'capture', node_type: 'collect_input', config: { prompt_text: 'Your choice?', var_key: 'rule', next_node_key: 'check' } }
describe('flow authoring safety', () => {
  it('warns when a condition references an unset variable without blocking externally supplied values', () => {
    const issues = validateFlowForActivation(flow, [{ node_key: 'start', node_type: 'start', config: { next_node_key: 'check' } }, condition, end])
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'warning', node_key: 'check', field: 'subject_key', message: expect.stringContaining('rule') }))
    expect(issues.some(i => i.severity === 'error')).toBe(false)
  })
  it('does not warn when a reachable earlier node collects the variable', () => {
    expect(validateFlowForActivation(flow, [{ node_key: 'start', node_type: 'start', config: { next_node_key: 'capture' } }, collect, condition, end])).toEqual([])
  })
  it('does not treat a future collector as an earlier assignment', () => {
    const issues = validateFlowForActivation(flow, [{ node_key: 'start', node_type: 'start', config: { next_node_key: 'check' } }, { ...condition, config: { ...condition.config, true_next: 'capture' } }, collect, end])
    expect(issues.some(i => i.node_key === 'check' && i.field === 'subject_key' && i.severity === 'warning')).toBe(true)
  })
  it('does not treat an unrelated sibling collector as an assignment', () => {
    const issues = validateFlowForActivation(flow, [
      { node_key: 'start', node_type: 'send_buttons', config: { text: 'Choose', buttons: [{ reply_id: 'a', title: 'Collect', next_node_key: 'capture' }, { reply_id: 'b', title: 'Check', next_node_key: 'check' }] } },
      { ...collect, config: { ...collect.config, next_node_key: 'end' } }, condition, end,
    ])
    expect(issues.some(i => i.node_key === 'check' && i.field === 'subject_key' && i.severity === 'warning')).toBe(true)
  })
  it('warns about unavailable variables in messages', () => {
    const issues = validateFlowForActivation(flow, [{ node_key: 'start', node_type: 'send_message', config: { text: 'Hello {{vars.missing}}', next_node_key: 'end' } }, end])
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'warning', node_key: 'start', field: 'text', message: expect.stringContaining('missing') }))
  })
  it.each([{ validation: 'other' }, { validation: 'regex' }, { validation: 'regex', regex: '(' }, { validation: 'regex', regex: 'x'.repeat(257) }])('blocks invalid collection validation: %j', config => {
    const issues = validateFlowForActivation({ ...flow, entry_node_id: 'capture' }, [{ ...collect, config: { ...collect.config, ...config, next_node_key: 'end' } }, end])
    expect(issues.some(i => i.node_key === 'capture' && i.severity === 'error')).toBe(true)
  })
  it('new lead capture templates reject invalid email input', async () => {
    const email = getFlowTemplate('lead_capture')!.nodes.find(n => n.node_key === 'ask_email')!
    const config = email.config as CollectInputNodeConfig
    expect(await validateCollectedInput('not-an-email', config)).toBe(false)
    expect(await validateCollectedInput('customer@example.com', config)).toBe(true)
  })
})
