// What a processed WhatsApp webhook receipt keeps (batch 5, findings section 8: raw message text
// was kept 30 days). Once the worker has processed a receipt, its payload is replaced by this
// shell in the same UPDATE that marks it processed: ids and types only, so an operator can still
// see what arrived. No message text, captions, media links, names or phone numbers. The receipt's
// dedupe key is a separate column and is kept.

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, 1000) : []);
const text = (value: unknown, max = 128): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' ? String(value) : undefined;
const code = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function processedWebhookShell(payload: unknown): Json {
  const body = obj(payload);
  return {
    object: text(body.object, 64),
    stripped: true,
    entry: list(body.entry).map((rawEntry) => {
      const entry = obj(rawEntry);
      return {
        id: text(entry.id),
        changes: list(entry.changes).map((rawChange) => {
          const change = obj(rawChange);
          const value = obj(change.value);
          return {
            field: text(change.field, 64),
            phone_number_id: text(obj(value.metadata).phone_number_id),
            messages: list(value.messages).map((m) => ({ id: text(obj(m).id, 256), type: text(obj(m).type, 64), timestamp: text(obj(m).timestamp, 32) })),
            statuses: list(value.statuses).map((s) => ({ id: text(obj(s).id, 256), status: text(obj(s).status, 64), timestamp: text(obj(s).timestamp, 32) })),
            errors: list(value.errors).map((e) => ({ code: code(obj(e).code) })),
          };
        }),
      };
    }),
  };
}
