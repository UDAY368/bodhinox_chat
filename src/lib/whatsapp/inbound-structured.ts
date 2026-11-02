// Structured parts of an inbound message that its text cannot carry: a shared
// location, the fields of Meta's address form, or a submitted WhatsApp form.
// Stored in messages.interactive_payload and read back by the flow engine.

export type InboundStructuredPayload =
  | { location: { latitude: number; longitude: number; name?: string; address?: string } }
  | { address: Record<string, string> }
  | { form: InboundFormPayload }

/**
 * A submitted form as the inbox and the flow engine read it. The flow token
 * is never stored here; `trusted` marks a first submission on a live
 * session for this contact, the only kind that may resume a flow run.
 */
export interface InboundFormPayload {
  form_id: string | null
  form_name: string | null
  answers: Record<string, string | number | boolean | string[]>
  trusted: boolean
  flow_run_id: string | null
  node_key: string | null
}

// The fields Meta's address_message form returns (India).
const ADDRESS_FIELDS = ['name', 'phone_number', 'in_pin_code', 'house_number', 'floor_number', 'tower_number',
  'building_name', 'address', 'landmark_area', 'city', 'state'] as const

export function inboundLocation(loc: { latitude: unknown; longitude: unknown; name?: unknown; address?: unknown }): InboundStructuredPayload | null {
  const latitude = Number(loc.latitude), longitude = Number(loc.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 256) : undefined)
  return { location: { latitude, longitude, name: text(loc.name), address: text(loc.address) } }
}

/** Reads an address-form reply; anything else (or malformed JSON) is not an address. */
export function inboundAddress(reply: { name?: string; response_json?: string } | undefined): Extract<InboundStructuredPayload, { address: unknown }> | null {
  if (reply?.name !== 'address_message' || typeof reply.response_json !== 'string' || reply.response_json.length > 8192) return null
  let parsed: unknown
  try { parsed = JSON.parse(reply.response_json) } catch { return null }
  const values = (parsed as { values?: unknown })?.values
  if (!values || typeof values !== 'object') return null
  const address: Record<string, string> = {}
  for (const key of ADDRESS_FIELDS) {
    const v = (values as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) address[key] = v.trim().slice(0, 256)
  }
  return Object.keys(address).length ? { address } : null
}
