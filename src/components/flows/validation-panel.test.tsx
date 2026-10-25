import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ValidationIssue } from '@/lib/flows/validate'
const h = vi.hoisted(() => ({ issues: [] as ValidationIssue[], jump: vi.fn() }))
vi.mock('./flow-editor-state', () => ({ useFlowEditor: () => ({ issues: h.issues, requestFlash: h.jump }) }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string, values?: { errorCount?: number; warningCount?: number }) => key === 'summary' ? `${values?.errorCount} errors, ${values?.warningCount} warnings` : key }))
import { ValidationPanel } from './validation-panel'
it('keeps many warnings in a collapsed, bounded drawer instead of taking over the canvas', () => {
  h.issues = Array.from({ length: 25 }, (_, i) => ({ severity: 'warning', scope: 'node', node_key: `node_${i}`, message: 'Missing variable' }))
  const html = renderToStaticMarkup(<ValidationPanel />)
  expect(html).toContain('<details')
  expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/)
  expect(html).toContain('0 errors, 25 warnings')
  expect(html).toContain('overflow-y-auto')
  expect(html).toContain('max-h-40')
})
it('shows blocking errors in the summary even while the details are closed', () => {
  h.issues = [{ severity: 'error', scope: 'flow', message: 'Missing entry' }]
  expect(renderToStaticMarkup(<ValidationPanel />)).toContain('1 errors, 0 warnings')
})
