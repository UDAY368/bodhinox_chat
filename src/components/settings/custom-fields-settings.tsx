'use client';

import { Shield, SlidersHorizontal } from 'lucide-react';

import { useTranslations } from 'next-intl';
import { CustomFieldsPanel } from '@/components/contacts/custom-fields-manager';
import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-row';

/**
 * Settings → Custom Fields card. Manages the account-wide custom
 * contact field catalogue as rows (the same fields the Contacts page
 * shows as a table). Writes are admin-gated by the caller and enforced by
 * `custom_fields` RLS.
 */
export function CustomFieldsSettings() {
  const t = useTranslations('Settings.tagsAndFields');
  
  return (
    <SettingsGroup title={<><SlidersHorizontal className="size-4 text-primary" />
          {t('fieldsTitle')}
          <SettingsChip variant="admin" className="font-medium">
            <Shield />
            {t('adminRole')}
          </SettingsChip></>} footer={t('fieldsDesc')}>
      <CustomFieldsPanel />
    </SettingsGroup>
  );
}
