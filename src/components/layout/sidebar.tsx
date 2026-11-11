'use client';

import Link from 'next/link';
import { KhagaIcon } from '@/components/agents/khaga-icon';
import { usePathname } from 'next/navigation';
import { Fragment, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useTotalUnread } from '@/hooks/use-total-unread';
import { useUnreadNotifications } from '@/hooks/use-unread-notifications';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { CHANNELS_SETTINGS_PATH } from '@/lib/channels/routes';
import {
  addChannelPrompt,
  buildNavigation,
  type NavPage,
} from '@/components/layout/page-search-navigation';
import {
  BarChart3,
  Bell,
  Bot,
  CalendarCheck,
  ClipboardList,
  CreditCard,
  Crown,
  FileText,
  GitBranch,
  House,
  Inbox,
  LayoutDashboard,
  Link2,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  MessageSquare,
  MessageSquareReply,
  MessagesSquare,
  Package,
  Plus,
  Boxes,
  Store,
  Radio,
  Settings,
  Shield,
  ShoppingBag,
  Sun,
  TrendingUp,
  User,
  UserCog,
  Users,
  UsersRound,
  Wand2,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type { AccountRole } from '@/lib/auth/roles';

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: 'roleOwner',
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  admin: {
    icon: Shield,
    labelKey: 'roleAdmin',
    // Primary-tinted: significant but not as scarce as owner.
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  agent: {
    icon: UserCog,
    labelKey: 'roleAgent',
    // Neutral slate: the operational default.
    className: 'border-border bg-muted text-foreground',
  },
  viewer: {
    icon: User,
    labelKey: 'roleViewer',
    // Muted slate: read-only role; visually quieter than agent.
    className: 'border-border bg-card text-muted-foreground',
  },
};
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
}

// Icons for the Workspace and channel entries built by buildNavigation.
const NAV_ICONS: Record<string, typeof LayoutDashboard> = {
  allInboxes: Inbox,
  home: House,
  dashboard: LayoutDashboard,
  analytics: BarChart3,
  inbox: MessageSquare,
  notifications: Bell,
  contacts: Users,
  pipelines: GitBranch,
  broadcasts: Radio,
  templates: FileText,
  ads: Megaphone,
  automations: Zap,
  flows: Workflow,
  forms: ClipboardList,
  comments: MessageCircle,
  conversationStarters: MessagesSquare,
  defaultReply: MessageSquareReply,
  quickAutomations: Wand2,
  refLinks: Link2,
  menu: Menu,
  insights: TrendingUp,
  appointments: CalendarCheck,
  aiAgents: Bot,
};

const isActivePath = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

const commerceNavItems: NavItem[] = [
  { href: '/commerce/orders', labelKey: 'orders', icon: ShoppingBag },
  { href: '/commerce/catalogue', labelKey: 'catalogue', icon: Boxes },
  { href: '/commerce/products', labelKey: 'products', icon: Package },
  { href: '/commerce/payments', labelKey: 'payments', icon: CreditCard },
  { href: '/commerce/settings', labelKey: 'storeSettings', icon: Store },
];

const bottomNavItems = [
  { href: '/settings', labelKey: 'settings', icon: Settings },
];

interface SidebarProps {
  compact?: boolean;
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

import { useTranslations } from 'next-intl';

export function Sidebar({ open = false, onClose, compact = false }: SidebarProps) {
  const t = useTranslations('Sidebar');
  const pathname = usePathname();
  const { profile, profileLoading, account, accountRole, signOut } = useAuth();
  const unread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  const { data: channels } = useWorkspaceChannels();
  const isAdmin = useCan('edit-settings');
  // Until the channel state loads (or if it cannot), the nav shows the
  // no-row default, WhatsApp, which is what every pre-Stage-1 workspace uses.
  const groups = buildNavigation(channels?.enabled);
  const addChannel = addChannelPrompt(channels, isAdmin);
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading && !!account?.name && account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t('closeMenu')}
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={cn(
          'bg-background/70 fixed inset-0 z-30 backdrop-blur-sm transition-opacity lg:hidden',
          open
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          'studio-sidebar fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col border-r border-white/10 bg-[#111110] text-[#f6f4ef]',
          compact && 'studio-sidebar-compact',
          'transition-transform duration-200 ease-out will-change-transform',
          open ? 'visible translate-x-0' : 'invisible -translate-x-full',
          // Desktop: static, always visible — reset all the mobile framing.
          'lg:visible lg:static lg:z-0 lg:w-[244px] lg:translate-x-0 lg:transition-none'
        )}
        aria-label={t('primaryNav')}
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div className="flex h-[96px] shrink-0 items-center justify-between gap-2 px-6">
          <Link href="/dashboard" aria-label={t('title')} className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center text-[#d58a50]">
              <Sun className="h-9 w-9" strokeWidth={1.5} />
            </div>
            <span className="text-[15px] font-semibold tracking-[-0.5px] text-[#f6f4ef]">
              {t('title')}
              <span className="mt-1 block text-[8px] font-medium tracking-[2px] text-[#8b8883]">
                {t('studio')}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeMenu')}
            className="flex h-10 w-10 items-center justify-center rounded-md text-[#a6a29b] hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-[18px] pb-4">
          {groups.map((group, index) => {
            const attention =
              group.id !== 'workspace' && channels?.channels[group.id]?.state === 'attention';
            // A fragment, not a wrapper: the group header must stay a direct
            // child of <nav> so the compact sidebar's `nav > p` rule hides it.
            return (
              <Fragment key={group.id}>
                <p
                  id={`nav-group-${group.id}`}
                  data-nav-group={group.id}
                  className={cn(
                    'flex items-center gap-2 px-3 pb-3 text-[9px] font-semibold tracking-[1.8px] text-[#7b7771] uppercase',
                    index === 0 ? 'pt-2' : 'pt-7'
                  )}
                >
                  {t(`groups.${group.id}`)}
                  {attention && (
                    <span
                      data-nav-attention=""
                      role="img"
                      aria-label={t('groups.needsAttention')}
                      title={t('groups.needsAttention')}
                      className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-400"
                    />
                  )}
                </p>
                <ul aria-labelledby={`nav-group-${group.id}`} className="flex flex-col gap-1">
                  {group.pages.map((page) => (
                    <SidebarLink
                      key={page.href}
                      page={page}
                      // Names the channel on hover, as the compact sidebar hides the group headers.
                      title={group.id === 'workspace' ? undefined : `${t(`groups.${group.id}`)} · ${t(page.labelKey)}`}
                      active={isActivePath(pathname, page.href)}
                      unread={page.unread ? unread[page.unread] : 0}
                      unreadNotifications={unreadNotifications}
                    />
                  ))}
                </ul>
              </Fragment>
            );
          })}

          {addChannel && (
            <Link
              href={CHANNELS_SETTINGS_PATH}
              data-nav-add-channel={addChannel.channel}
              className="studio-sidebar-link mt-3 flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-2.5 text-[12px] font-medium text-[#7b7771] transition-colors hover:bg-[#272624] hover:text-white lg:min-h-[41px] lg:py-2"
            >
              <Plus className="h-4 w-4" />
              <span className="flex-1">{t('addInstagram')}</span>
              {addChannel.upgrade && (
                <span
                  data-nav-upgrade=""
                  className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-amber-300 uppercase"
                >
                  {t('upgrade')}
                </span>
              )}
            </Link>
          )}

          <p className="px-3 pt-7 pb-3 text-[9px] font-semibold tracking-[1.8px] text-[#7b7771] uppercase">
            {t('commerce')}
          </p>
          <ul className="flex flex-col gap-1">
            {commerceNavItems.map((item) => {
              const isActive = isActivePath(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'studio-sidebar-link flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-2.5 text-[12px] font-medium transition-colors lg:min-h-[41px] lg:py-2',
                      isActive
                        ? 'bg-[#30251d] text-[#f9e3cc] shadow-[inset_2px_0_#c9793e]'
                        : 'text-[#a6a29b] hover:bg-[#272624] hover:text-white'
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {t(item.labelKey)}
                  </Link>
                </li>
              );
            })}
          </ul>

          <p className="px-3 pt-7 pb-3 text-[9px] font-semibold tracking-[1.8px] text-[#7b7771] uppercase">
            {t('preferences')}
          </p>

          <ul className="flex flex-col gap-1">
            {bottomNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'studio-sidebar-link flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-2.5 text-[12px] font-medium transition-colors lg:min-h-[41px] lg:py-2',
                      isActive
                        ? 'bg-[#30251d] text-[#f9e3cc] shadow-[inset_2px_0_#c9793e]'
                        : 'text-[#a6a29b] hover:bg-[#272624] hover:text-white'
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {t(item.labelKey as string)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-white/10 p-3">
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div className="mb-2 flex items-center gap-2 px-3 text-xs text-[#a6a29b]">
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole
                ? // Always render the chip — owners used to be
                  // invisible here, which made them indistinguishable
                  // from admins at a glance. Now everyone sees their
                  // role (with a colour cue) regardless of tier.
                  (() => {
                    const meta = ROLE_CHIP[accountRole];
                    const Icon = meta.icon;
                    return (
                      <span
                        className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase ${meta.className}`}
                      >
                        <Icon className="size-3" />
                        {t(meta.labelKey as string)}
                      </span>
                    );
                  })()
                : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none data-popup-open:bg-white/5">
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t('defaultAvatar')}
                  />
                ) : null}
                <AvatarFallback className="bg-[#ae673e] text-sm font-medium text-white">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    'U'}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-[#f6f4ef]">
                  {profile?.full_name ?? t('defaultUser')}
                </p>
                <p className="mt-1 truncate text-[10px] text-[#8b8883]">
                  {profile?.email ?? ''}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="bg-popover text-popover-foreground ring-border min-w-56"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t('menuProfile')}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                {t('menuSettings')}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
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

/** One nav row: icon, label, the Beta chip and its unread badge. */
function SidebarLink({
  page,
  title,
  active,
  unread,
  unreadNotifications,
}: {
  page: NavPage;
  /** Hover text naming the channel ("WhatsApp · Inbox"); none for Workspace pages. */
  title?: string;
  active: boolean;
  /** Unread conversations behind this entry: its channel's, or every channel's for All inboxes. */
  unread: number;
  unreadNotifications: number;
}) {
  const t = useTranslations('Sidebar');
  const Icon = NAV_ICONS[page.labelKey] ?? LayoutDashboard;
  // Each inbox's dot hides while that inbox is open.
  const showUnreadDot = !!page.unread && unread > 0 && !active;
  // Unlike the inbox dot, the notifications count stays visible even while
  // the page is active: it reflects unread state (cleared by marking
  // notifications read), not "currently viewing this section".
  const showNotificationBadge = page.href === '/notifications' && unreadNotifications > 0;
  return (
    <li>
      <Link
        href={page.href}
        title={title}
        aria-current={active ? 'page' : undefined}
        className={cn(
          // Taller on mobile so fingers can hit the row reliably (≥44px).
          'studio-sidebar-link flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-2.5 text-[12px] font-medium transition-colors lg:min-h-[41px] lg:py-2',
          active
            ? 'bg-[#30251d] text-[#f9e3cc] shadow-[inset_2px_0_#c9793e]'
            : 'text-[#a6a29b] hover:bg-[#272624] hover:text-white'
        )}
      >
        {page.labelKey === 'aiAgents' ? <KhagaIcon className="-mx-1 h-6 w-6" /> : <Icon className="h-4 w-4" />}
        <span className="flex-1">{t(page.labelKey)}</span>
        {page.beta && (
          <span
            data-nav-beta=""
            aria-label={t('beta')}
            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-amber-300 uppercase"
          >
            {t('beta')}
          </span>
        )}
        {showUnreadDot && (
          <span
            data-nav-unread={page.unread}
            aria-label={t('unreadConversations', { count: unread })}
            className="relative flex h-2 w-2"
          >
            <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
            <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
          </span>
        )}
        {showNotificationBadge && (
          <span
            aria-label={t('unreadNotifications', { count: unreadNotifications })}
            className="bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
          >
            {unreadNotifications > 9 ? '9+' : unreadNotifications}
          </span>
        )}
      </Link>
    </li>
  );
}
