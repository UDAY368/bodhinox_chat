'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { useUnreadNotifications } from '@/hooks/use-unread-notifications';
import {
  Bell,
  ChevronRight,
  LogOut,
  Menu,
  Settings as SettingsIcon,
  User,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModeToggle } from '@/components/layout/mode-toggle';
import { PageSearch } from '@/components/layout/page-search';
import { breadcrumbFor, buildSections } from '@/components/layout/sections';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { cn } from '@/lib/utils';

interface HeaderProps {
  showMenuToggle?: boolean;
  menuExpanded?: boolean;
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
}

import { useTranslations } from 'next-intl';

export function Header({ onOpenSidebar, showMenuToggle = false, menuExpanded }: HeaderProps) {
  const t = useTranslations('Header');
  const nav = useTranslations('Sidebar');
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const unreadNotifications = useUnreadNotifications();
  const { data: channels } = useWorkspaceChannels();
  // Where the page sits (Sales › Orders); the page itself shows the one large title.
  const crumbs = breadcrumbFor(pathname, buildSections(channels?.enabled));

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    'U';

  return (
    <header className="studio-header material-chrome border-border flex h-[60px] shrink-0 items-center justify-between gap-3 border-b px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Menu: phones only (and the full-screen flow editor). 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={t('openMenu')}
          aria-expanded={showMenuToggle ? menuExpanded : undefined}
          className={`text-muted-foreground hover:bg-muted hover:text-foreground flex h-10 w-10 pointer-coarse:size-11 items-center justify-center rounded-lg transition-colors${showMenuToggle ? '' : ' lg:hidden'}`}
        >
          <Menu className="h-5 w-5" />
        </button>
        {crumbs.length > 0 && (
          <nav aria-label={nav('breadcrumb')} className="min-w-0">
            <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
              {crumbs.map((crumb, i) => {
                const last = i === crumbs.length - 1;
                return (
                  // Phones show only the last crumb.
                  <li key={crumb.labelKey} className={cn('min-w-0 items-center gap-1.5', last ? 'flex' : 'hidden sm:flex')}>
                    {i > 0 && <ChevronRight aria-hidden className="text-muted-foreground/60 hidden size-3.5 shrink-0 sm:block" />}
                    {crumb.href ? (
                      <Link href={crumb.href} className="text-muted-foreground hover:text-foreground truncate rounded transition-colors focus-visible:outline-2 focus-visible:outline-primary">
                        {nav(crumb.labelKey)}
                      </Link>
                    ) : (
                      <span aria-current="page" className="text-foreground truncate font-semibold">{nav(crumb.labelKey)}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
      </div>


      <div className="flex items-center gap-1 sm:gap-1.5">
        <PageSearch />
        <Link
          href="/notifications"
          aria-label={unreadNotifications ? t('notificationsUnread', { count: unreadNotifications }) : t('notifications')}
          title={t('notifications')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground relative flex h-9 w-9 pointer-coarse:size-11 items-center justify-center rounded-lg transition-colors"
        >
          <Bell className="h-[18px] w-[18px]" />
          {unreadNotifications > 0 && (
            <span className="bg-primary text-primary-foreground ring-card absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ring-2">
              {unreadNotifications > 9 ? '9+' : unreadNotifications}
            </span>
          )}
        </Link>
        <ModeToggle />

        {/* The account menu lives in the sidebar on desktop; phones keep it here. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="hover:bg-muted/70 focus:bg-muted/70 data-popup-open:bg-muted/70 flex items-center gap-2 rounded-lg px-1 py-1 transition-colors focus:outline-none lg:hidden"
            aria-label={t('openAccountMenu')}
          >
            <Avatar className="size-8">
              {profile?.avatar_url ? (
                <AvatarImage
                  src={profile.avatar_url}
                  alt={profile.full_name ?? t('defaultAvatar')}
                />
              ) : null}
              <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                {initial}
              </AvatarFallback>
            </Avatar>
            <span className="text-foreground hidden max-w-32 truncate text-xs font-medium xl:inline">
              {profile?.full_name ?? t('defaultUser')}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="bg-popover text-popover-foreground ring-border min-w-56"
          >
            <div className="px-2 py-1.5">
              <p className="text-foreground truncate text-sm font-medium">
                {profile?.full_name ?? t('defaultUser')}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {profile?.email ?? ''}
              </p>
            </div>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              render={
                <Link
                  href="/settings?tab=profile"
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
                  className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                />
              }
            >
              <SettingsIcon className="size-4" />
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
    </header>
  );
}
