'use client';

// CommerceRulesEditor — "when this store event happens, send this WhatsApp
// template". Shared by the store integration cards (WooCommerce, Shopify):
//
//   <CommerceRulesEditor source="woocommerce" events={[...]} fields={[...]} />
//
// One row per event: on/off, approved template, sending number, delay and the
// template variable → event field mapping. Reads and saves through
// /api/integrations/commerce-rules (members read, admins save; the server
// enforces both). Non-admins see the rules read-only.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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

const SELECT_CLASS = 'border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm';

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
  source,
  events,
  fields,
}: {
  source: CommerceSource;
  events: CommerceEventName[];
  /** Event fields a template variable can show, e.g. order_number, total. */
  fields: string[];
}) {
  const t = useTranslations('Integrations.commerceRules');
  const { canEditSettings } = useAuth();
  const { numbers } = useWhatsAppNumbers();
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [rules, setRules] = useState<Partial<Record<CommerceEventName, CommerceRulePublic>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<CommerceEventName, Draft>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CommerceEventName | null>(null);

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
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(event: CommerceEventName) {
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

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-xs">{t('consentNote')}</p>
      {templates.length === 0 && <p className="text-muted-foreground text-sm">{t('noTemplates')}</p>}
      {events.map((event) => {
        const draft = drafts[event] ?? toDraft(undefined);
        const template = templateByKey.get(draft.templateKey);
        const count = templateVariableCount(template?.body_text);
        const disabled = !canEditSettings || busy === event;
        const id = `${source}-${event}`;
        return (
          <div key={event} className="border-border space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">{t(`events.${event}`)}</p>
                {template?.category?.toUpperCase() === 'MARKETING' && (
                  <p className="text-muted-foreground text-xs">{t('marketingHint')}</p>
                )}
              </div>
              <Switch
                checked={draft.enabled}
                disabled={disabled}
                onCheckedChange={(checked) => patch(event, { enabled: checked === true })}
                aria-label={t('enabled')}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`${id}-template`} className="text-muted-foreground text-xs">{t('template')}</Label>
                <select
                  id={`${id}-template`}
                  className={SELECT_CLASS}
                  value={draft.templateKey}
                  disabled={disabled}
                  onChange={(e) => patch(event, { templateKey: e.target.value })}
                >
                  <option value="">{t('chooseTemplate')}</option>
                  {draft.templateKey && !template && (
                    <option value={draft.templateKey}>{draft.templateKey.replace('|', ' · ')}</option>
                  )}
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={keyOf(tpl.name, tpl.language)}>
                      {tpl.name}{tpl.language ? ` · ${tpl.language}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-delay`} className="text-muted-foreground text-xs">{t('delay')}</Label>
                <Input
                  id={`${id}-delay`}
                  type="number"
                  min={0}
                  max={10080}
                  inputMode="numeric"
                  value={draft.delayMinutes}
                  disabled={disabled}
                  onChange={(e) => patch(event, { delayMinutes: e.target.value })}
                />
              </div>
              <div className="space-y-1 sm:col-span-3">
                <Label htmlFor={`${id}-number`} className="text-muted-foreground text-xs">{t('number')}</Label>
                <NumberSelect
                  id={`${id}-number`}
                  numbers={numbers}
                  value={draft.whatsappConfigId}
                  disabled={disabled}
                  emptyLabel={t('defaultNumber')}
                  onChange={(value) => patch(event, { whatsappConfigId: value })}
                />
              </div>
            </div>
            {count > 0 && (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs">{t('variables')}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {Array.from({ length: count }, (_, i) => String(i + 1)).map((n) => (
                    <label key={n} className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground w-12 shrink-0 font-mono text-xs">{`{{${n}}}`}</span>
                      <select
                        className={SELECT_CLASS}
                        value={draft.variableMap[n] ?? ''}
                        disabled={disabled}
                        onChange={(e) => patch(event, { variableMap: { ...draft.variableMap, [n]: e.target.value } })}
                      >
                        <option value="">{t('noValue')}</option>
                        {fields.map((f) => (
                          <option key={f} value={f}>{t.has(`fields.${f}`) ? t(`fields.${f}`) : f}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {canEditSettings && (
              <div className="flex justify-end gap-2">
                {rules[event] && (
                  <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void remove(event)}>
                    <Trash2 className="h-4 w-4" />
                    {t('remove')}
                  </Button>
                )}
                <Button size="sm" disabled={disabled || !draft.templateKey} onClick={() => void save(event)}>
                  {busy === event && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
