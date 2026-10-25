import { expect, it } from 'vitest'
import { canvasNodeDimensions } from './canvas-layout'

it('uses measured card dimensions when arranging a flow', () => {
  expect(canvasNodeDimensions({ node_type: 'send_list', config: {} }, { width: 270, height: 520 })).toEqual({ width: 270, height: 520 })
})
it('reserves room for every list option before the first measurement', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ reply_id: String(i), title: 'Option', next_node_key: 'end' }))
  expect(canvasNodeDimensions({ node_type: 'send_list', config: { sections: [{ rows }] } }).height).toBeGreaterThan(500)
})
