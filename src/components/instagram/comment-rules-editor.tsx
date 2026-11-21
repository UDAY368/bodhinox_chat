'use client';

/**
 * The Instagram comment-reply rules of one connected account (Phase 11),
 * edited at Instagram › Comments (/instagram/comments). Moved out of
 * Settings › Instagram in Stage 1 with the same data and API:
 * /api/instagram/accounts/{id}/comment-rules (admins) and
 * /api/instagram/accounts/{id}/posts for the post picker. Each rule sends one
 * private reply to a matching comment. Stage 2: "Convert to flow" turns a rule
 * into an equivalent draft Instagram flow and switches the rule off
 * (POST .../comment-rules/{ruleId}/convert).
 * Apple's way (b7): the rules are a grouped list; adding or editing a rule
 * opens a sheet; Convert and Delete sit in each row's "more" menu and are
 * confirmed in the in-app dialog.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Loader2, MessageSquareReply, MoreHorizontal, Plus, Repeat, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageLoading } from '@/components/ui/page-loading';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { announceInstagramFlowsChanged } from '@/components/instagram/use-instagram-flows';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';
import type { CommentRuleView } from '@/lib/instagram/comment-rules';
import type { InstagramMedia } from '@/lib/instagram/graph';

const REPLY_MAX_BYTES = 1000;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** An Instagram API call from the browser: never throws on a JSON error body. */
export async function instagramCall(url: string, init?: RequestInit): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await authFetch(url, { cache: 'no-store', ...init });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

export const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const call = instagramCall;

interface RuleDraft { mediaId: string; keywords: string; replyText: string; active: boolean }
const EMPTY_DRAFT: RuleDraft = { mediaId: '', keywords: '', replyText: '', active: true };
const toDraft = (rule: CommentRuleView): RuleDraft =>
  ({ mediaId: rule.mediaId ?? '', keywords: rule.keywords.join(', '), replyText: rule.replyText, active: rule.active });
const toBody = (draft: RuleDraft) => ({
  media_id: draft.mediaId.trim() || null,
  keywords: draft.keywords.split(',').map((k) => k.trim()).filter(Boolean),
  reply_text: draft.replyText,
  active: draft.active,
});


export function CommentRulesEditor({ accountId }: { accountId: string }) {
  const t = useTranslations('Settings.instagram.commentRules');
  const tc = useTranslations('Settings.instagram');
  const tConvert = useTranslations('Instagram.comments');
  const tUi = useTranslations('UiKit');
  const confirm = useConfirm();
  const [converting, setConverting] = useState<string | null>(null);
  /** Rules converted on this page: rule id -> the new flow's id. */
  const [convertedTo, setConvertedTo] = useState<Record<string, string>>({});
  const [rules, setRules] = useState<CommentRuleView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [posts, setPosts] = useState<InstagramMedia[] | null>(null);
  const [postsState, setPostsState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [pickerOpen, setPickerOpen] = useState(false);
  const base = `/api/instagram/accounts/${accountId}/comment-rules`;

  const loadPosts = useCallback(async () => {
    setPostsState('loading');
    try {
      const { ok, json } = await call(`/api/instagram/accounts/${accountId}/posts`);
      if (!ok) {
        setPostsState('failed');
        return;
      }
      setPosts(Array.isArray(json.posts) ? json.posts as InstagramMedia[] : []);
      setPostsState('idle');
    } catch {
      setPostsState('failed');
    }
  }, [accountId]);

  // Rules aimed at one post show its caption, so fetch the posts once when such a rule exists.
  const needsPosts = !!rules?.some((rule) => rule.mediaId);
  useEffect(() => {
    if (needsPosts && posts === null && postsState === 'idle') void loadPosts();
  }, [needsPosts, posts, postsState, loadPosts]);

  const openPicker = () => {
    setPickerOpen(true);
    if (posts === null && postsState !== 'loading') void loadPosts();
  };
  const postById = (id: string) => posts?.find((post) => post.id === id) ?? null;
  const postTitle = (post: InstagramMedia) =>
    post.caption ?? (post.timestamp ? new Date(post.timestamp).toLocaleDateString() : t('mediaLabel', { id: post.id }));
  const closeForm = () => { setEditing(null); setDraft(EMPTY_DRAFT); setPickerOpen(false); };

  const fail = (json: Record<string, unknown>): void => {
    toast.error(typeof json.message === 'string' ? json.message : tc('errors.generic'));
  };
  const offline = { ok: false, json: {} as Record<string, unknown> };

  const load = useCallback(async (isLive: () => boolean = () => true) => {
    try {
      const { ok, json } = await call(base);
      if (!isLive()) return;
      if (!ok) throw new Error('load');
      setRules(json.rules as CommentRuleView[]);
      setFailed(false);
    } catch {
      if (isLive()) setFailed(true);
    }
  }, [base]);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

  const replyBytes = bytes(draft.replyText.trim());
  const mediaValid = !draft.mediaId.trim() || /^\d{1,32}$/.test(draft.mediaId.trim());
  const draftValid = replyBytes > 0 && replyBytes <= REPLY_MAX_BYTES && mediaValid;

  const save = async () => {
    if (!draftValid || saving) return;
    setSaving(true);
    try {
      const { ok, json } = editing === 'new'
        ? await call(base, jsonInit('POST', toBody(draft)))
        : await call(`${base}/${editing}`, jsonInit('PATCH', toBody(draft)));
      if (!ok) return fail(json);
      const rule = json.rule as CommentRuleView;
      setRules((current) => editing === 'new'
        ? [...(current ?? []), rule]
        : (current ?? []).map((r) => (r.id === rule.id ? rule : r)));
      closeForm();
      toast.success(t('saved'));
    } catch {
      toast.error(tc('errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule: CommentRuleView, active: boolean) => {
    const { ok, json } = await call(`${base}/${rule.id}`, jsonInit('PATCH', { active })).catch(() => offline);
    if (!ok) return fail(json);
    const next = json.rule as CommentRuleView;
    setRules((current) => (current ?? []).map((r) => (r.id === next.id ? next : r)));
  };

  const remove = async (rule: CommentRuleView) => {
    if (!(await confirm({ title: t('deleteConfirm'), confirmLabel: t('delete'), destructive: true }))) return;
    const { ok, json } = await call(`${base}/${rule.id}`, jsonInit('DELETE')).catch(() => offline);
    if (!ok) return fail(json);
    setRules((current) => (current ?? []).filter((r) => r.id !== rule.id));
    toast.success(t('deleted'));
  };

  const convert = async (rule: CommentRuleView) => {
    if (converting) return;
    if (!(await confirm({ title: tConvert('convertConfirm'), body: tConvert('convertHelp'), confirmLabel: tConvert('convertToFlow') }))) return;
    setConverting(rule.id);
    try {
      const { ok, json } = await call(`${base}/${rule.id}/convert`, jsonInit('POST'));
      if (!ok || typeof json.flow_id !== 'string') {
        toast.error(typeof json.message === 'string' ? json.message : tConvert('convertFailed'));
        return;
      }
      const flowId = json.flow_id;
      setRules((current) => (current ?? []).map((r) => (r.id === rule.id ? { ...r, active: false } : r)));
      setConvertedTo((current) => ({ ...current, [rule.id]: flowId }));
      announceInstagramFlowsChanged();
      toast.success(tConvert('converted'));
    } catch {
      toast.error(tConvert('convertFailed'));
    } finally {
      setConverting(null);
    }
  };

  const startNew = () => { setEditing('new'); setDraft(EMPTY_DRAFT); };
  const addButton = (
    <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={startNew} disabled={editing !== null}>
      <Plus className="size-4" />
      {t('add')}
    </Button>
  );

  if (failed) return <InlineError message={t('loadFailed')} onRetry={() => void load()} className="py-6" />;
  if (!rules) return <PageLoading rows={2} />;

  return (
    <div className="space-y-3">
      {rules.length === 0 ? (
        <EmptyState icon={MessageSquareReply} title={t('empty')} action={addButton} className="py-6" />
      ) : (
        <>
          <GroupedList>
            {rules.map((rule) => (
              <div key={rule.id} className="not-first:border-separator flex min-h-11 items-start gap-2 px-4 py-2.5 text-sm not-first:border-t">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-muted-foreground text-xs">
                    {rule.mediaId
                      ? (() => { const post = postById(rule.mediaId); return post ? postTitle(post) : t('mediaLabel', { id: rule.mediaId }); })()
                      : t('anyPost')}
                    {' · '}
                    {rule.keywords.length ? rule.keywords.join(', ') : t('keywordsAny')}
                  </p>
                  <p className="text-foreground break-words whitespace-pre-wrap">{rule.replyText}</p>
                  {convertedTo[rule.id] && (
                    <Link href={channelPath('instagram', 'flows', convertedTo[rule.id])}
                      className="text-primary inline-flex min-h-11 items-center text-xs font-medium underline-offset-2 hover:underline sm:min-h-0">
                      {tConvert('openFlow')}
                    </Link>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="flex size-11 items-center justify-center">
                    <Switch checked={rule.active} onCheckedChange={(v: boolean) => void toggle(rule, v)} aria-label={t('active')} />
                  </span>
                  <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" disabled={editing !== null}
                    onClick={() => { setEditing(rule.id); setDraft(toDraft(rule)); }}>
                    {t('edit')}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon" className="size-11" aria-label={tUi('more')} />}>
                      {converting === rule.id
                        ? <Loader2 className="size-4 animate-spin" aria-hidden />
                        : <MoreHorizontal className="size-4" aria-hidden />}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-auto min-w-48">
                      {!convertedTo[rule.id] && (
                        <DropdownMenuItem disabled={editing !== null || converting !== null} onClick={() => void convert(rule)}>
                          <Repeat className="size-4" />
                          {tConvert('convertToFlow')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem variant="destructive" onClick={() => void remove(rule)}>
                        <Trash2 className="size-4" />
                        {t('delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </GroupedList>
          {addButton}
        </>
      )}

      <Sheet open={editing !== null} onOpenChange={(open) => { if (!open && !saving) closeForm(); }}>
        <SheetContent side="right" size="md" className="overflow-y-auto">
          <form className="flex min-h-full flex-col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <SheetHeader>
              <SheetTitle>{editing === 'new' ? t('add') : t('edit')}</SheetTitle>
            </SheetHeader>
            <div className="flex-1 space-y-5 px-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('post')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {(() => {
                    const id = draft.mediaId.trim();
                    const post = id ? postById(id) : null;
                    return (
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
                        {!id ? t('anyPost') : post ? postTitle(post) : t('mediaLabel', { id })}
                      </span>
                    );
                  })()}
                  <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={openPicker}>{t('choosePost')}</Button>
                  {draft.mediaId.trim() && (
                    <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setDraft({ ...draft, mediaId: '' })}>
                      {t('useAnyPost')}
                    </Button>
                  )}
                </div>
                {pickerOpen && (
                  <div className="space-y-2">
                    {postsState === 'loading' && <PageLoading rows={2} />}
                    {postsState === 'failed' && <InlineError message={t('postsFailed')} onRetry={() => void loadPosts()} className="py-4" />}
                    {postsState === 'idle' && posts?.length === 0 && <p className="text-muted-foreground text-sm">{t('noPosts')}</p>}
                    {postsState === 'idle' && !!posts?.length && (
                      <ul className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                        {posts.map((post) => {
                          const selected = draft.mediaId.trim() === post.id;
                          return (
                            <li key={post.id}>
                              <button type="button" aria-pressed={selected}
                                onClick={() => { setDraft({ ...draft, mediaId: post.id }); setPickerOpen(false); }}
                                className={`hover:bg-muted flex w-full flex-col gap-1 rounded-md border p-1.5 text-left text-xs ${selected ? 'border-primary ring-primary ring-1' : ''}`}>
                                {post.previewUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={post.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer"
                                    className="bg-muted aspect-square w-full rounded object-cover" />
                                ) : (
                                  <span className="bg-muted text-muted-foreground flex aspect-square w-full items-center justify-center rounded">
                                    {post.mediaType === 'VIDEO' ? t('video') : t('noPreview')}
                                  </span>
                                )}
                                <span className="line-clamp-2 break-words">{post.caption ?? t('noCaption')}</span>
                                {post.timestamp && (
                                  <span className="text-muted-foreground">{new Date(post.timestamp).toLocaleDateString()}</span>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-muted-foreground text-xs">{t('postsHelp')}</p>
                      <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setPickerOpen(false)}>{t('cancel')}</Button>
                    </div>
                  </div>
                )}
                <details className="text-xs">
                  <summary className="text-muted-foreground flex min-h-11 cursor-pointer items-center sm:min-h-0">{t('enterPostId')}</summary>
                  <div className="mt-2 space-y-1">
                    <Label htmlFor={`ig-media-${accountId}`}>{t('postId')}</Label>
                    <Input id={`ig-media-${accountId}`} inputMode="numeric" value={draft.mediaId} maxLength={32}
                      placeholder={t('anyPost')} onChange={(e) => setDraft({ ...draft, mediaId: e.target.value })} />
                  </div>
                </details>
                <p className="text-muted-foreground text-xs">{mediaValid ? t('postIdHelp') : t('postIdInvalid')}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`ig-keywords-${accountId}`}>{t('keywords')}</Label>
                <Input id={`ig-keywords-${accountId}`} value={draft.keywords} maxLength={1200}
                  onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />
                <p className="text-muted-foreground text-xs">{t('keywordsHelp')}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`ig-reply-${accountId}`}>{t('replyText')}</Label>
                <Textarea id={`ig-reply-${accountId}`} value={draft.replyText} rows={3}
                  onChange={(e) => setDraft({ ...draft, replyText: e.target.value })} />
                <p className={replyBytes > REPLY_MAX_BYTES ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                  {t('replyBytes', { count: replyBytes, max: REPLY_MAX_BYTES })}
                </p>
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3">
                <Label htmlFor={`ig-active-${accountId}`} className="text-sm font-normal">{t('active')}</Label>
                <Switch id={`ig-active-${accountId}`} checked={draft.active} onCheckedChange={(v: boolean) => setDraft({ ...draft, active: v })} />
              </div>
            </div>
            <SheetFooter className="flex-row justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeForm} disabled={saving}>{t('cancel')}</Button>
              <Button type="submit" disabled={!draftValid || saving}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {t('save')}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
