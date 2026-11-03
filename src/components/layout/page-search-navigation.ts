export const navigationPages = [
  { href: '/dashboard', labelKey: 'dashboard' },
  { href: '/analytics', labelKey: 'analytics' },
  { href: '/inbox', labelKey: 'inbox' },
  { href: '/notifications', labelKey: 'notifications' },
  { href: '/contacts', labelKey: 'contacts' },
  { href: '/pipelines', labelKey: 'pipelines' },
  { href: '/broadcasts', labelKey: 'broadcasts' },
  { href: '/ads', labelKey: 'ads' },
  { href: '/automations', labelKey: 'automations' },
  { href: '/flows', labelKey: 'flows' },
  { href: '/forms', labelKey: 'forms' },
  { href: '/agents', labelKey: 'aiAgents' },
  { href: '/commerce/orders', labelKey: 'orders' },
  { href: '/commerce/products', labelKey: 'products' },
  { href: '/commerce/payments', labelKey: 'payments' },
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
