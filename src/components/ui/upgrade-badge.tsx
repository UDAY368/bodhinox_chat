'use client';

// Marks a control the workspace plan does not include. The server still
// enforces the plan; this only explains why the control is unavailable.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

/** Sits beside a disabled control, never inside a button: it is a link. */
export function UpgradeBadge() {
  const t = useTranslations('Plan');
  return (
    <Link
      href="/settings?tab=plan"
      title={t('upgradeHint')}
      className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
    >
      {t('upgrade')}
    </Link>
  );
}
