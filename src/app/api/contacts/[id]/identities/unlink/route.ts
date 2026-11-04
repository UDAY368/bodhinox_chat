// POST /api/contacts/{id}/identities/unlink { identity_id, note? } (admins and owners)
//   Undoes the latest staff link of an identity on contact {id}: it moves back,
//   with its Instagram conversation, to the contact it came from (or to a new
//   phone-less contact when that one was deleted). Audited.
//   200 { link_id, contact_id }; 400 invalid_request (never linked here); 403;
//   404 not_found; 409 identity_conflict | identity_busy; 429; 503 instagram_not_enabled.
import { z } from 'zod';
import { unlinkIdentity } from '@/lib/contacts/identity-link';
import { identityMutation, noteSchema, type IdentityRouteContext } from '../_lib/http';

const schema = z.object({ identity_id: z.string().uuid(), note: noteSchema }).strict();

export async function POST(request: Request, context: IdentityRouteContext) {
  const { id } = await context.params;
  return identityMutation(request, schema, 'unlink', async (actor, body) => {
    const result = await unlinkIdentity(actor, { contactId: id, identityId: body.identity_id, note: body.note ?? null });
    return { link_id: result.linkId, contact_id: result.contactId };
  });
}
