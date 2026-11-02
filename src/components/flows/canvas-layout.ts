import { outgoingSlots } from '@/lib/flows/edges'
import type { BuilderNode } from './shared'

export function canvasNodeDimensions(node: Pick<BuilderNode, 'node_type' | 'config'>, measured?: { width?: number; height?: number }) {
  // Matches FlowNodeCard: a node with several ports lists one row per port.
  const all = outgoingSlots(node as BuilderNode).length
  const slots = ['send_buttons', 'send_list', 'condition'].includes(node.node_type) || all > 1 ? all : 0
  return { width: measured?.width || 260, height: measured?.height || 180 + slots * 42 }
}
