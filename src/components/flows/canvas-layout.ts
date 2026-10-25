import { outgoingSlots } from '@/lib/flows/edges'
import type { BuilderNode } from './shared'

export function canvasNodeDimensions(node: Pick<BuilderNode, 'node_type' | 'config'>, measured?: { width?: number; height?: number }) {
  const slots = ['send_buttons', 'send_list', 'condition'].includes(node.node_type) ? outgoingSlots(node as BuilderNode).length : 0
  return { width: measured?.width || 260, height: measured?.height || 180 + slots * 42 }
}
