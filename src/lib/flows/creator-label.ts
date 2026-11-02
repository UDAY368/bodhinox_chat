// Decides how a flow card names its creator from the member roster.
// `roster` is null when the roster could not be loaded: then nothing is
// known about the creator and the card leaves the line out. A creator
// missing from a loaded roster has left the account; one present with no
// visible name (non-admins do not see emails) is a current teammate.
export type CreatorLabel =
  | { kind: "name"; name: string }
  | { kind: "teammate" }
  | { kind: "former" };

export function creatorLabel(
  roster: ReadonlyMap<string, string> | null,
  userId: string,
): CreatorLabel | null {
  if (!roster) return null;
  if (!roster.has(userId)) return { kind: "former" };
  const name = roster.get(userId)?.trim();
  return name ? { kind: "name", name } : { kind: "teammate" };
}
