'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { slugify } from '@/components/flows/shared';
import { getT } from '@/lib/i18n/translate';
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/interactive-limits';
import {
  validateInteractivePayload,
  type InteractiveButtonsPayload,
  type InteractiveListPayload,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { InteractivePreview } from './interactive-preview';
import { InteractiveMediaEditor } from './interactive-media-editor';
import { authFetch } from '@/lib/auth/client';

interface ActionOptions {
  automations: { id: string; name: string; is_active: boolean }[];
  flows: { id: string; name: string; status: string }[];
}

// ------------------------------------------------------------
// Blank payload factories — used to seed a fresh builder and to
// switch kind without losing the shared body/header/footer.
// ------------------------------------------------------------

/**
 * Generate an id that doesn't collide with any already in use. A plain
 * count-based id (`btn_${length+1}`) regenerates an existing id after a
 * middle item is removed, which then trips the duplicate-id validator and
 * silently blocks sending. Increment past any taken id instead.
 */
function nextId(existing: string[], prefix: string): string {
  const taken = new Set(existing);
  let n = existing.length + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function blankButtonsPayload(): InteractiveButtonsPayload {
  return {
    kind: 'buttons',
    body: '',
    buttons: [{ id: 'btn_1', title: '' }],
  };
}

export function blankListPayload(): InteractiveListPayload {
  return {
    kind: 'list',
    body: '',
    button_label: getT('Interactive')('defaultListButton'),
    sections: [{ title: '', rows: [{ id: 'row_1', title: '' }] }],
  };
}

interface InteractiveBuilderProps {
  value: InteractiveMessagePayload;
  onChange: (payload: InteractiveMessagePayload) => void;
  /** Show the live WhatsApp-style preview beside the form. Default true. */
  showPreview?: boolean;
}

/**
 * Controlled builder for a WhatsApp interactive message (reply buttons
 * or list). Enforces Meta's char limits inline (maxLength + counters)
 * and surfaces a single validation error via `validateInteractivePayload`
 * — the same check the server runs before sending. Shared by the inbox
 * composer, the automation Send node, and the quick-replies manager.
 */
export function InteractiveBuilder({
  value,
  onChange,
  showPreview = true,
}: InteractiveBuilderProps) {
  const t = useTranslations('Interactive');
  const [advanced, setAdvanced] = useState(false);
  const [options, setOptions] = useState<ActionOptions>({
    automations: [],
    flows: [],
  });
  const [optionsState, setOptionsState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('loading');
  const [reload, setReload] = useState(0);
  const hasWorkflow =
    value.kind === 'buttons' &&
    value.buttons.some(
      (button) =>
        button.action?.type === 'automation' || button.action?.type === 'flow'
    );
  const needsOptions = advanced || hasWorkflow;
  useEffect(() => {
    if (!needsOptions) return;
    let cancelled = false;
    void authFetch('/api/quick-replies/options', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Options unavailable');
        const data = (await res.json()) as ActionOptions;
        if (!cancelled) {
          setOptions({
            automations: data.automations.filter((a) => a.is_active),
            flows: data.flows.filter((f) => f.status === 'active'),
          });
          setOptionsState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setOptionsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [needsOptions, reload]);
  const targetNames = Object.fromEntries([
    ...options.automations.map((a) => [`automation:${a.id}`, a.name]),
    ...options.flows.map((f) => [`flow:${f.id}`, f.name]),
  ]);
  const validation = validateInteractivePayload(value);

  const setField = (patch: Partial<InteractiveMessagePayload>) =>
    onChange({ ...value, ...patch } as InteractiveMessagePayload);

  const switchKind = (kind: 'buttons' | 'list') => {
    if (kind === value.kind) return;
    const shared = {
      body: value.body,
      header: value.header,
      footer: value.footer,
      media: value.media,
    };
    onChange(
      kind === 'buttons'
        ? { ...blankButtonsPayload(), ...shared }
        : { ...blankListPayload(), ...shared }
    );
  };

  return (
    // Editor and preview sit side by side only when the SPACE WE WERE
    // GIVEN can hold both — a container query, not a viewport one. This
    // builder is embedded in places far narrower than the screen (an
    // automation step card, and a step nested in a condition branch is
    // narrower still); keying the split to `md:` meant a desktop
    // viewport forced a 280px preview column into a ~190px card and the
    // whole editor overflowed (issue #474).
    <div className="@container">
      <div className="flex flex-col gap-4 @2xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Kind toggle */}
          <div className="flex gap-2">
            <KindButton
              active={value.kind === 'buttons'}
              label={t('replyButtons')}
              onClick={() => switchKind('buttons')}
            />
            <KindButton
              active={value.kind === 'list'}
              label={t('list')}
              onClick={() => switchKind('list')}
            />
          </div>

          <Field
            label={t('body')}
            counter={`${value.body.length}/${INTERACTIVE_LIMITS.bodyMaxLength}`}
          >
            <Textarea
              value={value.body}
              maxLength={INTERACTIVE_LIMITS.bodyMaxLength}
              onChange={(e) => setField({ body: e.target.value })}
              placeholder={t('bodyPlaceholder')}
              className="bg-muted text-foreground min-h-20"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field
              label={t('header')}
              counter={`${(value.header ?? '').length}/${INTERACTIVE_LIMITS.headerTextMaxLength}`}
            >
              <Input
                value={value.header ?? ''}
                maxLength={INTERACTIVE_LIMITS.headerTextMaxLength}
                onChange={(e) => setField({ header: e.target.value })}
                className="bg-muted text-foreground"
              />
            </Field>
            <Field
              label={t('footer')}
              counter={`${(value.footer ?? '').length}/${INTERACTIVE_LIMITS.footerMaxLength}`}
            >
              <Input
                value={value.footer ?? ''}
                maxLength={INTERACTIVE_LIMITS.footerMaxLength}
                onChange={(e) => setField({ footer: e.target.value })}
                className="bg-muted text-foreground"
              />
            </Field>
          </div>

          <InteractiveMediaEditor
            value={value.media}
            onChange={(media) => setField({ media })}
          />
          {value.media &&
            (value.media.type === 'location' || value.kind === 'list') && (
              <p className="text-muted-foreground text-xs">
                {t('separateMediaHint')}
              </p>
            )}
          {value.kind === 'buttons' &&
            value.media &&
            value.media.type !== 'location' && (
              <p className="text-muted-foreground text-xs">
                {t('mediaHeaderHint')}
              </p>
            )}

          {value.kind === 'buttons' ? (
            <ButtonsEditor
              value={value}
              onChange={onChange}
              advanced={advanced}
              options={options}
              optionsState={optionsState}
              retry={() => {
                setOptionsState('loading');
                setReload((n) => n + 1);
              }}
            />
          ) : (
            <ListEditor value={value} onChange={onChange} advanced={advanced} />
          )}

          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(e) => {
                if (e.target.checked && !needsOptions)
                  setOptionsState('loading');
                setAdvanced(e.target.checked);
              }}
              className="accent-primary h-3.5 w-3.5"
            />
            {t('showIds')}
          </label>

          {!validation.ok && (
            <p className="text-xs text-red-400">{validation.error}</p>
          )}
        </div>

        {showPreview && (
          <div className="flex shrink-0 flex-col gap-1.5 @2xl:w-[280px]">
            <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              {t('preview')}
            </span>
            <div className="bg-muted/40 rounded-lg p-3">
              <InteractivePreview
                payload={value}
                labels={{
                  body: t('previewBody'),
                  button: t('previewButton'),
                  menu: t('previewMenu'),
                  link: t('openLink'),
                  automation: t('existingAutomation'),
                  flow: t('existingFlow'),
                  location: t('mediaLocation'),
                  file: t('mediaFile'),
                  image: t('mediaImage'),
                  video: t('mediaVideo'),
                }}
                targetNames={targetNames}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Buttons editor
// ------------------------------------------------------------

function ButtonsEditor({
  value,
  onChange,
  advanced,
  options,
  optionsState,
  retry,
}: {
  value: InteractiveButtonsPayload;
  onChange: (p: InteractiveMessagePayload) => void;
  advanced: boolean;
  options: ActionOptions;
  optionsState: 'idle' | 'loading' | 'ready' | 'error';
  retry: () => void;
}) {
  const t = useTranslations('Interactive');
  const buttons = value.buttons;
  const update = (
    idx: number,
    patch: Partial<InteractiveButtonsPayload['buttons'][number]>
  ) =>
    onChange({
      ...value,
      buttons: buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  const add = () =>
    onChange({
      ...value,
      buttons: [
        ...buttons,
        {
          id: nextId(
            buttons.map((b) => b.id),
            'btn_'
          ),
          title: '',
        },
      ],
    });
  const remove = (idx: number) =>
    onChange({ ...value, buttons: buttons.filter((_, i) => i !== idx) });

  return (
    <div>
      <label className="text-muted-foreground mb-2 block text-xs">
        {t('buttonsCount', {
          count: buttons.length,
          max: INTERACTIVE_LIMITS.maxButtons,
        })}
      </label>
      <div className="flex flex-col gap-2">
        {buttons.map((b, i) => (
          <div
            key={i}
            className="border-border bg-muted/40 flex min-w-0 flex-col gap-2 rounded-md border p-2"
          >
            <div className="flex min-w-0 items-center gap-2">
              {advanced && (
                <Input
                  value={b.id}
                  onChange={(e) =>
                    update(i, { id: slugify(e.target.value, `btn_${i + 1}`) })
                  }
                  placeholder={t('idPlaceholder')}
                  className="bg-muted w-28 font-mono text-xs"
                />
              )}
              <Input
                value={b.title}
                maxLength={INTERACTIVE_LIMITS.buttonTitleMaxLength}
                onChange={(e) => update(i, { title: e.target.value })}
                placeholder={t('buttonLabelPlaceholder')}
                className="bg-muted flex-1"
              />
              <span className="text-muted-foreground w-10 shrink-0 text-right text-[10px]">
                {b.title.length}/{INTERACTIVE_LIMITS.buttonTitleMaxLength}
              </span>
              {buttons.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(i)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  aria-label={t('removeButton')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {advanced && (
              <>
                <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                  {t('buttonAction')}
                  <select
                    aria-label={t('buttonAction')}
                    value={b.action?.type ?? 'reply'}
                    className="border-input bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm"
                    onChange={(e) => {
                      const type = e.target.value;
                      update(i, {
                        action:
                          type === 'reply'
                            ? undefined
                            : type === 'url'
                              ? { type, url: '' }
                              : {
                                  type: type as 'automation' | 'flow',
                                  targetId: '',
                                },
                      });
                    }}
                  >
                    <option value="reply">{t('replyOnly')}</option>
                    <option value="url">{t('linkAction')}</option>
                    <option value="automation">
                      {t('existingAutomation')}
                    </option>
                    <option value="flow">{t('existingFlow')}</option>
                  </select>
                </label>
                {b.action?.type === 'url' && (
                  <Input
                    aria-label={t('buttonUrl')}
                    placeholder="https://example.com"
                    value={b.action.url}
                    onChange={(e) =>
                      update(i, {
                        action: { type: 'url', url: e.target.value },
                      })
                    }
                  />
                )}
                {(b.action?.type === 'automation' ||
                  b.action?.type === 'flow') &&
                  (() => {
                    const action = b.action;
                    const targets =
                      action.type === 'automation'
                        ? options.automations
                        : options.flows;
                    const unavailable =
                      action.targetId &&
                      !targets.some((target) => target.id === action.targetId);
                    return (
                      <>
                        <select
                          aria-label={t('selectTarget')}
                          value={action.targetId}
                          disabled={optionsState !== 'ready'}
                          className="border-input bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm"
                          onChange={(e) =>
                            update(i, {
                              action: {
                                type: action.type,
                                targetId: e.target.value,
                              },
                            })
                          }
                        >
                          <option value="">{t('selectTarget')}</option>
                          {unavailable && (
                            <option value={action.targetId}>
                              {optionsState === 'loading'
                                ? t('loadingTargets')
                                : t('unavailableTarget')}
                            </option>
                          )}
                          {targets.map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.name}
                            </option>
                          ))}
                        </select>
                        {optionsState === 'loading' && (
                          <p
                            role="status"
                            className="text-muted-foreground text-xs"
                          >
                            {t('loadingTargets')}
                          </p>
                        )}
                        {optionsState === 'error' && (
                          <div role="alert" className="text-xs text-red-400">
                            {t('targetsFailed')}{' '}
                            <button
                              type="button"
                              onClick={retry}
                              className="underline"
                            >
                              {t('retryTargets')}
                            </button>
                          </div>
                        )}
                        {optionsState === 'ready' && !targets.length && (
                          <p className="text-muted-foreground text-xs">
                            {t('noTargets')}
                          </p>
                        )}
                        {optionsState === 'ready' && unavailable && (
                          <p role="alert" className="text-xs text-red-400">
                            {t('unavailableTarget')}
                          </p>
                        )}
                      </>
                    );
                  })()}
              </>
            )}
          </div>
        ))}
      </div>
      {buttons.some((button) => button.action?.type === 'url') && (
        <p className="text-muted-foreground mt-2 text-xs">
          {t('urlButtonConstraint')}
        </p>
      )}
      {buttons.length < INTERACTIVE_LIMITS.maxButtons && (
        <Button variant="ghost" size="sm" onClick={add} className="mt-2">
          <Plus className="h-3.5 w-3.5" />
          {t('addButton')}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// List editor
// ------------------------------------------------------------

function ListEditor({
  value,
  onChange,
  advanced,
}: {
  value: InteractiveListPayload;
  onChange: (p: InteractiveMessagePayload) => void;
  advanced: boolean;
}) {
  const t = useTranslations('Interactive');
  const sections = value.sections;
  const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
  const allRowIds = () => sections.flatMap((s) => s.rows.map((r) => r.id));

  const updateSection = (
    sIdx: number,
    patch: Partial<InteractiveListPayload['sections'][number]>
  ) =>
    onChange({
      ...value,
      sections: sections.map((s, i) => (i === sIdx ? { ...s, ...patch } : s)),
    });
  const updateRow = (
    sIdx: number,
    rIdx: number,
    patch: Partial<InteractiveListPayload['sections'][number]['rows'][number]>
  ) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: s.rows.map((r, j) => (j === rIdx ? { ...r, ...patch } : r)),
            }
          : s
      ),
    });
  const addRow = (sIdx: number) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: [...s.rows, { id: nextId(allRowIds(), 'row_'), title: '' }],
            }
          : s
      ),
    });
  const removeRow = (sIdx: number, rIdx: number) =>
    onChange({
      ...value,
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, rows: s.rows.filter((_, j) => j !== rIdx) } : s
      ),
    });
  const addSection = () =>
    onChange({
      ...value,
      sections: [
        ...sections,
        { title: '', rows: [{ id: nextId(allRowIds(), 'row_'), title: '' }] },
      ],
    });
  const removeSection = (sIdx: number) =>
    onChange({ ...value, sections: sections.filter((_, i) => i !== sIdx) });

  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('listButtonLabel')}
        counter={`${value.button_label.length}/${INTERACTIVE_LIMITS.buttonTitleMaxLength}`}
      >
        <Input
          value={value.button_label}
          maxLength={INTERACTIVE_LIMITS.buttonTitleMaxLength}
          onChange={(e) => onChange({ ...value, button_label: e.target.value })}
          className="bg-muted text-foreground"
        />
      </Field>

      <label className="text-muted-foreground block text-xs">
        {t('rowsCount', {
          count: totalRows,
          max: INTERACTIVE_LIMITS.maxListRowsTotal,
        })}
      </label>

      {sections.map((section, sIdx) => (
        <div
          key={sIdx}
          className="border-border bg-muted/40 rounded-md border p-2"
        >
          <div className="mb-2 flex items-center gap-2">
            <Input
              value={section.title ?? ''}
              onChange={(e) => updateSection(sIdx, { title: e.target.value })}
              placeholder={t('sectionTitlePlaceholder')}
              className="bg-muted flex-1 text-xs"
            />
            {sections.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeSection(sIdx)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {section.rows.map((row, rIdx) => (
              <div
                key={rIdx}
                className="border-border bg-card rounded border p-2"
              >
                <div className="flex items-center gap-2">
                  {advanced && (
                    <Input
                      value={row.id}
                      onChange={(e) =>
                        updateRow(sIdx, rIdx, {
                          id: slugify(e.target.value, `row_${rIdx + 1}`),
                        })
                      }
                      placeholder={t('idPlaceholder')}
                      className="bg-muted w-24 font-mono text-xs"
                    />
                  )}
                  <Input
                    value={row.title}
                    maxLength={INTERACTIVE_LIMITS.listRowTitleMaxLength}
                    onChange={(e) =>
                      updateRow(sIdx, rIdx, { title: e.target.value })
                    }
                    placeholder={t('rowTitlePlaceholder')}
                    className="bg-muted flex-1"
                  />
                  <span className="text-muted-foreground w-10 shrink-0 text-right text-[10px]">
                    {row.title.length}/
                    {INTERACTIVE_LIMITS.listRowTitleMaxLength}
                  </span>
                  {totalRows > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(sIdx, rIdx)}
                      className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <Input
                  value={row.description ?? ''}
                  maxLength={INTERACTIVE_LIMITS.listRowDescriptionMaxLength}
                  onChange={(e) =>
                    updateRow(sIdx, rIdx, { description: e.target.value })
                  }
                  placeholder={t('rowDescriptionPlaceholder')}
                  className="bg-muted mt-2 text-xs"
                />
              </div>
            ))}
          </div>
          {totalRows < INTERACTIVE_LIMITS.maxListRowsTotal && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => addRow(sIdx)}
              className="mt-2"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('addRow')}
            </Button>
          )}
        </div>
      ))}

      {sections.length < INTERACTIVE_LIMITS.maxListSections &&
        totalRows < INTERACTIVE_LIMITS.maxListRowsTotal && (
          <Button variant="ghost" size="sm" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" />
            {t('addSection')}
          </Button>
        )}
    </div>
  );
}

// ------------------------------------------------------------
// Small presentational helpers
// ------------------------------------------------------------

function KindButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-muted text-muted-foreground hover:text-foreground'
      )}
    >
      {label}
    </button>
  );
}

function Field({
  label,
  counter,
  children,
}: {
  label: string;
  counter?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-muted-foreground text-xs">{label}</label>
        {counter && (
          <span className="text-muted-foreground text-[10px]">{counter}</span>
        )}
      </div>
      {children}
    </div>
  );
}
