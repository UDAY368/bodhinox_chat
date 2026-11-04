import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  editor: {} as Record<string, unknown>,
  fetch: vi.fn(async () => new Response('{}', { status: 500 })),
  effects: [] as Array<{ run: () => void; deps: unknown[] | undefined }>,
}))
// Static rendering never runs effects; record them so a test can check what re-runs them.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const useEffect = (run: () => void, deps?: unknown[]) => { h.effects.push({ run, deps }) }
  return { ...actual, default: { ...actual, useEffect }, useEffect }
})
vi.mock('./flow-editor-state', () => ({ useFlowEditor: () => h.editor }))
vi.mock('@/lib/auth/client', () => ({ authFetch: h.fetch }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { totalActiveRuns, VersionBar } from './version-bar'

const editor = (over: Record<string, unknown> = {}) => ({
  flow: { id: 'flow-1' },
  state: { status: 'active' },
  dirty: false,
  canActivate: true,
  publish: vi.fn(async () => true),
  ...over,
})
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
  .map(([, attrs, body]) => ({ disabled: /\bdisabled=""/.test(attrs), text: body.replace(/<[^>]+>/g, '') }))

describe('flow version bar', () => {
  beforeEach(() => { h.effects = []; h.fetch.mockClear() })

  it('disables Pause and Archive while there are unsaved edits (they reload the editor)', () => {
    h.editor = editor({ dirty: true })
    const html = renderToStaticMarkup(<VersionBar />)
    const byText = new Map(buttons(html).map((b) => [b.text, b.disabled]))
    expect(byText.get('pause')).toBe(true)
    expect(byText.get('archive')).toBe(true)
    h.editor = editor()
    const clean = new Map(buttons(renderToStaticMarkup(<VersionBar />)).map((b) => [b.text, b.disabled]))
    expect(clean.get('pause')).toBe(false)
    expect(clean.get('archive')).toBe(false)
  })

  it('refetches the publish state when the shared status changes (header Activate)', () => {
    h.editor = editor({ state: { status: 'paused' } })
    renderToStaticMarkup(<VersionBar />)
    const refetch = h.effects.find((e) => e.deps?.includes('paused'))
    expect(refetch).toBeDefined()
    refetch!.run()
    expect(h.fetch).toHaveBeenCalledWith('/api/flows/flow-1/versions')
  })

  it('counts every run of the flow in progress, including runs on no version', () => {
    const versions = [{ id: 'v1', version: 1, published_at: '', published_by_name: null, node_count: 2, active_runs: 1 }]
    expect(totalActiveRuns({ versions, active_runs: 3 })).toBe(3)
    expect(totalActiveRuns({ versions: [], active_runs: 2 })).toBe(2)
    expect(totalActiveRuns({ versions })).toBe(1)
    expect(totalActiveRuns(null)).toBe(0)
  })
})
