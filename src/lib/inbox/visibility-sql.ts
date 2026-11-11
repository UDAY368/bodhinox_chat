// Stage 5 (5E): the agent-visibility predicate (inbox-scope.ts) as a Prisma
// fragment for the server paths that look a conversation up by id before
// acting on it (send a form, product or payment link, schedule a reply, notes,
// reminders, AI context). Server only: inbox-scope.ts stays free of
// @prisma/client because client components import it.
//
// The predicate reads the role from the tenant transaction (app.account_role),
// so it is true for owners, admins, the worker (no role) and every workspace on
// the default visibility 'all': those queries behave exactly as before.
import { Prisma } from '@prisma/client';
import { conversationVisibleSql } from './inbox-scope';

/** `AND`-able SQL: the conversation row aliased `alias` is visible to the member of this transaction. */
export function conversationVisible(alias: string): Prisma.Sql {
  return Prisma.raw(conversationVisibleSql(alias));
}
