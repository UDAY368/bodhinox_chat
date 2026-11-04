import { useEffect, useState } from 'react'
import { authFetch } from '@/lib/auth/client'
import { nodeCapabilityBlock, type NodeCapability, type WorkspaceCapabilities } from '@/lib/flows/node-registry'

export function filterPaletteTypes<T extends { label: string; description: string }>(items: readonly T[], query: string): T[] {
  const search = query.trim().toLocaleLowerCase()
  return items.filter(item => `${item.label} ${item.description}`.toLocaleLowerCase().includes(search))
}

/** Where a workspace sets up each provider-gated capability (palette "Set up" link). */
export const CAPABILITY_SETUP_HREF: Record<NodeCapability, string> = {
  payments: '/settings?tab=payments',
  appointments: '/appointments',
  ai: '/agents',
  capi: '/settings?tab=ads',
  commerce: '/commerce',
  meetings: '/settings?tab=connections',
  shipping: '/settings?tab=connections',
}

/**
 * The capability a palette entry is blocked on, or null. While the
 * workspace's capabilities are unknown (loading, or the request failed)
 * nothing is blocked here: publishing still refuses a blocked node.
 */
export function paletteBlock(type: string, caps: Partial<WorkspaceCapabilities> | null): NodeCapability | null {
  return caps ? nodeCapabilityBlock(type, caps) : null
}

// Shared by the block library and the drop picker; refreshed after a minute so
// a provider set up in another page is picked up on the way back.
let pending: Promise<WorkspaceCapabilities | null> | null = null
let fetchedAt = 0
function fetchCapabilities(): Promise<WorkspaceCapabilities | null> {
  if (pending && Date.now() - fetchedAt > 60_000) pending = null
  if (!pending) fetchedAt = Date.now()
  pending ??= authFetch('/api/flows/capabilities', { cache: 'no-store' })
    .then(async res => (res.ok ? ((await res.json()) as WorkspaceCapabilities) : null))
    .catch(() => null)
    .then(caps => {
      // A failure is retried by the next caller.
      if (!caps) pending = null
      return caps
    })
  return pending
}

/** The workspace's capabilities from GET /api/flows/capabilities (null until loaded, or if it fails). */
export function useWorkspaceCapabilities(): WorkspaceCapabilities | null {
  const [caps, setCaps] = useState<WorkspaceCapabilities | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchCapabilities().then(result => {
      if (!cancelled) setCaps(result)
    })
    return () => { cancelled = true }
  }, [])
  return caps
}
