'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { GroupedList } from '@/components/ui/grouped-list';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PageHeaderAction } from '@/components/ui/page-header';

/**
 * Settings on the design standard (Apple's way): every setting group is a grouped list (a small
 * header, one rounded group of 44px rows split by hairlines, a footer note), never a card and never a
 * card inside a card. A group keeps at most one primary action in its header; its other actions
 * (disconnect, rotate, regenerate, view log) sit in the header's "more" menu.
 */

/** The hairline above every row but the first, like GroupedListRow. Use it on custom rows in a group. */
export const SETTINGS_ROW_HAIRLINE =
  'relative not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-separator';

/** A "more" menu action. `hidden` drops it (for role- or state-dependent actions). */
export type SettingsMoreAction = PageHeaderAction & { hidden?: boolean };

/** The per-group "more" menu: 44px items, destructive ones in red. Renders nothing when empty. */
export function SettingsMoreMenu({ actions, label, className }: {
  actions: SettingsMoreAction[];
  label?: string;
  className?: string;
}) {
  const t = useTranslations('UiKit');
  const shown = actions.filter((action) => !action.hidden);
  if (shown.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label={label ?? t('more')} className={cn('size-11 sm:size-9', className)} />}
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-52">
        {shown.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem
              key={action.label}
              className="min-h-11"
              variant={action.destructive ? 'destructive' : 'default'}
              disabled={action.disabled}
              onClick={action.onSelect}
              render={action.href ? <Link href={action.href} /> : undefined}
            >
              {Icon ? <Icon className="size-4" /> : null}
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One setting group: `title` is the grouped list's header, `footer` its note underneath, `action`
 * the single primary action and `more` the rest. Children are rows (SettingsRow, SettingsSwitchRow,
 * GroupedListRow) or a padded block (SettingsBlock).
 */
export function SettingsGroup({
  id,
  title,
  footer,
  action,
  more,
  moreLabel,
  children,
  className,
  testId,
}: {
  id?: string;
  testId?: string;
  title?: ReactNode;
  footer?: ReactNode;
  action?: ReactNode;
  more?: SettingsMoreAction[];
  moreLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  const hasMore = !!more && more.some((m) => !m.hidden);
  const header = title || action || hasMore ? (
    <div className="flex min-h-9 flex-wrap items-end justify-between gap-x-3 gap-y-1">
      <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 pb-0.5 text-footnote font-semibold tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5">{title}</span>
      {action || hasMore ? (
        <span className="-mr-2 ml-auto flex shrink-0 items-center gap-1 normal-case">
          {hasMore ? <SettingsMoreMenu actions={more!} label={moreLabel} /> : null}
          {action}
        </span>
      ) : null}
    </div>
  ) : undefined;
  return (
    <div id={id} data-testid={testId} className={cn(id && 'scroll-mt-4', className)}>
      <GroupedList header={header} footer={footer}>
        {children}
      </GroupedList>
    </div>
  );
}

/** Free content inside a group (a table, a form, a list) with the row padding. */
export function SettingsBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(SETTINGS_ROW_HAIRLINE, 'px-4 py-3.5', className)}>{children}</div>;
}

/** A plain group of rows with no header (for screens that title their groups themselves). */
export function SettingsPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-group border border-separator bg-grouped-surface', className)}>
      {children}
    </div>
  );
}

/** A label/control row: label and hint on the left, the control on the right; stacked below 640px. */
export function SettingsRow({
  label,
  hint,
  htmlFor,
  error,
  errorId,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  error?: string | null;
  errorId?: string;
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className={cn(SETTINGS_ROW_HAIRLINE, 'grid min-h-11 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] sm:items-center sm:gap-6', className)}>
      <Label {...(htmlFor ? { htmlFor } : {})} className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </Label>
      <div className="flex min-w-0 flex-col sm:items-end [&>*]:w-full">
        {children}
        {error ? <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive sm:text-right">{error}</p> : null}
      </div>
    </div>
  );
}

/** A switch (or other compact control) row: title and description on the left, the control on the right. */
export function SettingsSwitchRow({ title, description, control, className }: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center gap-4 px-4 py-3', className)}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
