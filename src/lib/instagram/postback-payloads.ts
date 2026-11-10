// Postback and quick-reply payload codes Bodhinox puts on Instagram buttons
// (Stage 2). Pure: no I/O. Meta echoes the payload back in a postback or
// quick-reply webhook; these codes say what the tap means:
//   ib:<flow id>                  a conversation starter (ice breaker) tap starts that flow
//   menu:<flow id>                a persistent menu item tap starts that flow (Stage 3)
//   optin:<run id>:<node key>     the "Opening DM" tap on a comment private reply resumes the run
//   follow-check:<run id>:<node key>  "I followed" re-checks the follow gate
//
// A decoded code is only a claim: the engine must still load the flow or run
// under withTenant for the conversation's own workspace and contact before it
// acts (a payload never selects another tenant's row). Anything that does not
// decode exactly is not ours and is treated as an ordinary reply id.

export type InstagramPostback =
  | { kind: 'ice_breaker'; flowId: string }
  | { kind: 'menu'; flowId: string }
  | { kind: 'opt_in'; runId: string; nodeKey: string }
  | { kind: 'follow_check'; runId: string; nodeKey: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Same shape as flow node keys elsewhere (dry-run.ts). */
const NODE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const PREFIX = { ice_breaker: 'ib', menu: 'menu', opt_in: 'optin', follow_check: 'follow-check' } as const;

export class PostbackPayloadError extends Error {
  constructor() {
    super('Invalid postback payload');
    this.name = 'PostbackPayloadError';
  }
}

const uuid = (value: string): string => {
  const id = value.toLowerCase();
  if (!UUID.test(id)) throw new PostbackPayloadError();
  return id;
};
const nodeKey = (value: string): string => {
  if (!NODE_KEY.test(value)) throw new PostbackPayloadError();
  return value;
};

/** The payload for a postback. Throws PostbackPayloadError on an id or key that would not decode. */
export function encodePostback(postback: InstagramPostback): string {
  switch (postback.kind) {
    case 'ice_breaker':
    case 'menu':
      return `${PREFIX[postback.kind]}:${uuid(postback.flowId)}`;
    case 'opt_in':
    case 'follow_check':
      return `${PREFIX[postback.kind]}:${uuid(postback.runId)}:${nodeKey(postback.nodeKey)}`;
  }
}

/** The postback a payload encodes, or null when it is not one of ours (or is malformed). */
export function decodePostback(payload: unknown): InstagramPostback | null {
  if (typeof payload !== 'string' || payload.length > 200) return null;
  const [prefix, first, second, ...rest] = payload.split(':');
  if (rest.length) return null;
  const flowKind = prefix === PREFIX.ice_breaker ? 'ice_breaker' : prefix === PREFIX.menu ? 'menu' : null;
  if (flowKind)
    return second === undefined && first !== undefined && UUID.test(first) ? { kind: flowKind, flowId: first } : null;
  const kind = prefix === PREFIX.opt_in ? 'opt_in' : prefix === PREFIX.follow_check ? 'follow_check' : null;
  if (!kind || first === undefined || second === undefined || !UUID.test(first) || !NODE_KEY.test(second)) return null;
  return { kind, runId: first, nodeKey: second };
}
