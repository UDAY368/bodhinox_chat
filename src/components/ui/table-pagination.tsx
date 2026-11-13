'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The page buttons to show for a 0-based `page` of `total` pages: always the
 * first and last, the current page with one neighbour each side, and 'gap'
 * where pages are skipped. Seven or fewer pages are all shown.
 */
export function pageItems(page: number, total: number): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const start = Math.max(1, Math.min(page - 1, total - 5));
  const end = Math.min(total - 2, Math.max(page + 1, 4));
  const items: Array<number | 'gap'> = [0];
  if (start > 1) items.push('gap');
  for (let i = start; i <= end; i++) items.push(i);
  if (end < total - 2) items.push('gap');
  items.push(total - 1);
  return items;
}

interface TablePaginationProps {
  /** 0-based current page. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** "Showing 1–25 of 40", already translated. */
  summary: string;
  labels: { nav: string; previous: string; next: string; page: (n: number) => string };
  className?: string;
}

const PAGE_BTN =
  'inline-flex size-8 items-center justify-center rounded-lg text-[13px] tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

/** A table footer: the row summary on the left, numbered page buttons on the right. */
export function TablePagination({ page, totalPages, onPageChange, summary, labels, className }: TablePaginationProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 px-4 py-3', className)}>
      <p className="text-muted-foreground text-[13px] tabular-nums">{summary}</p>
      {totalPages > 1 && (
        <nav aria-label={labels.nav} className="flex items-center gap-1">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
            aria-label={labels.previous}
            className={cn(PAGE_BTN, 'text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30')}
          >
            <ChevronLeft className="size-4" />
          </button>
          {pageItems(page, totalPages).map((item, index) =>
            item === 'gap' ? (
              <span key={`gap-${index}`} aria-hidden className="text-muted-foreground w-6 text-center text-[13px]">
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                onClick={() => onPageChange(item)}
                aria-label={labels.page(item + 1)}
                aria-current={item === page ? 'page' : undefined}
                className={cn(
                  PAGE_BTN,
                  'min-w-8 px-2',
                  item === page
                    ? 'bg-foreground text-background font-semibold'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {item + 1}
              </button>
            )
          )}
          <button
            type="button"
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
            aria-label={labels.next}
            className={cn(PAGE_BTN, 'text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30')}
          >
            <ChevronRight className="size-4" />
          </button>
        </nav>
      )}
    </div>
  );
}
