'use client';

// Tax invoices, newest first. Each opens as a printable page (save as PDF from the browser).
// The page is fetched with the access cookie, which lasts 15 minutes, so the
// session is refreshed first: a plain link from a long-open tab would get a 401.

import { ExternalLink } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { createAuthClient } from '@/lib/auth/client';
import { openInNewTab } from './open-tab';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAmount, formatDay, type InvoiceRow } from './types';

export async function viewInvoice(id: string): Promise<'opened' | 'same_tab' | 'signed_out'> {
  const url = `/api/billing/invoices/${encodeURIComponent(id)}?format=html`;
  try {
    const { opened } = await openInNewTab(async () => {
      const { data } = await createAuthClient().getSession();
      if (!data.session) throw new Error('signed_out');
      return url;
    });
    if (opened) return 'opened';
  } catch {
    return 'signed_out';
  }
  // The browser blocked the tab: the invoice is on this site, so open it here.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- an API document, not a Next.js page
  window.location.assign(url);
  return 'same_tab';
}

export function InvoicesTable({ invoices }: { invoices: InvoiceRow[] }) {
  const t = useTranslations('Billing.invoices');
  const locale = useLocale();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {!invoices.length ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('number')}</TableHead>
                <TableHead>{t('date')}</TableHead>
                <TableHead>{t('period')}</TableHead>
                <TableHead className="text-right">{t('total')}</TableHead>
                <TableHead><span className="sr-only">{t('view')}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-xs">{inv.number}</TableCell>
                  <TableCell>{formatDay(inv.issuedAt, locale)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {inv.periodStart ? `${formatDay(inv.periodStart, locale)} – ${formatDay(inv.periodEnd, locale)}` : ''}
                  </TableCell>
                  <TableCell className="text-right">{formatAmount(inv.totalMinor, inv.currency, locale)}</TableCell>
                  <TableCell className="text-right">
                    <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline"
                      onClick={() => void viewInvoice(inv.id).then((r) => { if (r === 'signed_out') toast.error(t('signedOut')); })}>
                      {t('view')}<ExternalLink className="size-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
