'use client';
import { authFetch } from "@/lib/auth/client";

// ============================================================
// MembersTab — Settings → Members
//
// Two stacked sections:
//   1. Roster   — every member of the account. Admin+ can change a
//                 teammate's role inline and remove them. Owner row
//                 is non-editable everywhere (transfer is its own
//                 separate flow, deferred to a later PR).
//   2. Pending  — outstanding invite links. Admin+ can revoke. The
//                 plaintext URL is gone after the create dialog
//                 closes, so we surface a "revoke + new link" hint
//                 rather than pretending we can resurface it.
//
// Role-gating
//   The tab itself is reachable by any member, but mutation buttons
//   are wrapped in `<RequireRole min="admin">` / `useCan` so an
//   agent or viewer sees the roster read-only. The server-side
//   RPCs (set_member_role, remove_account_member) double-check
//   the role anyway.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Mail,
  MailX,
  Plus,
  Trash2,
} from 'lucide-react';

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { PageLoading } from '@/components/ui/page-loading';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import type { AccountRole } from '@/lib/auth/roles';
import { presenceLabel, summarize } from '@/lib/presence';
import {
  PRESENCE_DOT_CLASS,
  PresenceDot,
} from '@/components/presence/presence-dot';
import { InviteMemberDialog } from './invite-member-dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup, SettingsMoreMenu } from './settings-row';
import { ROLE_META } from './role-meta';

interface Member {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
  /** Admins only: customers' numbers are masked for this member. */
  mask_phone_numbers?: boolean;
}

interface Invitation {
  id: string;
  role: 'admin' | 'agent' | 'viewer';
  label: string | null;
  created_at: string;
  expires_at: string;
}

// These roles are translated via `useTranslations("Settings.roles")` where they are used.
const EDITABLE_ROLES: { value: AccountRole }[] = [
  { value: 'admin' },
  { value: 'agent' },
  { value: 'viewer' },
];

// Per-role chip metadata (icon / label / colour) lives in the shared
// ROLE_META module so this roster and the Overview identity chip can't
// drift. The colour scale runs amber (owner — scarce, immutable) →
// primary (admin) → muted (agent / viewer).

function fmtDate(iso: string): string {
  // Match the rest of the dashboard's locale-light formatting.
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtExpiresIn(iso: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t('expired');
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return t('expiresInDays', { days });
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return t('expiresInHours', { hours });
}

export function MembersTab() {
  const t = useTranslations('Settings.members');
  const tRoles = useTranslations('Settings.roles');
  const { user, canManageMembers } = useAuth();
  const { getPresence, getRow, now } = usePresence();

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteOpen, setInviteOpen] = useState(false);
  const confirm = useConfirm();
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(
    null,
  );

  const loadEverything = useCallback(async () => {
    try {
      const [mres, ires] = await Promise.all([
        authFetch('/api/account/members', { cache: 'no-store' }),
        canManageMembers
          ? authFetch('/api/account/invitations', { cache: 'no-store' })
          : Promise.resolve(null),
      ]);

      if (!mres.ok) {
        const payload = await mres.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const mdata = (await mres.json()) as { members: Member[] };
      setMembers(mdata.members);

      if (ires) {
        if (!ires.ok) {
          const payload = await ires.json().catch(() => ({}));
          toast.error(payload.error || t('loadInvitationsFailed'));
          return;
        }
        const idata = (await ires.json()) as { invitations: Invitation[] };
        setInvitations(idata.invitations);
      } else {
        setInvitations([]);
      }
    } catch (err) {
      console.error('[MembersTab] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [canManageMembers, t]);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  async function handleRoleChange(member: Member, nextRole: AccountRole) {
    if (member.role === nextRole) return;
    // Optimistic update — flip the dropdown immediately so the UI
    // feels snappy. If the server PATCH fails we revert below so
    // the dropdown doesn't lie about the persisted state.
    const previousRole = member.role;
    setPendingMemberAction(member.user_id);
    setMembers((prev) =>
      prev.map((m) =>
        m.user_id === member.user_id ? { ...m, role: nextRole } : m,
      ),
    );
    try {
      const res = await authFetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        // Revert the optimistic flip. The toast on its own wasn't
        // enough — the dropdown was left showing the new role
        // forever, so the next interaction operated on a wrong
        // baseline (re-trying the same change would no-op via the
        // `member.role === nextRole` guard at the top).
        setMembers((prev) =>
          prev.map((m) =>
            m.user_id === member.user_id ? { ...m, role: previousRole } : m,
          ),
        );
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('updateRoleFailed'));
        return;
      }
      toast.success(t('updatedToast', { name: member.full_name || t('unnamed'), role: tRoles(nextRole) }));
    } catch (err) {
      // Same revert on network failure.
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, role: previousRole } : m,
        ),
      );
      console.error('[MembersTab] role change error:', err);
      toast.error(t('networkError'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleMaskChange(member: Member, mask: boolean) {
    setPendingMemberAction(member.user_id);
    try {
      const res = await authFetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mask_phone_numbers: mask }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('maskFailed'));
        return;
      }
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, mask_phone_numbers: mask } : m,
        ),
      );
      toast.success(
        t(mask ? 'maskedToast' : 'unmaskedToast', {
          name: member.full_name || t('unnamed'),
        }),
      );
    } catch (err) {
      console.error('[MembersTab] mask change error:', err);
      toast.error(t('networkError'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRemove(removingMember: Member) {
    const ok = await confirm({
      title: t('removeDialogTitle'),
      body: t.rich('removeDialogDesc', {
        name: removingMember.full_name || t('unnamed'),
        bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
      }),
      confirmLabel: t('removeBtn'),
      cancelLabel: t('cancel'),
      destructive: true,
    });
    if (!ok) return;
    setPendingMemberAction(removingMember.user_id);
    try {
      const res = await authFetch(
        `/api/account/members/${removingMember.user_id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('removeFailed'));
        return;
      }
      toast.success(t('removedToast', { name: removingMember.full_name || t('unnamed') }));
      setMembers((prev) =>
        prev.filter((m) => m.user_id !== removingMember.user_id),
      );
    } catch (err) {
      console.error('[MembersTab] remove error:', err);
      toast.error(t('networkError'));
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRevoke(invite: Invitation) {
    try {
      const res = await authFetch(`/api/account/invitations/${invite.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('revokeFailed'));
        return;
      }
      toast.success(t('revokedToast'));
      setInvitations((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      console.error('[MembersTab] revoke error:', err);
      toast.error(t('networkError'));
    }
  }

  if (loading) {
    return (
      <PageLoading rows={5} />
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setInviteOpen(true)}>
              <Plus className="size-4" />
              {t('inviteMember')}
            </Button>
          </RequireRole>
        }
      />

      {/* Roster: one grouped list; the presence summary is its footer note.
          Live: updates without a full refresh as heartbeats land. */}
      <SettingsGroup
        title={t('memberCount', { count: members.length })}
        footer={members.length > 0 ? (() => {
          const counts = summarize(members.map((m) => getPresence(m.user_id)));
          return (
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="online" />
                {counts.online} {t('online')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="away" />
                {counts.away} {t('away')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PresenceDot status="offline" />
                {counts.offline} {t('offline')}
              </span>
            </span>
          );
        })() : undefined}
      >
          <ul>
            {members.map((member) => {
              const roleMeta = ROLE_META[member.role];
              const RoleIcon = roleMeta.icon;
              const isSelf = member.user_id === user?.id;
              const isOwnerRow = member.role === 'owner';
              const isBusy = pendingMemberAction === member.user_id;
              const presence = getPresence(member.user_id);
              const presenceRow = getRow(member.user_id);
              const presenceText = presenceLabel(
                presence,
                presenceRow?.last_seen_at ?? null,
                now,
              );

              return (
                <li
                  key={member.user_id}
                  // Mobile: stack identity (avatar+name+email) above the
                  // role/remove actions so the role dropdown's fixed
                  // 128px width doesn't force the name into a 50-pixel
                  // truncation. Desktop (sm+): everything inline as
                  // before.
                  className={`${SETTINGS_ROW_HAIRLINE} flex min-h-11 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Avatar className="size-9 shrink-0">
                            {member.avatar_url ? (
                              <AvatarImage
                                src={member.avatar_url}
                                alt={member.full_name || t('memberAlt')}
                              />
                            ) : null}
                            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                              {(member.full_name || member.email || 'U')
                                .charAt(0)
                                .toUpperCase()}
                            </AvatarFallback>
                            {/* role+label so screen readers announce
                                presence — the hover tooltip alone isn't
                                reachable by keyboard/AT on a non-focusable
                                avatar. */}
                            <AvatarBadge
                              role="img"
                              aria-label={presenceText}
                              className={PRESENCE_DOT_CLASS[presence]}
                            />
                          </Avatar>
                        }
                      />
                      <TooltipContent>{presenceText}</TooltipContent>
                    </Tooltip>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {member.full_name || t('unnamed')}
                        </span>
                        {isSelf && (
                          <Badge className="border-transparent bg-muted text-muted-foreground text-[11px] font-medium">
                            {t('you')}
                          </Badge>
                        )}
                      </div>
                      {member.email && (
                        <p className="truncate text-xs text-muted-foreground">
                          {member.email}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Joined date stays desktop-only. The mobile row's
                      vertical density makes the joined date noise. */}
                  <div className="hidden sm:block text-right text-xs text-muted-foreground">
                    {t('joined', { date: fmtDate(member.joined_at) })}
                  </div>

                  {/* Actions cluster. On mobile this is its own row
                      below the identity block; on desktop it sits
                      inline. Items align to the start on mobile so the
                      role dropdown lines up under the avatar. */}
                  <div className="flex items-center gap-2 sm:gap-3">
                    {/* Role display / editor. Inline Select is admin+
                        only AND not allowed on the owner row (owner
                        changes go through transfer, which lands later). */}
                    {canManageMembers && !isOwnerRow && !isSelf ? (
                      <Select
                        value={member.role}
                        onValueChange={(v) =>
                          // Base UI Select can emit null on clear. We
                          // don't expose a clear affordance, so the
                          // guard is defensive — but the typed
                          // signature requires it.
                          v && handleRoleChange(member, v as AccountRole)
                        }
                      >
                        <SelectTrigger
                          className="w-32 bg-muted border-border text-foreground"
                          disabled={isBusy}
                        >
                          <SelectValue>{tRoles(member.role)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {EDITABLE_ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {tRoles(r.value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${roleMeta.className}`}
                      >
                        <RoleIcon className="size-3.5" />
                        {tRoles(member.role)}
                      </span>
                    )}

                    {/* Phone masking (agents and viewers only; owners and admins
                        always see full numbers, the server enforces the
                        mask) and Remove (never the owner or yourself) sit
                        in the row's more menu. Admin+ only. */}
                    {canManageMembers && (
                      <SettingsMoreMenu
                        label={t('memberActions', { name: member.full_name || t('unnamed') })}
                        actions={[
                          {
                            label: member.mask_phone_numbers ? t('maskMenuOn') : t('maskMenuOff'),
                            icon: member.mask_phone_numbers ? Eye : EyeOff,
                            disabled: isBusy,
                            hidden: member.role !== 'agent' && member.role !== 'viewer',
                            onSelect: () => handleMaskChange(member, member.mask_phone_numbers !== true),
                          },
                          {
                            label: t('removeBtn'),
                            icon: Trash2,
                            destructive: true,
                            disabled: isBusy,
                            hidden: isOwnerRow || isSelf,
                            onSelect: () => void handleRemove(member),
                          },
                        ]}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
      </SettingsGroup>

      {/* Pending invitations — admin+ only. The footer states that links
          can't be re-sent, so the missing "copy link again" doesn't read as a bug. */}
      <RequireRole min="admin">
        {invitations.length === 0 ? (
          <SettingsGroup title={`${t('pendingInvitations')} · 0`}>
            <EmptyState
              icon={Mail}
              title={t('noPendingTitle')}
              action={
                <Button variant="outline" onClick={() => setInviteOpen(true)}>
                  <Plus className="size-4" />
                  {t('inviteMember')}
                </Button>
              }
              className="py-8"
            />
          </SettingsGroup>
        ) : (
          <SettingsGroup title={`${t('pendingInvitations')} · ${invitations.length}`} footer={t('inviteHint')}>
            <ul>
              {invitations.map((inv) => {
                const inviteRoleMeta = ROLE_META[inv.role];
                const InviteRoleIcon = inviteRoleMeta.icon;
                return (
                  <li key={inv.id} className={`${SETTINGS_ROW_HAIRLINE} flex min-h-11 items-center gap-4 px-4 py-3`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {inv.label || t('untitledInvite')}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${inviteRoleMeta.className}`}
                        >
                          <InviteRoleIcon className="size-3" />
                          {tRoles(inv.role)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('created', { date: fmtDate(inv.created_at) })} · {fmtExpiresIn(inv.expires_at, t)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(inv)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <MailX className="size-4" />
                      {t('revoke')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </SettingsGroup>
        )}
      </RequireRole>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={loadEverything}
      />

    </section>
  );
}
