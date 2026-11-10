'use client';

// Instagram › Quick automations (Stage 2, plan item 10): three guided setups
// that turn a few answers into a draft Instagram flow, and the gallery of
// Instagram starter templates. Both create an ordinary draft the author then
// reviews and publishes in the flow builder; nothing runs until it is
// published. The Instagram section layout already explains a channel that is
// off or not available. Creating flows needs an agent or above (the server
// enforces it too).

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MessageCircle, Sparkles, UserPlus } from 'lucide-react';

import { TemplateGallery, type TemplateSummary } from '@/components/flows/template-gallery';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';
import { formFieldFor, type WizardId as Wizard } from '@/lib/instagram/wizard-form';
import { cn } from '@/lib/utils';

type FieldProblem = 'invalid' | 'keywords' | 'posts' | 'text' | 'button' | 'title' | 'url' | 'publicReply';

const WIZARDS: Array<{ id: Wizard; key: 'commentLinks' | 'growFollowers' | 'storyLeads'; icon: typeof MessageCircle }> = [
  { id: 'comment_links', key: 'commentLinks', icon: MessageCircle },
  { id: 'grow_followers', key: 'growFollowers', icon: UserPlus },
  { id: 'story_leads', key: 'storyLeads', icon: Sparkles },
];

type Values = Record<string, string>;

/** "a, b ,c" → ["a","b","c"] */
const keywordList = (value: string): string[] => value.split(',').map((k) => k.trim()).filter(Boolean);

export default function InstagramQuickAutomationsPage() {
  const t = useTranslations('Instagram.quickAutomations');
  const router = useRouter();
  const { accountId } = useAuth();
  const canCreate = useCan('send-messages');
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const [values, setValues] = useState<Values>({});
  const [postScope, setPostScope] = useState<'any' | 'next'>('any');
  const [reactions, setReactions] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string; problem: FieldProblem } | null>(null);

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

  function openWizard(id: Wizard) {
    const key = WIZARDS.find((w) => w.id === id)!.key;
    const d = (name: string) => t(`defaults.${key}.${name}`);
    const defaults: Record<Wizard, Values> = {
      comment_links: {
        keywords: '', public_reply: d('publicReply'), message: d('message'), opt_in_label: d('optInLabel'),
        card_title: d('cardTitle'), link_label: d('linkLabel'), link_url: '',
      },
      grow_followers: {
        keywords: '', public_reply: d('publicReply'), message: d('message'), opt_in_label: d('optInLabel'),
        follow_prompt: d('followPrompt'), followed_label: d('followedButton'), reward_title: d('rewardTitle'),
        reward_label: d('rewardButton'), reward_url: '',
      },
      story_leads: { keywords: '', email_prompt: d('emailPrompt'), email_error: d('emailError'), thanks: d('thanks') },
    };
    setValues(defaults[id]);
    setPostScope('any');
    setReactions(false);
    setFieldError(null);
    setWizard(id);
  }

  function body(): Record<string, unknown> {
    const v = (name: string) => values[name] ?? '';
    if (wizard === 'story_leads') {
      return { wizard, keywords: keywordList(v('keywords')), reactions, email_prompt: v('email_prompt'), email_error: v('email_error'), thanks: v('thanks') };
    }
    const common = {
      wizard,
      post_scope: postScope,
      keywords: keywordList(v('keywords')),
      public_replies: v('public_reply').trim() ? [v('public_reply')] : [],
      message: v('message'),
      opt_in_label: v('opt_in_label'),
    };
    if (wizard === 'comment_links') {
      return { ...common, card_title: v('card_title'), link_label: v('link_label'), link_url: v('link_url') };
    }
    return {
      ...common, follow_prompt: v('follow_prompt'), followed_label: v('followed_label'), reward_title: v('reward_title'),
      reward_label: v('reward_label'), reward_url: v('reward_url'),
    };
  }

  async function finishWizard() {
    if (!wizard) return;
    setCreating(true);
    setFieldError(null);
    try {
      const res = await authFetch('/api/instagram/wizards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const json = (await res.json().catch(() => ({}))) as {
        flow?: { id: string }; error?: string; message?: string; field?: string; problem?: FieldProblem;
      };
      if (res.status === 400 && json.field) {
        // Shown under its box; a field the form has no box for (the body, the post choice) becomes a toast.
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
        <DialogContent className="bg-popover text-popover-foreground max-h-[90vh] overflow-y-auto sm:max-w-lg">
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
              <WizardFields
                wizard={active.id}
                values={values}
                onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
                postScope={postScope}
                onPostScope={setPostScope}
                reactions={reactions}
                onReactions={setReactions}
                error={fieldError}
              />
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

function WizardFields({
  wizard, values, onChange, postScope, onPostScope, reactions, onReactions, error,
}: {
  wizard: Wizard;
  values: Values;
  onChange: (name: string, value: string) => void;
  postScope: 'any' | 'next';
  onPostScope: (scope: 'any' | 'next') => void;
  reactions: boolean;
  onReactions: (value: boolean) => void;
  error: { field: string; problem: FieldProblem } | null;
}) {
  const t = useTranslations('Instagram.quickAutomations');
  const field = (name: string, label: string, options: { help?: string; long?: boolean; type?: string; required?: boolean } = {}) => (
    <Field
      key={name}
      name={name}
      label={label}
      help={options.help}
      error={error?.field === name ? t(`errors.${error.problem}`) : undefined}
    >
      {(id, describedBy) => {
        const shared = {
          id,
          value: values[name] ?? '',
          required: options.required,
          'aria-invalid': error?.field === name || undefined,
          'aria-describedby': describedBy,
        };
        return options.long ? (
          <Textarea {...shared} rows={3} onChange={(e) => onChange(name, e.target.value)} />
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

  const chip = (scope: 'any' | 'next', label: string) => (
    <button
      key={scope}
      type="button"
      aria-pressed={postScope === scope}
      onClick={() => onPostScope(scope)}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        postScope === scope
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span className="text-foreground text-sm font-medium" id="ig-wizard-post">{t('post')}</span>
        <div role="group" aria-labelledby="ig-wizard-post" className="flex flex-wrap gap-1.5">
          {chip('any', t('anyPost'))}
          {chip('next', t('nextPost'))}
        </div>
      </div>
      {field('keywords', t('keyword'), { help: t('keywordHelp') })}
      {field('public_reply', t('publicReply'), { help: t('publicReplyHelp') })}
      {field('message', t('message'), { long: true, required: true })}
      {field('opt_in_label', t('optInLabel'), { help: t('optInHelp') })}
      {wizard === 'comment_links' ? (
        <>
          {field('card_title', t('cardTitle'))}
          {field('link_label', t('linkLabel'))}
          {field('link_url', t('link'), { type: 'url', required: true })}
        </>
      ) : (
        <>
          {field('follow_prompt', t('followPrompt'), { long: true })}
          {field('followed_label', t('followedButtonLabel'))}
          <p className="text-muted-foreground text-xs">{t('followGateNote')}</p>
          {field('reward_title', t('rewardTitle'))}
          {field('reward_label', t('rewardButton'))}
          {field('reward_url', t('reward'), { type: 'url', required: true })}
        </>
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
