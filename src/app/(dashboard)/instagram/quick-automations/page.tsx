'use client';

// Instagram › Quick automations (Stage 2, plan item 10): three guided setups
// that turn a few answers into a draft Instagram flow, and the gallery of
// Instagram starter templates. Both create an ordinary draft the author then
// reviews and publishes in the flow builder; nothing runs until it is
// published. The Instagram section layout already explains a channel that is
// off or not available. Creating flows needs an agent or above (the server
// enforces it too).
//
// Stage 5 (5F): a guided setup is a two-pane page in the dialog: the form on
// the left and a live phone preview on the right with Post, Comments and DM
// tabs (the tab follows the field being edited); message fields count down the
// 1,000-byte limit. `?wizard=comment_links|grow_followers|story_leads` opens a
// setup directly (the Instagram home page's "Start here" cards).
//
// The comment setups choose which posts (a specific post or reel from the
// picker, any, or the next one), which words (specific words or any word),
// and whether to reply under the comment (up to 3 rotating replies). The
// link setup can also ask for an email and a follow before the link, and
// carry up to 3 links. The preview is an Android phone.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowLeft, Clapperboard, Image as ImageIcon, MessageCircle, Phone, Plus, Sparkles, UserPlus, Video, X,
} from 'lucide-react';

import { IgPostPicker, useInstagramAccounts } from '@/components/flows/triggers/ig-post-picker';
import { AndroidPhone } from '@/components/instagram/android-phone';
import { TemplateGallery, type TemplateSummary } from '@/components/flows/template-gallery';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';
import type { InstagramMedia } from '@/lib/instagram/graph';
import {
  formFieldFor, keywordList, wizardBody, wizardFormProblem, type CommentChoices, type FieldProblem, type LinkRow, type WizardId as Wizard,
} from '@/lib/instagram/wizard-form';
import { cn } from '@/lib/utils';

const WIZARDS: Array<{ id: Wizard; key: 'commentLinks' | 'growFollowers' | 'storyLeads'; icon: typeof MessageCircle }> = [
  { id: 'comment_links', key: 'commentLinks', icon: MessageCircle },
  { id: 'grow_followers', key: 'growFollowers', icon: UserPlus },
  { id: 'story_leads', key: 'storyLeads', icon: Sparkles },
];

type Values = Record<string, string>;
const MAX_REPLIES = 3;
const MAX_MORE_LINKS = 2;

/** Instagram's text limit (graph-limits.ts): 1,000 bytes. */
const MESSAGE_BYTES = 1000;
const byteLength = (value: string) => new TextEncoder().encode(value).length;

type PreviewTab = 'post' | 'comments' | 'dm';
/** The preview tab that shows a field. */
const FIELD_TAB: Record<string, PreviewTab> = { media_ids: 'post', keywords: 'comments', public_reply: 'comments' };
const isWizard = (value: string | null): value is Wizard => WIZARDS.some((w) => w.id === value);

const freshChoices = (reply: string): CommentChoices => ({
  postScope: 'any', mediaIds: [], words: 'any', replyOn: true, replies: [reply], askEmail: false, askFollow: false, moreLinks: [],
});

export default function InstagramQuickAutomationsPage() {
  const t = useTranslations('Instagram.quickAutomations');
  const router = useRouter();
  const { accountId } = useAuth();
  const canCreate = useCan('send-messages');
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const [values, setValues] = useState<Values>({});
  const [choices, setChoices] = useState<CommentChoices>(() => freshChoices(''));
  const [reactions, setReactions] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; problem: FieldProblem } | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('dm');
  const [posts, setPosts] = useState<InstagramMedia[]>([]);
  const deepLinked = useRef(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch('/api/flows/templates?channel=instagram');
        const json = res.ok ? ((await res.json()) as { templates?: TemplateSummary[] }) : {};
        // The Instagram-only starters; the general starters stay in the flows gallery.
        const own = (json.templates ?? []).filter((tpl) => tpl.channels?.length === 1 && tpl.channels[0] === 'instagram');
        if (!cancelled) setTemplates(own);
      } catch {
        if (!cancelled) setTemplates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // ?wizard= opens a setup once (the home page's Start here cards), for anyone who may create flows.
  useEffect(() => {
    if (deepLinked.current || !canCreate) return;
    const requested = new URLSearchParams(window.location.search).get('wizard');
    if (!isWizard(requested)) return;
    deepLinked.current = true;
    openWizard(requested);
    // openWizard only reads the translations, which are stable for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate]);

  function openWizard(id: Wizard) {
    const key = WIZARDS.find((w) => w.id === id)!.key;
    const d = (name: string) => t(`defaults.${key}.${name}`);
    const defaults: Record<Wizard, Values> = {
      comment_links: {
        keywords: '', message: d('message'), opt_in_label: d('optInLabel'),
        email_prompt: d('emailPrompt'), email_error: d('emailError'), follow_prompt: d('followPrompt'), followed_label: d('followedButton'),
        card_title: d('cardTitle'), link_label: d('linkLabel'), link_url: '',
      },
      grow_followers: {
        keywords: '', message: d('message'), opt_in_label: d('optInLabel'),
        follow_prompt: d('followPrompt'), followed_label: d('followedButton'), reward_title: d('rewardTitle'),
        reward_label: d('rewardButton'), reward_url: '',
      },
      story_leads: { keywords: '', email_prompt: d('emailPrompt'), email_error: d('emailError'), thanks: d('thanks') },
    };
    setValues(defaults[id]);
    setChoices(freshChoices(id === 'story_leads' ? '' : d('publicReply')));
    setReactions(false);
    setFieldError(null);
    setPreviewTab(id === 'story_leads' ? 'dm' : 'post');
    setWizard(id);
  }

  async function finishWizard() {
    if (!wizard) return;
    const local = wizardFormProblem(wizard, values, choices);
    if (local) {
      setFieldError(local);
      if (local.field === 'media_ids') setPreviewTab('post');
      return;
    }
    setCreating(true);
    setFieldError(null);
    try {
      const res = await authFetch('/api/instagram/wizards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wizardBody(wizard, values, choices, reactions)),
      });
      const json = (await res.json().catch(() => ({}))) as {
        flow?: { id: string }; error?: string; message?: string; field?: string; problem?: FieldProblem;
      };
      if (res.status === 400 && json.field) {
        // Shown under its box; a field the form has no box for (the body, the post scope) becomes a toast.
        const box = formFieldFor(wizard, json.field);
        if (box) setFieldError({ field: box, problem: json.problem ?? 'invalid' });
        else toast.error(json.error ?? t('errors.invalid'));
        return;
      }
      if (!res.ok || !json.flow) throw new Error(json.message ?? json.error);
      toast.success(t('created'));
      setWizard(null);
      router.push(channelPath('instagram', 'flows', json.flow.id));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('createFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function createFromTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await authFetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_slug: slug, channel_scope: 'instagram' }),
      });
      const json = (await res.json().catch(() => ({}))) as { flow?: { id: string }; error?: string };
      if (!res.ok || !json.flow) throw new Error(json.error);
      toast.success(t('created'));
      router.push(channelPath('instagram', 'flows', json.flow.id));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('createFailed'));
    } finally {
      setCreating(false);
    }
  }

  const active = WIZARDS.find((w) => w.id === wizard);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
        {!canCreate && <p className="text-muted-foreground mt-2 text-sm" role="note">{t('noPermission')}</p>}
      </div>

      <section className="space-y-3" aria-labelledby="ig-wizards-heading">
        <h2 id="ig-wizards-heading" className="text-foreground text-sm font-semibold">{t('wizards')}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {WIZARDS.map(({ id, key, icon: Icon }) => (
            <div key={id} className="border-border bg-background flex flex-col gap-2.5 rounded-lg border p-4">
              <Icon className="text-primary h-5 w-5" aria-hidden="true" />
              <span className="text-popover-foreground text-sm font-semibold">{t(`${key}.title`)}</span>
              <span className="text-muted-foreground text-xs leading-relaxed">{t(`${key}.description`)}</span>
              <div className="border-border mt-auto flex justify-end border-t pt-2">
                <Button size="sm" disabled={!canCreate || creating} onClick={() => openWizard(id)}
                  aria-label={`${t('start')}: ${t(`${key}.title`)}`}>
                  {t('start')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="ig-templates-heading">
        <div>
          <h2 id="ig-templates-heading" className="text-foreground text-sm font-semibold">{t('templates')}</h2>
          <p className="text-muted-foreground mt-1 text-xs">{t('templatesHelp')}</p>
        </div>
        {templates === null ? null : templates.length === 0 ? (
          <p className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm" role="status">
            {t('empty')}
          </p>
        ) : (
          <TemplateGallery templates={templates} creating={creating || !canCreate} onUse={(slug) => void createFromTemplate(slug)} />
        )}
      </section>

      <Dialog open={wizard !== null} onOpenChange={(open) => { if (!open && !creating) setWizard(null); }}>
        <DialogContent className="bg-popover text-popover-foreground max-h-[92vh] overflow-y-auto sm:max-w-5xl">
          {active && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void finishWizard();
              }}
            >
              <DialogHeader>
                <DialogTitle>{t(`${active.key}.title`)}</DialogTitle>
                <DialogDescription className="text-muted-foreground">{t(`${active.key}.description`)}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_19rem]">
                <div className="min-w-0" onFocusCapture={(event) => {
                  const name = (event.target as HTMLElement).closest<HTMLElement>('[data-field]')?.dataset.field;
                  if (name) setPreviewTab(FIELD_TAB[name] ?? 'dm');
                }}>
                  <WizardFields
                    wizard={active.id}
                    values={values}
                    onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
                    choices={choices}
                    onChoices={(patch) => setChoices((current) => ({ ...current, ...patch }))}
                    onPosts={setPosts}
                    reactions={reactions}
                    onReactions={setReactions}
                    error={fieldError}
                  />
                </div>
                <div className="md:sticky md:top-0 md:self-start">
                  <WizardPreview wizard={active.id} values={values} choices={choices} posts={posts} tab={previewTab} onTab={setPreviewTab} />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={creating} onClick={() => setWizard(null)}>{t('cancel')}</Button>
                <Button type="submit" disabled={creating}>{creating ? t('creating') : t('finish')}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A titled block of the form, like the sections of the setup. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** A choice card: a radio with its label, and what it reveals when chosen. */
function ChoiceCard({ name, value, checked, label, help, onChoose, children }: {
  name: string; value: string; checked: boolean; label: string; help?: string; onChoose: () => void; children?: ReactNode;
}) {
  const id = `${useId()}-${value}`;
  return (
    <div className={cn('rounded-lg border p-3 transition-colors', checked ? 'border-primary bg-primary/5' : 'border-border bg-background')}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input id={id} type="radio" name={name} value={value} checked={checked} onChange={onChoose}
          className="accent-primary mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          <span className="text-foreground font-medium">{label}</span>
          {help && <span className="text-muted-foreground mt-0.5 block text-xs">{help}</span>}
        </span>
      </label>
      {checked && children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** An on/off row; what it switches on opens below it. */
function SwitchRow({ label, help, checked, onChange, children }: {
  label: string; help?: string; checked: boolean; onChange: (value: boolean) => void; children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn('rounded-lg border p-3', checked ? 'border-primary/40' : 'border-border')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor={id} className="text-foreground text-sm font-medium">{label}</Label>
          {help && <p className="text-muted-foreground mt-0.5 text-xs">{help}</p>}
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
      {checked && children && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}

function WizardFields({
  wizard, values, onChange, choices, onChoices, onPosts, reactions, onReactions, error,
}: {
  wizard: Wizard;
  values: Values;
  onChange: (name: string, value: string) => void;
  choices: CommentChoices;
  onChoices: (patch: Partial<CommentChoices>) => void;
  onPosts: (posts: InstagramMedia[]) => void;
  reactions: boolean;
  onReactions: (value: boolean) => void;
  error: { field: string; problem: FieldProblem } | null;
}) {
  const t = useTranslations('Instagram.quickAutomations');
  const accounts = useInstagramAccounts();
  const [postsAccount, setPostsAccount] = useState<string | null>(null);
  const pickerAccount = postsAccount ?? accounts[0]?.id ?? null;
  const errorFor = (name: string) => (error?.field === name ? t(`errors.${error.problem}`) : undefined);
  const field = (name: string, label: string, options: { help?: string; long?: boolean; type?: string; required?: boolean } = {}) => (
    <Field key={name} name={name} label={label} help={options.help} error={errorFor(name)}>
      {(id, describedBy) => {
        const shared = {
          id,
          'data-field': name,
          value: values[name] ?? '',
          required: options.required,
          'aria-invalid': error?.field === name || undefined,
          'aria-describedby': describedBy,
        };
        return options.long ? (
          <>
            <Textarea {...shared} rows={3} onChange={(e) => onChange(name, e.target.value)} />
            <CharactersLeft value={values[name] ?? ''} />
          </>
        ) : (
          <Input {...shared} type={options.type ?? 'text'} onChange={(e) => onChange(name, e.target.value)} />
        );
      }}
    </Field>
  );

  if (wizard === 'story_leads') {
    return (
      <div className="space-y-3">
        {field('keywords', t('storyKeyword'), { help: t('storyKeywordHelp') })}
        <label className="text-foreground flex items-center gap-2 text-sm">
          <input type="checkbox" checked={reactions} onChange={(e) => onReactions(e.target.checked)} className="h-4 w-4" />
          {t('reactions')}
        </label>
        {field('email_prompt', t('emailPrompt'), { long: true, required: true })}
        {field('email_error', t('emailError'), { long: true })}
        {field('thanks', t('thanks'), { long: true, required: true })}
      </div>
    );
  }

  const examples = keywordList(t('wordExamples'));
  const addExample = (word: string) => {
    const current = keywordList(values.keywords ?? '');
    if (current.some((w) => w.toLowerCase() === word.toLowerCase())) return;
    onChange('keywords', [...current, word].join(', '));
  };
  const replies = choices.replies.length ? choices.replies : [''];
  const setReply = (i: number, text: string) => onChoices({ replies: replies.map((r, j) => (j === i ? text : r)) });
  const setLink = (i: number, patch: Partial<LinkRow>) =>
    onChoices({ moreLinks: choices.moreLinks.map((row, j) => (j === i ? { ...row, ...patch } : row)) });

  return (
    <div className="space-y-6">
      <Section title={t('whenComments')}>
        <div role="radiogroup" aria-label={t('whenComments')} className="space-y-2" data-field="media_ids">
          <ChoiceCard name="post_scope" value="specific" checked={choices.postScope === 'specific'} label={t('scopeSpecific')}
            onChoose={() => onChoices({ postScope: 'specific' })}>
            <div className="space-y-2">
              {accounts.length > 1 && (
                <label className="text-muted-foreground flex items-center gap-2 text-xs">
                  {t('postsFrom')}
                  <select value={pickerAccount ?? ''} onChange={(e) => setPostsAccount(e.target.value)}
                    className="border-border bg-background text-foreground rounded-md border px-2 py-1 text-xs">
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </label>
              )}
              {pickerAccount ? (
                <IgPostPicker key={pickerAccount} accountId={pickerAccount} selected={choices.mediaIds} onLoaded={onPosts}
                  onToggle={(id) => onChoices({
                    mediaIds: choices.mediaIds.includes(id) ? choices.mediaIds.filter((m) => m !== id) : [...choices.mediaIds, id],
                  })} />
              ) : (
                <p className="text-muted-foreground text-xs">{t('noAccount')}</p>
              )}
              {errorFor('media_ids') && <p className="text-destructive text-xs" role="alert">{errorFor('media_ids')}</p>}
            </div>
          </ChoiceCard>
          <ChoiceCard name="post_scope" value="any" checked={choices.postScope === 'any'} label={t('scopeAny')} help={t('scopeAnyHelp')}
            onChoose={() => onChoices({ postScope: 'any' })} />
          <ChoiceCard name="post_scope" value="next" checked={choices.postScope === 'next'} label={t('scopeNext')} help={t('scopeNextHelp')}
            onChoose={() => onChoices({ postScope: 'next' })} />
        </div>
      </Section>

      <Section title={t('commentHas')}>
        <div role="radiogroup" aria-label={t('commentHas')} className="space-y-2">
          <ChoiceCard name="words" value="specific" checked={choices.words === 'specific'} label={t('wordsSpecific')}
            onChoose={() => onChoices({ words: 'specific' })}>
            <div className="space-y-2">
              {field('keywords', t('keyword'), { help: t('wordsHelp') })}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">{t('wordsTry')}</span>
                {examples.map((word) => (
                  <button key={word} type="button" onClick={() => addExample(word)}
                    className="border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 rounded-full border px-2.5 py-0.5 font-medium">
                    {word}
                  </button>
                ))}
              </div>
            </div>
          </ChoiceCard>
          <ChoiceCard name="words" value="any" checked={choices.words === 'any'} label={t('wordsAny')} help={t('wordsAnyHelp')}
            onChoose={() => onChoices({ words: 'any' })} />
        </div>
        <SwitchRow label={t('replyUnder')} help={t('replyUnderHelp')} checked={choices.replyOn} onChange={(replyOn) => onChoices({ replyOn })}>
          <div className="space-y-2" data-field="public_reply">
            {replies.map((reply, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={reply} aria-label={t('replyN', { n: i + 1 })} data-field="public_reply"
                  aria-invalid={error?.field === 'public_reply' || undefined} onChange={(e) => setReply(i, e.target.value)} />
                {replies.length > 1 && (
                  <Button type="button" variant="ghost" size="icon" aria-label={t('removeReply', { n: i + 1 })}
                    onClick={() => onChoices({ replies: replies.filter((_, j) => j !== i) })}>
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            {replies.length < MAX_REPLIES && (
              <Button type="button" variant="outline" size="sm" onClick={() => onChoices({ replies: [...replies, ''] })}>
                <Plus className="size-3.5" />{t('addReply')}
              </Button>
            )}
            {errorFor('public_reply') && <p className="text-destructive text-xs" role="alert">{errorFor('public_reply')}</p>}
          </div>
        </SwitchRow>
      </Section>

      <Section title={t('theyGetDm')}>
        {field('message', t('message'), { long: true, required: true })}
        {field('opt_in_label', t('optInLabel'), { help: t('optInHelp') })}
      </Section>

      {wizard === 'comment_links' ? (
        <>
          {/* In the order the DM asks: the email, then the follow. */}
          <Section title={t('beforeLink')}>
            <SwitchRow label={t('askEmail')} help={t('askEmailHelp')} checked={choices.askEmail}
              onChange={(askEmail) => onChoices({ askEmail })}>
              {field('email_prompt', t('emailPrompt'), { long: true })}
              {field('email_error', t('emailError'), { long: true })}
            </SwitchRow>
            <SwitchRow label={t('askFollow')} help={t('askFollowHelp')} checked={choices.askFollow}
              onChange={(askFollow) => onChoices({ askFollow })}>
              {field('follow_prompt', t('followPrompt'), { long: true })}
              {field('followed_label', t('followedButtonLabel'))}
            </SwitchRow>
          </Section>
          <Section title={t('theLink')}>
            {field('card_title', t('cardTitle'))}
            <div className="grid gap-3 sm:grid-cols-2">
              {field('link_label', t('linkLabel'))}
              {field('link_url', t('link'), { type: 'url', required: true })}
            </div>
            {choices.moreLinks.map((row, i) => (
              <div key={i} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]" data-field="more_links">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('linkLabelN', { n: i + 2 })}</Label>
                  <Input value={row.label} onChange={(e) => setLink(i, { label: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('linkN', { n: i + 2 })}</Label>
                  <Input type="url" value={row.url} onChange={(e) => setLink(i, { url: e.target.value })} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={t('removeLink', { n: i + 2 })}
                  onClick={() => onChoices({ moreLinks: choices.moreLinks.filter((_, j) => j !== i) })}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            {choices.moreLinks.length < MAX_MORE_LINKS && (
              <Button type="button" variant="outline" size="sm"
                onClick={() => onChoices({ moreLinks: [...choices.moreLinks, { label: '', url: '' }] })}>
                <Plus className="size-3.5" />{t('addLink')}
              </Button>
            )}
            {errorFor('more_links') && <p className="text-destructive text-xs" role="alert">{errorFor('more_links')}</p>}
          </Section>
        </>
      ) : (
        <Section title={t('beforeReward')}>
          {field('follow_prompt', t('followPrompt'), { long: true })}
          {field('followed_label', t('followedButtonLabel'))}
          <p className="text-muted-foreground text-xs">{t('followGateNote')}</p>
          {field('reward_title', t('rewardTitle'))}
          {field('reward_label', t('rewardButton'))}
          {field('reward_url', t('reward'), { type: 'url', required: true })}
        </Section>
      )}
    </div>
  );
}

function Field({ name, label, help, error, children }: {
  name: string;
  label: string;
  help?: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = `${useId()}-${name}`;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id, describedBy)}
      {help && <p id={helpId} className="text-muted-foreground text-xs">{help}</p>}
      {error && <p id={errorId} className="text-destructive text-xs" role="alert">{error}</p>}
    </div>
  );
}

/** Bytes left of Instagram's 1,000-byte message limit, counted down as the author types. */
function CharactersLeft({ value }: { value: string }) {
  const t = useTranslations('Instagram.quickAutomations.preview');
  const left = MESSAGE_BYTES - byteLength(value);
  return (
    <p className={cn('text-right text-[11px] tabular-nums', left < 0 ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite">
      {t('remaining', { count: left })}
    </p>
  );
}

/** A grey avatar circle, as Instagram shows a profile without a picture. */
const Avatar = ({ size = 'size-6' }: { size?: string }) => <span className={cn('shrink-0 rounded-full bg-neutral-600', size)} aria-hidden />;

/** A live Android-phone preview of what the setup sends: the post, the comment thread and the DMs. */
function WizardPreview({ wizard, values, choices, posts, tab, onTab }: {
  wizard: Wizard; values: Values; choices: CommentChoices; posts: InstagramMedia[]; tab: PreviewTab; onTab: (tab: PreviewTab) => void;
}) {
  const t = useTranslations('Instagram.quickAutomations.preview');
  const accounts = useInstagramAccounts();
  const handle = accounts[0]?.username ?? t('yourAccount');
  const v = (name: string) => values[name] ?? '';
  const words = choices.words === 'specific' ? keywordList(v('keywords')) : [];
  const comment = (wizard === 'story_leads' ? keywordList(v('keywords'))[0] : words[0]) ?? t('anyWord');
  const tabs: PreviewTab[] = wizard === 'story_leads' ? ['dm'] : ['post', 'comments', 'dm'];
  const chosen = choices.postScope === 'specific' ? posts.find((p) => choices.mediaIds.includes(p.id)) : undefined;
  const replies = choices.replyOn ? choices.replies.map((r) => r.trim()).filter(Boolean) : [];

  const bot = (text: string, key: string, button?: string) => text.trim() ? (
    <div key={key} className="flex items-end gap-1.5">
      <Avatar size="size-5" />
      <div className="max-w-[80%] overflow-hidden rounded-2xl rounded-bl-md bg-neutral-800">
        <p className="whitespace-pre-wrap break-words px-3 py-2 text-[11px] leading-snug">{text}</p>
        {button?.trim() && <p className="mx-2 mb-2 rounded-lg bg-neutral-700 py-1.5 text-center text-[11px] font-medium">{button}</p>}
      </div>
    </div>
  ) : null;
  const me = (text: string, key: string) => text.trim() ? (
    <p key={key} className="ml-auto max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-violet-600 px-3 py-2 text-[11px]">{text}</p>
  ) : null;
  const card = (title: string, buttons: string[], key: string) => (
    <div key={key} className="flex items-end gap-1.5">
      <Avatar size="size-5" />
      <div className="w-[80%] overflow-hidden rounded-2xl bg-neutral-800">
        <div className="flex h-16 items-center justify-center bg-neutral-700"><ImageIcon className="size-5 text-neutral-400" aria-hidden /></div>
        <p className="px-3 py-2 text-[11px] font-semibold">{title || t('cardPlaceholder')}</p>
        {buttons.filter((b) => b.trim()).map((b, i) => (
          <p key={i} className="border-t border-white/10 py-1.5 text-center text-[11px] font-medium text-sky-400">{b}</p>
        ))}
      </div>
    </div>
  );

  let header: ReactNode;
  let body: ReactNode;
  let footer: ReactNode = null;
  if (tab === 'post') {
    header = (
      <div className="flex items-center gap-3 px-3 py-2">
        <ArrowLeft className="size-4" aria-hidden />
        <div className="leading-tight">
          <p className="text-[10px] font-semibold uppercase text-neutral-400">{handle}</p>
          <p className="text-xs font-semibold">{t('postsHeader')}</p>
        </div>
      </div>
    );
    const placeholder = choices.postScope === 'next' ? t('worksOnNext') : choices.postScope === 'any' ? t('worksOnAny') : t('pickAPost');
    body = (
      <div>
        <div className="flex items-center gap-2 px-3 py-2"><Avatar /><span className="text-[11px] font-semibold">{handle}</span></div>
        {chosen?.previewUrl ? (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URLs; next/image would need every CDN host configured. */}
            <img src={chosen.previewUrl} alt={chosen.caption ?? ''} className="aspect-square w-full object-cover" referrerPolicy="no-referrer" />
            {chosen.isReel && <Clapperboard className="absolute top-2 right-2 size-4 drop-shadow" aria-label={t('reel')} />}
          </div>
        ) : (
          <div className="flex aspect-square items-center justify-center bg-neutral-900 px-8 text-center text-xs text-neutral-300">{placeholder}</div>
        )}
        {chosen?.caption && <p className="line-clamp-2 px-3 py-2 text-[11px]"><span className="font-semibold">{handle}</span> {chosen.caption}</p>}
        {choices.postScope === 'specific' && choices.mediaIds.length > 1 && (
          <p className="px-3 pb-2 text-[10px] text-neutral-400">{t('morePosts', { count: choices.mediaIds.length - 1 })}</p>
        )}
      </div>
    );
  } else if (tab === 'comments') {
    header = <p className="py-2 text-center text-xs font-semibold">{t('comments')}</p>;
    body = (
      <div className="space-y-3 px-3 py-3">
        <div className="flex gap-2">
          <Avatar />
          <div className="min-w-0 text-[11px]">
            <p><span className="font-semibold">{t('follower')}</span> <span className="text-neutral-400">{t('now')}</span></p>
            <p>{comment}</p>
            <p className="mt-0.5 text-[10px] text-neutral-400">{t('reply')}</p>
          </div>
        </div>
        {replies[0] && (
          <div className="ml-8 flex gap-2">
            <Avatar size="size-5" />
            <div className="min-w-0 text-[11px]">
              <p><span className="font-semibold">{handle}</span> <span className="text-neutral-400">{t('now')}</span></p>
              <p className="whitespace-pre-wrap break-words">{replies[0]}</p>
            </div>
          </div>
        )}
        {replies.length > 1 && <p className="ml-8 text-[10px] text-neutral-400">{t('repliesRotate', { count: replies.length })}</p>}
      </div>
    );
    footer = <p className="mx-3 mb-2 rounded-full border border-white/15 px-3 py-1.5 text-[11px] text-neutral-500">{t('addComment')}</p>;
  } else {
    header = (
      <div className="flex items-center gap-2 px-3 py-2">
        <ArrowLeft className="size-4" aria-hidden />
        <Avatar />
        <span className="flex-1 truncate text-xs font-semibold">{handle}</span>
        <Phone className="size-4" aria-hidden />
        <Video className="size-4" aria-hidden />
      </div>
    );
    const steps: ReactNode[] = [];
    if (wizard === 'story_leads') {
      steps.push(me(comment, 'reply'), bot(v('email_prompt'), 'ask'), me(t('sampleEmail'), 'email'), bot(v('thanks'), 'thanks'));
    } else {
      steps.push(bot(v('message'), 'opening', v('opt_in_label')), me(v('opt_in_label'), 'tap'));
      if (wizard === 'comment_links') {
        if (choices.askEmail) steps.push(bot(v('email_prompt'), 'ask-email'), me(t('sampleEmail'), 'email'));
        if (choices.askFollow) steps.push(bot(v('follow_prompt'), 'ask-follow', v('followed_label')), me(v('followed_label'), 'followed'));
        steps.push(card(v('card_title'), [v('link_label'), ...choices.moreLinks.map((l) => l.label)], 'link'));
      } else {
        steps.push(bot(v('follow_prompt'), 'ask-follow', v('followed_label')), me(v('followed_label'), 'followed'),
          card(v('reward_title'), [v('reward_label')], 'reward'));
      }
    }
    body = <div className="space-y-2.5 px-3 py-3">{steps}</div>;
    footer = <p className="mx-3 mb-2 rounded-full bg-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500">{t('message')}</p>;
  }

  return (
    <aside aria-label={t('title')} className="space-y-2">
      {tabs.length > 1 && (
        <div role="tablist" aria-label={t('title')} className="flex gap-1">
          {tabs.map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => onTab(name)}
              className={cn('flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                tab === name ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
              {t(name)}
            </button>
          ))}
        </div>
      )}
      <AndroidPhone label={t(tab)} header={header} footer={footer}>
        <div role="tabpanel" aria-label={t(tab)}>{body}</div>
      </AndroidPhone>
    </aside>
  );
}
