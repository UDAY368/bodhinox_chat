export const navigationPages = [
  { href: '/dashboard', labelKey: 'dashboard' },
  { href: '/inbox', labelKey: 'inbox' },
  { href: '/notifications', labelKey: 'notifications' },
  { href: '/contacts', labelKey: 'contacts' },
  { href: '/pipelines', labelKey: 'pipelines' },
  { href: '/broadcasts', labelKey: 'broadcasts' },
  { href: '/automations', labelKey: 'automations' },
  { href: '/flows', labelKey: 'flows' },
  { href: '/agents', labelKey: 'aiAgents' },
  { href: '/settings', labelKey: 'settings' },
];

export function filterPages(query: string, label: (key: string) => string) {
  const search = query.trim().toLocaleLowerCase();
  return navigationPages.filter((page) =>
    `${label(page.labelKey)} ${page.href}`.toLocaleLowerCase().includes(search)
  );
}

export function getPageTitleKey(pathname: string): string {
  return (
    navigationPages.find(
      (page) => pathname === page.href || pathname.startsWith(`${page.href}/`)
    )?.labelKey ?? 'dashboard'
  );
}
