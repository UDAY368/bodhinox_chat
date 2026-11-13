'use client';

/**
 * The sidebar: eight sections (Inbox, Contacts, Automation, Campaigns, Sales, AI, Analytics,
 * Settings). Each section's pages appear as tabs above the page (SectionTabs), so the sidebar
 * stays short. Light, quiet, Apple-style; collapses to an icon rail on desktop and is a
 * drawer on phones.
 */

import Link from 'next/link';
import { KhagaIcon } from '@/components/agents/khaga-icon';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useTotalUnread } from '@/hooks/use-total-unread';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { CHANNELS_SETTINGS_PATH } from '@/lib/channels/routes';
import { addChannelPrompt } from '@/components/layout/page-search-navigation';
import { buildSections, sectionFor, type Section, type SectionId } from '@/components/layout/sections';
import {
  BarChart3,
  Crown,
  LogOut,
  MessageSquare,
  Megaphone,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Shield,
  ShoppingBag,
  User,
  UserCog,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import type { AccountRole } from '@/lib/auth/roles';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslations } from 'next-intl';

// Per-role chip in the account menu. One place, so the colours never drift.
const ROLE_CHIP: Record<AccountRole, { icon: typeof Crown; labelKey: string; className: string }> = {
  owner: { icon: Crown, labelKey: 'roleOwner', className: 'bg-amber-500/12 text-amber-700 dark:text-amber-300' },
  admin: { icon: Shield, labelKey: 'roleAdmin', className: 'bg-primary/10 text-primary' },
  agent: { icon: UserCog, labelKey: 'roleAgent', className: 'bg-muted text-foreground' },
  viewer: { icon: User, labelKey: 'roleViewer', className: 'bg-muted text-muted-foreground' },
};

const SECTION_ICONS: Record<SectionId, typeof MessageSquare> = {
  inbox: MessageSquare,
  contacts: Users,
  automation: Workflow,
  campaigns: Megaphone,
  sales: ShoppingBag,
  ai: MessageSquare,
  analytics: BarChart3,
  settings: Settings,
};

interface SidebarProps {
  compact?: boolean;
  /** Desktop: collapse the sidebar to its icon rail, or expand it. Shows the toggle when given. */
  onToggleCompact?: () => void;
  /** Controlled on mobile by the Header's menu button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose, compact = false, onToggleCompact }: SidebarProps) {
  const t = useTranslations('Sidebar');
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();
  const unread = useTotalUnread();
  const { data: channels } = useWorkspaceChannels();
  const isAdmin = useCan('edit-settings');
  // Until the channel state loads (or if it cannot), the sections assume WhatsApp, the no-row default.
  const sections = buildSections(channels?.enabled);
  const current = sectionFor(pathname, sections);
  const addChannel = addChannelPrompt(channels, isAdmin);
  const main = sections.filter((s) => s.id !== 'settings');
  const settings = sections.find((s) => s.id === 'settings')!;

  // Close the drawer when the route changes: the user opened it to navigate.
  useEffect(() => {
    onClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and close on Escape while the drawer is open on phones.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const chip = accountRole ? ROLE_CHIP[accountRole] : null;

  return (
    <>
      {/* Phone backdrop: closes the drawer. */}
      <button
        type="button"
        aria-label={t('closeMenu')}
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-30 bg-black/30 backdrop-blur-[2px] transition-opacity duration-200 lg:hidden',
          open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        )}
      />

      <aside
        className={cn(
          'studio-sidebar bg-sidebar text-sidebar-foreground fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col',
          compact && 'studio-sidebar-compact',
          'transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] will-change-transform',
          open ? 'visible translate-x-0 shadow-2xl' : 'invisible -translate-x-full',
          'lg:visible lg:static lg:z-0 lg:w-[232px] lg:translate-x-0 lg:shadow-none lg:transition-none'
        )}
        aria-label={t('primaryNav')}
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-5">
          <Link href={sections[0].href} aria-label={t('title')} className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-primary">
            <span aria-hidden className="bg-primary flex h-7 w-7 items-center justify-center rounded-[9px] shadow-[inset_0_0_0_6px_rgb(255_255_255/0.22)]" />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">{t('title')}</span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeMenu')}
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex h-9 w-9 items-center justify-center rounded-lg lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-3">
          <ul className="flex flex-col gap-0.5">
            {main.map((section) => (
              <SectionLink key={section.id} section={section} active={current?.id === section.id}
                unread={section.unread ? unread[section.unread] : 0} />
            ))}
          </ul>
          {addChannel && (
            <Link
              href={CHANNELS_SETTINGS_PATH}
              title={t('addInstagram')}
              data-nav-add-channel={addChannel.channel}
              className="studio-sidebar-link text-muted-foreground hover:bg-sidebar-accent hover:text-foreground mt-4 flex min-h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150"
            >
              <Plus className="h-4 w-4" />
              <span className="flex-1">{t('addInstagram')}</span>
              {addChannel.upgrade && (
                <span data-nav-upgrade="" className="rounded-full bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  {t('upgrade')}
                </span>
              )}
            </Link>
          )}
        </nav>

        <div className="shrink-0 px-3 pb-3">
          <ul className="flex flex-col gap-0.5">
            {/* A channel that needs attention (a lost connection) shows as a dot on Settings, where it is fixed. */}
            <SectionLink section={settings} active={current?.id === 'settings'} unread={0}
              attention={(['whatsapp', 'instagram'] as const).some((c) => channels?.channels[c]?.enabled && channels.channels[c].state === 'attention')} />
          </ul>
          {onToggleCompact && (
            <button
              type="button"
              data-testid="sidebar-collapse"
              aria-expanded={!compact}
              onClick={onToggleCompact}
              title={compact ? t('expandSidebar') : t('collapseSidebar')}
              className="studio-sidebar-link text-muted-foreground hover:bg-sidebar-accent hover:text-foreground mt-0.5 hidden min-h-10 w-full items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 lg:flex"
            >
              {compact ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              <span className="flex-1 text-left">{compact ? t('expandSidebar') : t('collapseSidebar')}</span>
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger className="hover:bg-sidebar-accent focus-visible:bg-sidebar-accent data-popup-open:bg-sidebar-accent mt-2 flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 focus:outline-none">
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? <AvatarImage src={profile.avatar_url} alt={profile.full_name ?? t('defaultAvatar')} /> : null}
                <AvatarFallback className="bg-primary/12 text-primary text-sm font-semibold">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ?? profile?.email?.charAt(0)?.toUpperCase() ?? 'U'}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{profile?.full_name ?? t('defaultUser')}</p>
                <p className="text-muted-foreground truncate text-[11px]" title={account?.name ?? undefined}>
                  {account?.name ?? profile?.email ?? ''}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={6} className="bg-popover text-popover-foreground ring-border min-w-60">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{account?.name ?? profile?.full_name}</p>
                  <p className="text-muted-foreground truncate text-xs">{profile?.email}</p>
                </div>
                {chip && (
                  <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', chip.className)}>
                    <chip.icon className="size-3" />
                    {t(chip.labelKey)}
                  </span>
                )}
              </div>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem render={<Link href="/settings?tab=profile" onClick={onClose} />}>
                <User className="size-4" />
                {t('menuProfile')}
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings" onClick={onClose} />}>
                <Settings className="size-4" />
                {t('menuSettings')}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem onClick={signOut}>
                <LogOut className="size-4" />
                {t('menuSignOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}

/** One section row: icon, label and the unread dot (Inbox). */
function SectionLink({ section, active, unread, attention = false }: { section: Section; active: boolean; unread: number; attention?: boolean }) {
  const t = useTranslations('Sidebar');
  const Icon = SECTION_ICONS[section.id];
  const label = t(section.labelKey);
  return (
    <li>
      <Link
        href={section.href}
        title={label}
        data-nav-section={section.id}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'studio-sidebar-link group flex min-h-11 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 lg:min-h-10',
          active
            ? 'bg-sidebar-accent text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_14px_rgb(0_0_0/0.05)] dark:shadow-none'
            : 'text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground'
        )}
      >
        {section.id === 'ai'
          ? <KhagaIcon className={cn('-mx-1 h-6 w-6', active && 'text-primary')} />
          : <Icon className={cn('h-[18px] w-[18px]', active && 'text-primary')} />}
        <span className="flex-1">{label}</span>
        {attention && (
          <span data-nav-attention="" role="img" aria-label={t('groups.needsAttention')} title={t('groups.needsAttention')}
            className="h-2 w-2 rounded-full bg-amber-500" />
        )}
        {/* Hidden while the inbox is open: the list itself shows what is unread. */}
        {unread > 0 && !active && (
          <span
            data-nav-unread={section.unread}
            aria-label={t('unreadConversations', { count: unread })}
            className="bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Link>
    </li>
  );
}
