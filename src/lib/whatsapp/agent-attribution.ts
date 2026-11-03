// messages.sender_id is the member who wrote an outbound message. Only an
// inbox send by a signed-in member stamps it; bot, flow, automation, AI and
// public-API sends leave it null even when they run under a member's id (the
// flow engine runs as the flow's owner), so analytics never credits a member
// with a reply they did not write.

export function agentSenderId(sender: 'agent' | 'bot', userId: string | null | undefined): string | null {
  return sender === 'agent' && userId ? userId : null;
}
