// POST /api/contacts/{id}/identities/link { identity_id, target_contact_id, note? } (admins and owners)
//   Moves an Instagram identity of contact {id}, and its Instagram conversation,
//   to another contact of this workspace. Both histories are kept; audited.
//   200 { link_id }; 400 invalid_request; 403; 404 not_found (also another
//   workspace's ids); 409 identity_conflict | identity_busy; 429; 503 instagram_not_enabled.
import { z } from 'zod';
import { linkIdentity } from '@/lib/contacts/identity-link';
import { identityMutation, noteSchema, type IdentityRouteContext } from '../_lib/http';

const schema = z.object({ identity_id: z.string().uuid(), target_contact_id: z.string().uuid(), note: noteSchema }).strict();

export async function POST(request: Request, context: IdentityRouteContext) {
  const { id } = await context.params;
  return identityMutation(request, schema, 'link', async (actor, body) => {
    const { linkId } = await linkIdentity(actor, {
      contactId: id, identityId: body.identity_id, targetContactId: body.target_contact_id, note: body.note ?? null,
    });
    return { link_id: linkId };
  });
}
