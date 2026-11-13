'use client';

// Knowledge source dialogs (AI page, Knowledge tab):
//   SourceDialog: add a website, a sitemap, an uploaded file, a question and
//     answer or typed text; or edit a Q&A pair or a text source.
//   SourceDetailDialog: view what a source holds (its pages, its text, or its
//     question and answer), with "Edit" for Q&A and text sources.

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { FileUp, Loader2 } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { segmentedItem, segmentedTrack } from '@/components/dashboard/segmented';
import { ACCEPTED_UPLOADS, kindKey, UPLOAD_MAX_BYTES, type KnowledgeSourceView } from './source-view';

export type AddMode = 'website' | 'sitemap' | 'file' | 'qa' | 'text';
const MODES: AddMode[] = ['website', 'sitemap', 'file', 'qa', 'text'];
const EXTENSIONS = ['pdf', 'docx', 'txt', 'md'];

export type SourceDialogState =
  | { kind: 'add'; preset?: string }
  | { kind: 'edit'; source: KnowledgeSourceView; question?: string; answer?: string; title?: string; content?: string };

export function SourceDialog({ state, onClose, onSaved }: {
  state: SourceDialogState;
  onClose: () => void;
  onSaved: (source: KnowledgeSourceView, message: string) => void;
}) {
  const t = useTranslations('AiStudio.knowledge');
  const tc = useTranslations('AiStudio.common');
  const tk = useTranslations('AiKnowledgeSources');
  const editing = state.kind === 'edit' ? state : null;
  const [mode, setMode] = useState<AddMode>(editing ? (editing.source.qa ? 'qa' : 'text') : state.kind === 'add' && state.preset ? 'qa' : 'website');
  const [url, setUrl] = useState('');
  const [name, setName] = useState(editing?.title ?? '');
  const [pageLimit, setPageLimit] = useState('50');
  const [file, setFile] = useState<File | null>(null);
  const [question, setQuestion] = useState(editing?.question ?? (state.kind === 'add' ? state.preset ?? '' : ''));
  const [answer, setAnswer] = useState(editing?.answer ?? '');
  const [content, setContent] = useState(editing?.content ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (key: string) => { setError(t(`add.errors.${key}`)); return false; };

  const submit = async () => {
    setError(null);
    let req: RequestInit & { path: string };
    if (mode === 'website' || mode === 'sitemap') {
      const raw = url.trim();
      if (!raw) return fail('url');
      try { new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return fail('url'); }
      const limit = Number(pageLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail('pageLimit');
      req = { path: '/api/ai/knowledge/sources', method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: mode, url: raw, ...(name.trim() ? { title: name.trim() } : {}), page_limit: limit }) };
    } else if (mode === 'file') {
      const ext = (file?.name.split('.').pop() ?? '').toLowerCase();
      if (!file) return fail('file');
      if (!EXTENSIONS.includes(ext)) return fail('fileType');
      if (file.size > UPLOAD_MAX_BYTES) return fail('fileSize');
      const form = new FormData();
      form.set('file', file);
      if (name.trim()) form.set('title', name.trim());
      req = { path: '/api/ai/knowledge/upload', method: 'POST', body: form };
    } else if (mode === 'qa') {
      if (!question.trim()) return fail('question');
      if (!answer.trim()) return fail('answer');
      const body = { question: question.trim(), answer: answer.trim() };
      req = editing
        ? { path: `/api/ai/knowledge/sources/${editing.source.id}`, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { path: '/api/ai/knowledge/sources', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'qa', ...body }) };
    } else {
      if (!name.trim()) return fail('title');
      if (!content.trim()) return fail('content');
      const body = { title: name.trim(), content: content.trim() };
      req = editing
        ? { path: `/api/ai/knowledge/sources/${editing.source.id}`, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { path: '/api/ai/knowledge/sources', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'text', ...body }) };
    }
    setBusy(true);
    try {
      const { path, ...init } = req;
      const res = await authFetch(path, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? t('toasts.failed')); return false; }
      onSaved(data.source, editing ? t('toasts.saved') : data.truncated ? tk('uploadedTruncated') : t('toasts.added'));
      onClose();
      return true;
    } catch {
      setError(t('toasts.failed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? (editing.source.qa ? t('add.editAnswerTitle') : t('add.editTextTitle')) : t('add.title');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!editing && (
            <div className={segmentedTrack} role="group" aria-label={t('add.modeLabel')}>
              {MODES.map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} className={segmentedItem(mode === m)} onClick={() => { setMode(m); setError(null); }}>
                  {t(`add.modes.${m}`)}
                </button>
              ))}
            </div>
          )}
          {(mode === 'website' || mode === 'sitemap') && (
            <>
              <div className="space-y-1">
                <Label htmlFor="src-url">{t(mode === 'website' ? 'add.url' : 'add.sitemapUrl')}</Label>
                <Input id="src-url" inputMode="url" autoComplete="off" maxLength={2048} value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder={mode === 'website' ? 'https://yourshop.com/help' : 'https://yourshop.com/sitemap.xml'} />
                <p className="text-xs text-muted-foreground">{tk(mode === 'website' ? 'hints.website' : 'hints.sitemap')}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <div className="space-y-1">
                  <Label htmlFor="src-name">{t('add.name')}</Label>
                  <Input id="src-name" maxLength={300} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('add.namePlaceholder')} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="src-limit">{tk('fields.pageLimit')}</Label>
                  <Input id="src-limit" type="number" min={1} max={500} value={pageLimit} onChange={(e) => setPageLimit(e.target.value)} />
                </div>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">{t('add.nameHint')}</p>
            </>
          )}
          {mode === 'file' && (
            <>
              <label className="relative flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-[1.5px] border-dashed border-border px-4 py-7 text-center text-muted-foreground transition-colors duration-150 focus-within:border-primary focus-within:bg-primary-soft hover:border-primary hover:bg-primary-soft">
                <input type="file" accept={ACCEPTED_UPLOADS} className="absolute inset-0 size-full cursor-pointer opacity-0" aria-label={t('add.file')}
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
                <FileUp className="size-5" aria-hidden />
                <strong className="font-semibold break-all text-foreground">{file ? file.name : t('add.file')}</strong>
                <small className="text-xs">{t('add.fileHint')}</small>
              </label>
              <div className="space-y-1">
                <Label htmlFor="src-file-name">{tk('fields.titleOptional')}</Label>
                <Input id="src-file-name" maxLength={300} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            </>
          )}
          {mode === 'qa' && (
            <>
              <div className="space-y-1">
                <Label htmlFor="src-q">{t('add.question')}</Label>
                <Input id="src-q" maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('add.questionPlaceholder')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="src-a">{t('add.answer')}</Label>
                <Textarea id="src-a" rows={5} maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('add.answerPlaceholder')} />
              </div>
            </>
          )}
          {mode === 'text' && (
            <>
              <div className="space-y-1">
                <Label htmlFor="src-title">{t('add.textTitle')}</Label>
                <Input id="src-title" maxLength={300} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="src-content">{t('add.textContent')}</Label>
                <Textarea id="src-content" rows={8} maxLength={100_000} value={content} onChange={(e) => setContent(e.target.value)} />
              </div>
            </>
          )}
          {error && <p className="text-xs font-medium text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{tc('cancel')}</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}{editing ? t('add.save') : t('add.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Detail {
  pages: { id: string; title: string; source_url: string | null }[];
  content: { kind: 'text'; text: string; truncated: boolean } | { kind: 'qa'; question: string; answer: string } | null;
}

export function SourceDetailDialog({ source, canEdit, onClose, onEdit }: {
  source: KnowledgeSourceView;
  canEdit: boolean;
  onClose: () => void;
  onEdit: (state: SourceDialogState) => void;
}) {
  const t = useTranslations('AiStudio.knowledge');
  const tc = useTranslations('AiStudio.common');
  const format = useFormatter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    authFetch(`/api/ai/knowledge/sources/${source.id}`, { cache: 'no-store' })
      .then(async (res) => { if (!res.ok) throw new Error(); setDetail(await res.json()); })
      .catch(() => setFailed(true));
  }, [source.id]);

  const editable = canEdit && source.kind === 'text' && detail?.content && !(detail.content.kind === 'text' && detail.content.truncated);
  const edit = () => {
    if (!detail?.content) return;
    onEdit(detail.content.kind === 'qa'
      ? { kind: 'edit', source, question: detail.content.question, answer: detail.content.answer }
      : { kind: 'edit', source, title: source.title, content: detail.content.text });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-xl">
        <DialogHeader><DialogTitle className="pr-8 break-words">{source.title}</DialogTitle></DialogHeader>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline" className="rounded-full">{t(`kind.${kindKey(source)}`)}</Badge>
          <Badge variant={source.status === 'failed' ? 'destructive' : source.status === 'ready' ? 'secondary' : 'outline'} className="rounded-full">{t(`status.${source.status}`)}</Badge>
          <span className="text-muted-foreground">
            {source.last_crawled_at ? t('detail.updated', { when: format.relativeTime(new Date(source.last_crawled_at)) }) : t('detail.never')}
          </span>
        </div>
        {source.url && <p className="text-[13px] break-all text-muted-foreground">{source.url}</p>}
        {failed && <p className="text-sm text-destructive">{t('toasts.failed')}</p>}
        {!detail && !failed && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={tc('loading')} />}
        {detail?.content?.kind === 'qa' && (
          <div className="space-y-1 rounded-xl bg-muted px-3.5 py-3">
            <small className="text-xs text-muted-foreground">{detail.content.question}</small>
            <p className="text-sm whitespace-pre-wrap break-words">{detail.content.answer}</p>
          </div>
        )}
        {detail?.content?.kind === 'text' && (
          <div className="space-y-1">
            <p className="max-h-[40vh] overflow-y-auto rounded-xl bg-muted px-3.5 py-3 text-sm whitespace-pre-wrap break-words">{detail.content.text}</p>
            {detail.content.truncated && <p className="text-xs text-muted-foreground">{t('detail.truncated')}</p>}
          </div>
        )}
        {detail && !detail.content && (
          detail.pages.length ? (
            <div className="space-y-1.5">
              <h3 className="text-sm font-medium">{t('detail.pages', { count: detail.pages.length })}</h3>
              <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto rounded-xl border border-border text-[13px]">
                {detail.pages.map((p) => (
                  <li key={p.id} className="min-w-0 px-3 py-2">
                    <span className="block truncate font-medium">{p.title}</span>
                    {p.source_url && <span className="block truncate text-xs text-muted-foreground">{p.source_url}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ) : <p className="text-sm text-muted-foreground">{t('detail.noPreview')}</p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('detail.close')}</Button>
          {editable && <Button type="button" onClick={edit}>{source.qa ? t('menu.editAnswer') : t('menu.editText')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
