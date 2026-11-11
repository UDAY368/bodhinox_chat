/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
'use client';

// Stage 5 contract (5A mounts it in Settings › Inbox; 5E implements it): the
// automatic assignment mode (off, basic, rules) and each agent's capacity
// (workspace_inbox_settings.auto_assign_mode through PUT /api/inbox/settings,
// account_memberships.max_open_conversations through
// PUT /api/account/members/[id]/capacity). Renders nothing until 5E lands.
export function AssignmentModeCard(_props: { canEdit: boolean }) {
  return null;
}
