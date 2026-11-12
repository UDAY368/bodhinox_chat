'use client';

/**
 * Dry run (Phase 12): walks the saved draft or a published version on the
 * server for an optional sample contact, and shows what WOULD happen. Nothing
 * is sent, saved, queued or fetched (src/lib/flows/dry-run.ts), so it is safe
 * on a live flow. The live test with test numbers (flow settings) is the one
 * that sends real messages.
 *
 * Step-through: every choice is appended to `inputs` and the whole walk is
 * re-run, so the server stays stateless. API ports can be picked up front.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FlaskConical, Loader2, RotateCcw, SendHorizontal, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import type { DryRunInput, DryRunResult, WouldNote } from '@/lib/flows/dry-run';
import { cn } from '@/lib/utils';
import { Bubble, branchLabel } from './flow-preview';
import { useFlowEditor } from './flow-editor-state';

interface VersionOption { id: string; version: number }
interface ContactOption { id: string; name: string | null }

const selectClass = 'border-border bg-muted h-9 w-full rounded-md border px-2 text-sm';

export function DryRunPanel() {
  const t = useTranslations('Flows.dryRun');
  const tPreview = useTranslations('Flows.builder.preview');
  const { flow, state, dirty } = useFlowEditor();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('draft');
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactId, setContactId] = useState('');
  const [apiPorts, setApiPorts] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<DryRunInput[]>([]);
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');

  // The saved draft's API steps; the author may pick each one's result up front.
  const apiNodes = useMemo(() => state.nodes.filter((n) => n.node_type === 'api_request'), [state.nodes]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void authFetch(`/api/flows/${flow.id}/versions`).then(async (res) => {
      if (!res.ok || !live) return;
      const json = (await res.json()) as { versions?: VersionOption[] };
      if (live) setVersions(json.versions ?? []);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [open, flow.id]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const term = search.trim().replace(/[%_,()]/g, '');
    const timer = setTimeout(() => {
      // Names only: the dry run masks the number server-side when it is shown.
      let q = createClient().from('contacts').select('id,name').order('name').limit(20);
      if (term) q = q.ilike('name', `%${term}%`);
      void q.then(({ data }) => {
        if (live) setContacts((data ?? []) as ContactOption[]);
      });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [open, search]);

  const run = useCallback(async (nextInputs: DryRunInput[]) => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`/api/flows/${flow.id}/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          ...(contactId ? { contact_id: contactId } : {}),
          inputs: nextInputs,
          api_ports: apiPorts,
        }),
      });
      const json = (await res.json().catch(() => null)) as (DryRunResult & { error?: string }) | null;
      if (!res.ok || !json) {
        setError(typeof json?.error === 'string' ? json.error : t('failed'));
        return;
      }
      setInputs(nextInputs.slice(0, json.applied));
      setResult(json);
    } catch {
      setError(t('failed'));
    } finally {
      setBusy(false);
    }
  }, [flow.id, source, contactId, apiPorts, t]);

  const step = (input: DryRunInput) => {
    setAnswer('');
    void run([...inputs, input]);
  };

  const notesByMessage = useMemo(() => {
    const map = new Map<number, WouldNote[]>();
    for (const note of result?.notes ?? []) map.set(note.message_id, [...(map.get(note.message_id) ?? []), note]);
    return map;
  }, [result]);

  const waiting = result?.waiting ?? null;
  const errors = (result?.issues ?? []).filter((i) => i.severity === 'error');
  const warnings = (result?.issues ?? []).filter((i) => i.severity === 'warning');

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="dry-run-open" aria-label={t('open')} title={t('open')}>
        <FlaskConical className="h-3.5 w-3.5" />
        <span className="hidden @[96rem]:inline">{t('open')}</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md" data-testid="dry-run-panel">
          <SheetHeader className="border-border border-b px-4 py-3">
            <SheetTitle>{t('title')}</SheetTitle>
            <SheetDescription>{t('subtitle')}</SheetDescription>
          </SheetHeader>

          <div className="border-border flex flex-col gap-2 border-b px-4 py-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">{t('source')}</span>
              <select className={selectClass} value={source} onChange={(e) => setSource(e.target.value)} aria-label={t('source')}>
                <option value="draft">{t('sourceDraft')}</option>
                {versions.length > 0 && <option value="published">{t('sourcePublished')}</option>}
                {versions.map((v) => <option key={v.id} value={v.id}>{t('sourceVersion', { version: v.version })}</option>)}
              </select>
            </label>
            {source === 'draft' && dirty && <p className="text-amber-400">{t('unsavedNote')}</p>}
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">{t('contact')}</span>
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('contactSearch')} aria-label={t('contactSearch')} className="h-8 text-xs" />
              <select className={selectClass} value={contactId} onChange={(e) => setContactId(e.target.value)} aria-label={t('contact')}>
                <option value="">{t('noContact')}</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || t('unnamedContact')}</option>)}
              </select>
            </label>
            {apiNodes.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground font-medium">{t('apiPorts')}</span>
                {apiNodes.map((node) => {
                  const routes = Array.isArray(node.config.routes) ? (node.config.routes as Array<{ status?: string }>) : [];
                  return (
                    <label key={node.node_key} className="flex items-center gap-2">
                      <code className="bg-muted shrink-0 rounded px-1 text-[10px]">{node.node_key}</code>
                      <select className={cn(selectClass, 'h-8 text-xs')} value={apiPorts[node.node_key] ?? ''} aria-label={t('apiPortFor', { node: node.node_key })}
                        onChange={(e) => setApiPorts((p) => {
                          const next = { ...p };
                          if (e.target.value) next[node.node_key] = e.target.value;
                          else delete next[node.node_key];
                          return next;
                        })}>
                        <option value="">{t('apiPortAsk')}</option>
                        {routes.map((r, i) => <option key={i} value={`route:${i}`}>{r.status || `#${i + 1}`}</option>)}
                        <option value="fallback">{tPreview('branchFallback')}</option>
                      </select>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => void run([])} disabled={busy} data-testid="dry-run-start">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                {result ? t('restart') : t('start')}
              </Button>
              {inputs.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => void run(inputs.slice(0, -1))} disabled={busy}>
                  <Undo2 className="h-3.5 w-3.5" />
                  {t('back')}
                </Button>
              )}
            </div>
            {error && <p className="text-red-400" role="alert">{error}</p>}
          </div>

          <div className="bg-muted/60 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-4" aria-live="polite" data-testid="dry-run-trace">
            {!result && <p className="text-muted-foreground px-4 py-8 text-center text-xs">{t('empty')}</p>}
            {result?.contact && (
              <p className="text-muted-foreground text-center text-[11px]">
                {t('asContact', { name: result.contact.name || t('unnamedContact'), phone: result.contact.phone ?? '' })}
              </p>
            )}
            {result?.trace.map((m) => (
              <div key={m.id} className="flex flex-col gap-1">
                <Bubble message={m} active={false} listOpen={false} onToggleList={() => undefined} onPickButton={() => undefined} onPickRow={() => undefined} t={tPreview} />
                {(notesByMessage.get(m.id) ?? []).map((note, i) => (
                  <span key={i} data-testid="dry-run-would" className={cn('self-start rounded-full border border-dashed border-sky-600/40 bg-sky-500/10 px-2 py-0.5 text-[10.5px] text-sky-300', m.from === 'customer' && 'self-end')}>
                    {t(`would.${note.code}`, { ...note.params })}
                  </span>
                ))}
              </div>
            ))}
            {result?.ended && <p className="text-muted-foreground pt-2 text-center text-[11px] uppercase tracking-wider">{t('ended')}</p>}
            {result && result.rejected_input !== null && <p className="text-center text-[11px] text-amber-400">{t('inputRejected')}</p>}
          </div>

          {waiting && (
            <div className="border-border flex flex-col gap-2 border-t px-3 py-3">
              {waiting.options.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {waiting.options.map((o) => (
                    <Button key={o.id} variant="outline" size="sm" disabled={busy} onClick={() => step({ option_id: o.id })}>
                      {waiting.kind === 'branch' ? branchLabel(o.id, o.label, tPreview) : o.label}
                    </Button>
                  ))}
                </div>
              )}
              {waiting.simulate.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {waiting.simulate.map((o) => (
                    <Button key={o.id} variant="outline" size="sm" className="border-dashed" disabled={busy} onClick={() => step({ option_id: o.id })}>
                      {tPreview(o.id === 'share' ? 'simulate.shareMedia' : o.id === 'submit' ? 'simulate.submitForm' : o.id === 'timeout' ? 'simulate.timeout' : 'simulate.exhausted')}
                    </Button>
                  ))}
                </div>
              )}
              {waiting.kind === 'text' && (
                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) step({ option_id: 'text', text: answer }); }}>
                  <Input value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={1000} placeholder={tPreview('answerPlaceholder')} aria-label={tPreview('answerPlaceholder')} className="h-9 text-sm" />
                  <Button type="submit" size="icon-sm" disabled={busy || !answer.trim()} aria-label={tPreview('send')}><SendHorizontal className="h-4 w-4" /></Button>
                </form>
              )}
            </div>
          )}

          {result && (errors.length > 0 || warnings.length > 0) && (
            <div className="border-border max-h-40 overflow-y-auto border-t px-4 py-3 text-xs" data-testid="dry-run-issues">
              <p className="mb-1 font-semibold">{t('issuesTitle', { count: errors.length })}</p>
              <ul className="flex flex-col gap-1">
                {[...errors, ...warnings].map((issue, i) => (
                  <li key={i} className={issue.severity === 'error' ? 'text-red-400' : 'text-amber-400'}>
                    {issue.node_key ? <code className="mr-1 text-[10px]">{issue.node_key}</code> : null}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
