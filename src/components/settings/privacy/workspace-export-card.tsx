'use client';

// Settings -> Privacy & access -> Export workspace data (owners and admins).
// Requests a zip of the workspace's own data (one JSONL file per kind of data),
// built in the background; the latest exports are listed with a download link
// while ready (7 days). Users with MFA confirm their authenticator first.

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authFetch } from '@/lib/auth/client';
import { StepUpFields, sendJson, useActionError, useMfaState } from './step-up';

interface ExportItem {
  id: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  sizeBytes: number | null;
  expiresAt: string | null;
  errorCode: string | null;
  createdAt: string;
}

const POLL_MS = 10_000;

/**
 * The download is a plain navigation (no fetch), so after an idle spell the
 * 15-minute access cookie may have expired: one authFetch first refreshes the
 * session (a 401 there triggers the refresh), then the browser follows the link.
 */
export async function openExportDownload(id: string, go: (url: string) => void = (url) => window.location.assign(url),
  fetcher: typeof authFetch = authFetch): Promise<void> {
  await fetcher('/api/account/export', { cache: 'no-store' }).catch(() => undefined);
  go(`/api/account/export/${encodeURIComponent(id)}/download`);
}

type ExportsBody = { configured?: boolean; exports?: ExportItem[] };

/** The export list, or null when it could not be read. */
async function fetchExports(): Promise<ExportsBody | null> {
  const response = await authFetch('/api/account/export', { cache: 'no-store' }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as ExportsBody | null;
}

export function WorkspaceExportCard() {
  const t = useTranslations('Settings.privacy.export');
  const format = useFormatter();
  const errorText = useActionError();
  const mfa = useMfaState();
  const [items, setItems] = useState<ExportItem[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((body: ExportsBody | null) => {
    if (!body) return;
    setConfigured(body.configured !== false);
    setItems(Array.isArray(body.exports) ? body.exports : []);
  }, []);

  const load = useCallback(() => fetchExports().then(apply), [apply]);

  const pending = items?.some((item) => item.status === 'queued' || item.status === 'running') ?? false;

  useEffect(() => {
    let live = true;
    fetchExports().then((body) => {
      if (live) apply(body);
    });
    return () => {
      live = false;
    };
  }, [apply]);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  const request = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson('/api/account/export', 'POST', mfa?.enabled ? { mfaCode: code } : {});
    setBusy(false);
    if (!result.ok) {
      setError(errorText(result));
      return;
    }
    setCode('');
    await load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!configured ? (
          <p className="text-sm text-muted-foreground">{t('notConfigured')}</p>
        ) : (
          <>
            <StepUpFields idPrefix="export" mfa={mfa} identity={false} password="" onPassword={() => undefined} code={code} onCode={setCode} />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button onClick={request} disabled={busy || pending || (mfa?.enabled === true && !code)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {pending ? t('inProgress') : t('request')}
            </Button>
          </>
        )}
        {items && items.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-foreground">
                  {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                <span className="flex items-center gap-3 text-muted-foreground">
                  {t(`status.${item.status}`)}
                  {item.status === 'ready' && item.sizeBytes !== null ? (
                    <span>{format.number(item.sizeBytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB</span>
                  ) : null}
                  {item.status === 'ready' ? (
                    <a
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href={`/api/account/export/${item.id}/download`}
                      onClick={(event) => {
                        event.preventDefault();
                        void openExportDownload(item.id);
                      }}
                    >
                      <Download className="size-3.5" />
                      {t('download')}
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('note')}</p>
      </CardContent>
    </Card>
  );
}
