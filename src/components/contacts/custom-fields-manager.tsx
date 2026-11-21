'use client';

// Settings > Custom fields: the same typed custom fields as Contacts > Custom
// fields (custom-fields-tab.tsx), as settings rows. Admins add a field from the
// last row, and edit or delete one from its more menu (the same field sheet and
// /api/custom-fields calls); other members see the rows read-only.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { PageLoading } from '@/components/ui/page-loading';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { SettingsBlock, SettingsMoreMenu } from '@/components/settings/settings-row';
import { useCan } from '@/hooks/use-can';
import { useCustomFields, type CustomFieldSummary } from './contacts-client';
import { FieldDialog, deleteField, deleteFieldWarning } from './custom-fields-tab';

/** Rows for a SettingsGroup: one per field, then "New field" for admins. */
export function CustomFieldsPanel() {
  const t = useTranslations('Contacts.redesign');
  const confirm = useConfirm();
  const canEdit = useCan('edit-settings');
  const { fields, loading, reload } = useCustomFields();
  const [sheet, setSheet] = useState<{ field: CustomFieldSummary | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const typeName = (field: CustomFieldSummary) => t(`fieldsTab.types.${field.field_type}`);

  async function remove(field: CustomFieldSummary) {
    const ok = await confirm({
      title: t('fieldsTab.deleteTitle', { name: field.field_name }),
      body: deleteFieldWarning(field, t),
      confirmLabel: t('fieldsTab.delete'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    const deleted = await deleteField(field, t);
    setBusy(false);
    if (deleted) await reload();
  }

  if (loading) return <SettingsBlock><PageLoading rows={3} /></SettingsBlock>;

  return (
    <>
      {fields.length === 0 && (
        <GroupedListRow title={<span className="text-muted-foreground">{t('fieldsTab.emptyTitle')}</span>} />
      )}
      {fields.map((f) => (
        <GroupedListRow
          key={f.id}
          title={<span className="font-medium">{f.field_name}</span>}
          subtitle={[
            typeName(f),
            f.field_type === 'choice' ? f.choices.join(', ') : null,
            t('fieldsTab.contacts', { count: f.filled }),
          ].filter(Boolean).join(' · ')}
          trailing={canEdit ? (
            <SettingsMoreMenu
              label={t('fieldsTab.moreFor', { name: f.field_name })}
              actions={[
                { label: t('fieldsTab.edit'), icon: Pencil, disabled: busy, onSelect: () => setSheet({ field: f }) },
                { label: t('fieldsTab.delete'), icon: Trash2, destructive: true, disabled: busy, onSelect: () => void remove(f) },
              ]}
            />
          ) : undefined}
          className="py-1.5"
        />
      ))}
      {canEdit && (
        <GroupedListRow
          leading={<Plus className="size-4 text-primary" aria-hidden />}
          title={<span className="text-primary">{t('fieldsTab.newField')}</span>}
          onClick={() => setSheet({ field: null })}
        />
      )}
      {sheet && (
        <FieldDialog
          field={sheet.field}
          onClose={() => setSheet(null)}
          onSaved={async () => {
            setSheet(null);
            await reload();
          }}
        />
      )}
    </>
  );
}
