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
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { ok, json } = await call(base);
        if (!live) return;
        if (!ok) throw new Error('load');
        setRules(json.rules as CommentRuleView[]);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [base]);

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
    if (!window.confirm(t('deleteConfirm'))) return;
    const { ok, json } = await call(`${base}/${rule.id}`, jsonInit('DELETE')).catch(() => offline);
    if (!ok) return fail(json);
    setRules((current) => (current ?? []).filter((r) => r.id !== rule.id));
    toast.success(t('deleted'));
  };

  const convert = async (rule: CommentRuleView) => {
    if (converting || !window.confirm(tConvert('convertConfirm'))) return;
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
      toast.success(tConvert('converted'));
    } catch {
      toast.error(tConvert('convertFailed'));
    } finally {
      setConverting(null);
    }
  };

  return (
    <div className="space-y-3 border-t pt-3">
      <div>
        <p className="text-foreground text-sm font-medium">{t('title')}</p>
        <p className="text-muted-foreground text-xs">{t('help')}</p>
      </div>
      {failed && <p className="text-destructive text-sm">{t('loadFailed')}</p>}
      {!rules && !failed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tc('loading')} />}
      {rules && rules.length === 0 && editing !== 'new' && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
      {rules?.map((rule) => editing === rule.id ? null : (
        <div key={rule.id} className="bg-muted/40 flex flex-wrap items-start gap-3 rounded-md p-3 text-sm">
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
                className="text-primary text-xs font-medium underline-offset-2 hover:underline">
                {tConvert('openFlow')}
              </Link>
            )}
          </div>
          <Switch checked={rule.active} onCheckedChange={(v: boolean) => void toggle(rule, v)} aria-label={t('active')} />
          <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(rule.id); setDraft(toDraft(rule)); }}
            disabled={editing !== null}>
            {t('edit')}
          </Button>
          {!convertedTo[rule.id] && (
            <Button type="button" variant="outline" size="sm" onClick={() => void convert(rule)}
              disabled={editing !== null || converting !== null} title={tConvert('convertHelp')}>
              {converting === rule.id && <Loader2 className="size-3.5 animate-spin" />}
              {tConvert('convertToFlow')}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => void remove(rule)} aria-label={t('delete')}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      {editing !== null && (
        <div className="space-y-3 rounded-md border p-3">
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
              <Button type="button" variant="outline" size="sm" onClick={openPicker}>{t('choosePost')}</Button>
              {draft.mediaId.trim() && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, mediaId: '' })}>
                  {t('useAnyPost')}
                </Button>
              )}
            </div>
            {pickerOpen && (
              <div className="space-y-2 rounded-md border p-2">
                {postsState === 'loading' && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tc('loading')} />}
                {postsState === 'failed' && (
                  <div className="flex items-center gap-2 text-sm">
                    <p className="text-destructive">{t('postsFailed')}</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => void loadPosts()}>{tc('retry')}</Button>
                  </div>
                )}
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
                <div className="flex justify-between gap-2">
                  <p className="text-muted-foreground text-xs">{t('postsHelp')}</p>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>{t('cancel')}</Button>
                </div>
              </div>
            )}
            <details className="text-xs">
              <summary className="text-muted-foreground cursor-pointer">{t('enterPostId')}</summary>
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
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.active} onCheckedChange={(v: boolean) => setDraft({ ...draft, active: v })} />
            {t('active')}
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => void save()} disabled={!draftValid || saving}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t('save')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={closeForm} disabled={saving}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {editing === null && rules && (
        <Button type="button" variant="outline" size="sm" onClick={() => { setEditing('new'); setDraft(EMPTY_DRAFT); }}>
          {t('add')}
        </Button>
      )}
    </div>
  );
}
