'use client';

/**
 * Settings > Instagram (Phase 11, design section 4). Owner: T2.
 *
 * While Instagram is off on this deployment the card only says so, with the
 * reason, and nothing here contacts Instagram. When it is on, each connected
 * account shows its status with the matching action (connected, access
 * expired -> Reconnect, permission missing -> names the feature and scopes,
 * disconnected -> Connect), when a message last arrived, when access expires,
 * whether comment replies are available, how many unsupported events arrived,
 * and (admins, comments granted) the comment-reply rules. Members see
 * everything read-only. No token ever reaches the browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AtSign, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { hasMinRole } from '@/lib/auth/roles';
import type { CommentRuleView } from '@/lib/instagram/comment-rules';
import type { InstagramAccountView } from '@/lib/instagram/connection';
import type { InstagramMedia } from '@/lib/instagram/graph';

type Status =
  | { enabled: false; reason: 'flag_off' | 'not_configured'; accounts: [] }
  | { enabled: true; appId: string; humanAgentEnabled: boolean; accounts: InstagramAccountView[] };

/** ?code= values the callback can send (kept in step with CALLBACK_ERROR_CODES). */
const CALLBACK_CODES = new Set([
  'instagram_not_enabled', 'signed_out', 'forbidden', 'denied', 'state_mismatch', 'invalid_request', 'account_in_use',
  'limit_reached', 'feature_unavailable', 'instagram_token_invalid', 'meta_error', 'save_failed',
]);
const AUTHORIZE_PREFIX = 'https://www.instagram.com/oauth/authorize';
const REPLY_MAX_BYTES = 1000;
const bytes = (text: string) => new TextEncoder().encode(text).length;

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await authFetch(url, { cache: 'no-store', ...init });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export function InstagramCard() {
  const t = useTranslations('Settings.instagram');
  const { accountRole } = useAuth();
  const canEdit = !!accountRole && hasMinRole(accountRole, 'admin');
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [withComments, setWithComments] = useState(true);

  const failure = useCallback((json: Record<string, unknown>): void => {
    toast.error(typeof json.message === 'string' ? json.message : t('errors.generic'));
  }, [t]);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const { ok, json } = await call('/api/instagram/status');
      if (!ok) throw new Error('load');
      setStatus(json as unknown as Status);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const outcome = searchParams.get('instagram');
  const outcomeCode = searchParams.get('code');
  useEffect(() => {
    if (outcome === 'connected') toast.success(t('connected'));
    else if (outcome === 'error')
      toast.error(outcomeCode && CALLBACK_CODES.has(outcomeCode) ? t(`callbackErrors.${outcomeCode}`) : t('connectFailed'));
  }, [outcome, outcomeCode, t]);

  const connect = async () => {
    setBusy('connect');
    try {
      const { ok, json } = await call('/api/instagram/connect', jsonInit('POST', { comments: withComments }));
      if (!ok) {
        failure(json);
        setBusy(null);
        return;
      }
      if (typeof json.url !== 'string' || !json.url.startsWith(AUTHORIZE_PREFIX)) throw new Error('url');
      window.location.assign(json.url);
    } catch {
      toast.error(t('connectFailed'));
      setBusy(null);
    }
  };

  const replaceAccount = (account: InstagramAccountView) =>
    setStatus((current) => current?.enabled
      ? { ...current, accounts: current.accounts.map((a) => (a.id === account.id ? account : a)) }
      : current);

  const disconnect = async (account: InstagramAccountView) => {
    if (!window.confirm(t('disconnectConfirm', { username: account.username ?? account.igUserId }))) return;
    setBusy(`disconnect:${account.id}`);
    try {
      const { ok, json } = await call(`/api/instagram/accounts/${account.id}`, jsonInit('DELETE'));
      if (!ok) return failure(json);
      replaceAccount(json.account as InstagramAccountView);
      toast.success(t('disconnected'));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  };

  const checkNow = async (account: InstagramAccountView) => {
    setBusy(`health:${account.id}`);
    try {
      const { ok, json } = await call(`/api/instagram/accounts/${account.id}/health`, jsonInit('POST'));
      if (!ok) return failure(json);
      replaceAccount(json.account as InstagramAccountView);
      toast.success(t('healthChecked'));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  };

  const accounts = status?.enabled ? status.accounts : [];
  const live = accounts.filter((a) => a.status !== 'disconnected');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AtSign className="size-4" aria-hidden="true" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadFailed && (
          <div className="flex items-center gap-3 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!status && !loadFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}

        {status && !status.enabled && (
          <div className="space-y-1 text-sm">
            <p className="text-foreground font-medium">{t('notEnabled')}</p>
            <p className="text-muted-foreground">
              {status.reason === 'not_configured' ? t('reasonNotConfigured') : t('reasonFlagOff')}
            </p>
          </div>
        )}

        {status?.enabled && (
          <>
            {accounts.length === 0 && <p className="text-muted-foreground text-sm">{t('noAccounts')}</p>}
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} canEdit={canEdit} busy={busy}
                onReconnect={connect} onDisconnect={disconnect} onCheck={checkNow} />
            ))}
            {!canEdit && <p className="text-muted-foreground text-xs">{t('memberReadOnly')}</p>}
            {canEdit && (
              <div className="space-y-3 border-t pt-4">
                <label className="flex items-start gap-3 text-sm">
                  <Switch checked={withComments} onCheckedChange={(v: boolean) => setWithComments(v)} disabled={!!busy} />
                  <span>
                    <span className="text-foreground block font-medium">{t('includeComments')}</span>
                    <span className="text-muted-foreground block text-xs">{t('includeCommentsHelp')}</span>
                  </span>
                </label>
                <Button type="button" onClick={() => void connect()} disabled={!!busy}>
                  {busy === 'connect' && <Loader2 className="size-3.5 animate-spin" />}
                  {busy === 'connect' ? t('connecting') : live.length ? t('connectAnother') : t('connect')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AccountRow({ account, canEdit, busy, onReconnect, onDisconnect, onCheck }: {
  account: InstagramAccountView;
  canEdit: boolean;
  busy: string | null;
  onReconnect: () => Promise<void>;
  onDisconnect: (account: InstagramAccountView) => Promise<void>;
  onCheck: (account: InstagramAccountView) => Promise<void>;
}) {
  const t = useTranslations('Settings.instagram');
  const handle = account.username ? `@${account.username}` : account.name ?? account.igUserId;
  const disconnected = account.status === 'disconnected';
  const commentsReady = !disconnected && account.missingScopes.comments.length === 0;
  const featureGap = account.missingScopes.dm.length
    ? { feature: t('features.dm'), scopes: account.missingScopes.dm.join(', ') }
    : null;
  const date = (iso: string) => new Date(iso).toLocaleString();

  const badge = account.status === 'active' ? <Badge variant="secondary">{t('statusActive')}</Badge>
    : account.status === 'disconnected' ? <Badge variant="outline">{t('statusDisconnected')}</Badge>
    : <Badge variant="destructive">{account.status === 'token_invalid' ? t('badgeReconnect') : t('badgePermission')}</Badge>;

  return (
    <div className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-foreground font-medium">{handle}</span>
        {badge}
        {canEdit && (
          <div className="ml-auto flex flex-wrap gap-2">
            {!disconnected && (
              <Button type="button" variant="outline" size="sm" onClick={() => void onCheck(account)} disabled={!!busy}>
                {busy === `health:${account.id}` && <Loader2 className="size-3.5 animate-spin" />}
                {t('checkNow')}
              </Button>
            )}
            {(account.status === 'token_invalid' || account.status === 'permission_missing' || disconnected) && (
              <Button type="button" size="sm" onClick={() => void onReconnect()} disabled={!!busy}>
                {disconnected ? t('connect') : t('reconnect')}
              </Button>
            )}
            {!disconnected && (
              <Button type="button" variant="outline" size="sm" onClick={() => void onDisconnect(account)} disabled={!!busy}>
                {t('disconnect')}
              </Button>
            )}
          </div>
        )}
      </div>

      <ul className="text-muted-foreground space-y-1 text-sm">
        {account.status === 'token_invalid' && <li className="text-destructive">{t('statusTokenInvalid')}</li>}
        {account.status === 'permission_missing' && featureGap && (
          <li className="text-destructive">{t('statusPermissionMissing', featureGap)}</li>
        )}
        {disconnected && <li>{t('disconnectedHelp')}</li>}
        {!disconnected && (
          <li>{account.lastWebhookAt ? t('lastWebhook', { date: date(account.lastWebhookAt) }) : t('neverReceived')}</li>
        )}
        {!disconnected && account.accessExpiresAt && <li>{t('tokenExpires', { date: date(account.accessExpiresAt) })}</li>}
        {!disconnected && <li>{commentsReady ? t('commentsAvailable') : t('commentsNotEnabled')}</li>}
        {account.unsupportedEventCount > 0 && <li>{t('unsupportedEvents', { count: account.unsupportedEventCount })}</li>}
      </ul>

      {canEdit && commentsReady && <CommentRules accountId={account.id} />}
    </div>
  );
}

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

function CommentRules({ accountId }: { accountId: string }) {
  const t = useTranslations('Settings.instagram.commentRules');
  const tc = useTranslations('Settings.instagram');
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
          </div>
          <Switch checked={rule.active} onCheckedChange={(v: boolean) => void toggle(rule, v)} aria-label={t('active')} />
          <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(rule.id); setDraft(toDraft(rule)); }}
            disabled={editing !== null}>
            {t('edit')}
          </Button>
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
