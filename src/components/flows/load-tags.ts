import { createClient } from '@/lib/data/client'

export interface FlowTag { id: string; name: string; color?: string }

export async function loadFlowTags(): Promise<FlowTag[]> {
  try {
    const { data, error } = await createClient().from<FlowTag>('tags').select('id,name,color').order('name')
    return error ? [] : data ?? []
  } catch {
    return []
  }
}
