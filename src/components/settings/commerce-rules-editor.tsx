'use client';

// CommerceRulesEditor — "when this store event happens, send this WhatsApp
// template". Shared by the store integration cards (WooCommerce, Shopify):
//
//   <CommerceRulesEditor source="woocommerce" events={[...]} fields={[...]} />
//
// One settings row per event (its on/off state and template); the row opens a
// sheet with on/off, approved template, sending number, delay and the template
// variable → event field mapping, saved with one Save. Remove sits in the row's
// more menu behind a confirm. Reads and saves through
// /api/integrations/commerce-rules (members read, admins save; the server
// enforces both). Non-admins see the rules read-only.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { PageLoading } from '@/components/ui/page-loading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { SettingsBlock, SettingsGroup, SettingsMoreMenu } from '@/components/settings/settings-row';
import { NumberSelect } from '@/components/settings/numbers/number-select';
import { useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import type { CommerceEventName, CommerceSource } from '@/lib/commerce/event-rules';
import type { CommerceRulePublic } from '@/lib/integrations/commerce-rules';

interface TemplateOption {
  id: string;
  name: string;
  language: string | null;
  category: string | null;
  body_text: string | null;
}

interface Draft {
  enabled: boolean;
  templateKey: string; // `${name}|${language}` or ''
  whatsappConfigId: string | null;
  delayMinutes: string;
  variableMap: Record<string, string>;
}

/** The menu value standing for an empty choice. */
const NONE = '__none__';

/** Highest positional {{n}} in a template body (0 when none). */
export function templateVariableCount(body: string | null | undefined): number {
  let max = 0;
  for (const m of (body ?? '').matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return Math.min(max, 20);
}

const keyOf = (name: string, language: string | null) => `${name}|${language ?? ''}`;

function toDraft(rule: CommerceRulePublic | undefined): Draft {
  return {
    enabled: rule?.enabled ?? false,
    templateKey: rule ? keyOf(rule.template_name, rule.template_language) : '',
    whatsappConfigId: rule?.whatsapp_config_id ?? null,
    delayMinutes: String(rule?.delay_minutes ?? 0),
    variableMap: rule?.variable_map ?? {},
  };
}

export function CommerceRulesEditor({
  title,
  source,
  events,
  fields,
}: {
  /** The settings group's header. */
  title: ReactNode;
  source: CommerceSource;
  events: CommerceEventName[];
  /** Event fields a template variable can show, e.g. order_number, total. */
  fields: string[];
}) {
  const t = useTranslations('Integrations.commerceRules');
  const fieldLabel = (f: string) => (t.has(`fields.${f}`) ? t(`fields.${f}`) : f);
  const { canEditSettings } = useAuth();
  const { numbers } = useWhatsAppNumbers();
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [rules, setRules] = useState<Partial<Record<CommerceEventName, CommerceRulePublic>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<CommerceEventName, Draft>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CommerceEventName | null>(null);
  const [open, setOpen] = useState<CommerceEventName | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      const [res, tpl] = await Promise.all([
        authFetch(`/api/integrations/commerce-rules?source=${source}`, { cache: 'no-store' }),
        createClient()
          .from('message_templates')
          .select('id,name,language,category,body_text')
          .eq('status', 'APPROVED')
          .order('name'),
      ]);
      const payload = (await res.json().catch(() => ({}))) as { rules?: CommerceRulePublic[] };
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      const byEvent: Partial<Record<CommerceEventName, CommerceRulePublic>> = {};
      for (const rule of payload.rules ?? []) byEvent[rule.event] = rule;
      setRules(byEvent);
      setDrafts(Object.fromEntries(events.map((e) => [e, toDraft(byEvent[e])])));
      setTemplates((tpl.data as TemplateOption[] | null) ?? []);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [source, events, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const templateByKey = useMemo(
    () => new Map(templates.map((tpl) => [keyOf(tpl.name, tpl.language), tpl])),
    [templates],
  );

  const patch = (event: CommerceEventName, change: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [event]: { ...(prev[event] ?? toDraft(undefined)), ...change } }));

  async function save(event: CommerceEventName) {
    const draft = drafts[event];
    if (!draft) return;
    const [name, language] = draft.templateKey.split('|');
    if (!name) {
      toast.error(t('errors.template_invalid'));
      return;
    }
    const count = templateVariableCount(templateByKey.get(draft.templateKey)?.body_text);
    const variableMap = Object.fromEntries(
      Object.entries(draft.variableMap).filter(([k, v]) => Number(k) <= count && v),
    );
    setBusy(event);
    try {
      const res = await authFetch('/api/integrations/commerce-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          event,
          enabled: draft.enabled,
          templateName: name,
          templateLanguage: language || null,
          whatsappConfigId: draft.whatsappConfigId,
          delayMinutes: Number(draft.delayMinutes),
          variableMap,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { rule?: CommerceRulePublic; code?: string };
      if (!res.ok || !payload.rule) {
        toast.error(payload.code && t.has(`errors.${payload.code}`) ? t(`errors.${payload.code}`) : t('saveFailed'));
        return;
      }
      setRules((prev) => ({ ...prev, [event]: payload.rule }));
      setDrafts((prev) => ({ ...prev, [event]: toDraft(payload.rule) }));
      setOpen(null);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(event: CommerceEventName) {
    const ok = await confirm({
      title: t('removeTitle', { event: t(`events.${event}`) }),
      body: t('removeBody'),
      confirmLabel: t('remove'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(event);
    try {
      const res = await authFetch(`/api/integrations/commerce-rules?source=${source}&event=${event}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        toast.error(t('saveFailed'));
        return;
      }
      setRules((prev) => ({ ...prev, [event]: undefined }));
      setDrafts((prev) => ({ ...prev, [event]: toDraft(undefined) }));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  }

  /** Closing the sheet without saving drops the unsaved changes. */
  const close = () => {
    if (open) setDrafts((prev) => ({ ...prev, [open]: toDraft(rules[open]) }));
    setOpen(null);
  };

  const summary = (event: CommerceEventName) => {
    const rule = rules[event];
    if (!rule) return t('notSetUp');
    return [
      rule.template_language ? `${rule.template_name} · ${rule.template_language}` : rule.template_name,
      t('delayMinutes', { count: rule.delay_minutes }),
    ].join(' · ');
  };

  const draft = open ? (drafts[open] ?? toDraft(undefined)) : null;
  const template = draft ? templateByKey.get(draft.templateKey) : undefined;
  const count = templateVariableCount(template?.body_text);
  const disabled = !canEditSettings || (open !== null && busy === open);
  const id = `${source}-${open ?? ''}`;

  return (
    <SettingsGroup title={title} footer={t('consentNote')}>
      {loading ? (
        <SettingsBlock><PageLoading rows={3} /></SettingsBlock>
      ) : (
        <>
          {templates.length === 0 && (
            <GroupedListRow title={<span className="text-muted-foreground">{t('noTemplates')}</span>} className="[&_.truncate]:whitespace-normal" />
          )}
          {events.map((event) => {
            const rule = rules[event];
            return (
              <div key={event} className="relative flex items-center not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-separator">
                <GroupedListRow
                  title={<span className="font-medium">{t(`events.${event}`)}</span>}
                  subtitle={summary(event)}
                  trailing={rule ? (rule.enabled ? t('on') : t('off')) : undefined}
                  chevron
                  onClick={() => setOpen(event)}
                  className="min-w-0 flex-1"
                />
                {canEditSettings && rule && (
                  <SettingsMoreMenu
                    className="mr-2 shrink-0"
                    label={t('moreFor', { event: t(`events.${event}`) })}
                    actions={[
                      { label: t('edit'), icon: Pencil, onSelect: () => setOpen(event) },
                      { label: t('remove'), icon: Trash2, destructive: true, disabled: busy === event, onSelect: () => void remove(event) },
                    ]}
                  />
                )}
              </div>
            );
          })}
        </>
      )}

      <Sheet open={open !== null} onOpenChange={(next) => !next && close()}>
        <SheetContent size="md" className="overflow-y-auto">
          {open && draft && (
            <>
              <SheetHeader>
                <SheetTitle>{t(`events.${open}`)}</SheetTitle>
                <SheetDescription>{t('consentNote')}</SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4">
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm font-medium">{t('enabled')}</p>
                    {template?.category?.toUpperCase() === 'MARKETING' && (
                      <p className="text-muted-foreground text-xs">{t('marketingHint')}</p>
                    )}
                  </div>
                  <Switch
                    checked={draft.enabled}
                    disabled={disabled}
                    onCheckedChange={(checked) => patch(open, { enabled: checked === true })}
                    aria-label={t('enabled')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-template`}>{t('template')}</Label>
                  <Select
                    value={draft.templateKey || NONE}
                    disabled={disabled}
                    onValueChange={(v) => patch(open, { templateKey: !v || v === NONE ? '' : String(v) })}
                  >
                    <SelectTrigger id={`${id}-template`} className="min-h-11 w-full bg-card sm:min-h-9">
                      <SelectValue>{(v: string) => (v === NONE ? t('chooseTemplate') : v.replace('|', ' · '))}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('chooseTemplate')}</SelectItem>
                      {draft.templateKey && !template && (
                        <SelectItem value={draft.templateKey}>{draft.templateKey.replace('|', ' · ')}</SelectItem>
                      )}
                      {templates.map((tpl) => (
                        <SelectItem key={tpl.id} value={keyOf(tpl.name, tpl.language)}>
                          {tpl.name}{tpl.language ? ` · ${tpl.language}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-number`}>{t('number')}</Label>
                  <NumberSelect
                    id={`${id}-number`}
                    numbers={numbers}
                    value={draft.whatsappConfigId}
                    disabled={disabled}
                    emptyLabel={t('defaultNumber')}
                    onChange={(value) => patch(open, { whatsappConfigId: value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-delay`}>{t('delay')}</Label>
                  <Input
                    id={`${id}-delay`}
                    type="number"
                    min={0}
                    max={10080}
                    inputMode="numeric"
                    value={draft.delayMinutes}
                    disabled={disabled}
                    onChange={(e) => patch(open, { delayMinutes: e.target.value })}
                  />
                </div>
                {count > 0 && (
                  <div className="space-y-2">
                    <p className="text-foreground text-sm font-medium">{t('variables')}</p>
                    {Array.from({ length: count }, (_, i) => String(i + 1)).map((n) => (
                      <div key={n} className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground w-12 shrink-0 font-mono text-xs">{`{{${n}}}`}</span>
                        <Select
                          value={draft.variableMap[n] || NONE}
                          disabled={disabled}
                          onValueChange={(v) => patch(open, { variableMap: { ...draft.variableMap, [n]: !v || v === NONE ? '' : String(v) } })}
                        >
                          <SelectTrigger aria-label={`{{${n}}}`} className="min-h-11 w-full bg-card sm:min-h-9">
                            <SelectValue>{(v: string) => (v === NONE ? t('noValue') : fieldLabel(v))}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>{t('noValue')}</SelectItem>
                            {fields.map((f) => (
                              <SelectItem key={f} value={f}>{fieldLabel(f)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {canEditSettings && (
                <SheetFooter className="flex-row justify-end">
                  <Button type="button" variant="outline" onClick={close}>{t('cancel')}</Button>
                  <Button type="button" disabled={disabled || !draft.templateKey} onClick={() => void save(open)}>
                    {busy === open && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('save')}
                  </Button>
                </SheetFooter>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
