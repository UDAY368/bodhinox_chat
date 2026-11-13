'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ContactsHeader } from '@/components/contacts/contacts-header';
import { CustomFieldsTab } from '@/components/contacts/custom-fields-tab';
import { useCan } from '@/hooks/use-can';

// Contacts > Custom fields: the typed custom fields as a table (admins create, edit and delete).
export default function ContactFieldsPage() {
  const t = useTranslations('Contacts.redesign');
  const canEditSettings = useCan('edit-settings');
  const [creating, setCreating] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  return (
    <div className="min-w-0 space-y-5">
      <ContactsHeader
        tab="fields"
        known={{ fields: count }}
        actions={canEditSettings && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t('fieldsTab.newField')}
          </Button>
        )}
      />
      <CustomFieldsTab createOpen={creating} onCreateOpenChange={setCreating} onCount={setCount} />
    </div>
  );
}
