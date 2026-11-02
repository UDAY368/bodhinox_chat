'use client';

// GST billing profile: who invoices are addressed to. Admins only; the server
// validates the GSTIN checksum and that it matches the state.

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth/client';
import type { BillingProfileView } from './types';

type Form = Record<'legal_name' | 'gstin' | 'address_line1' | 'address_line2' | 'city' | 'state_code' | 'postal_code' | 'country' | 'email', string>;

const toForm = (p: BillingProfileView | null): Form => ({
  legal_name: p?.legalName ?? '', gstin: p?.gstin ?? '', address_line1: p?.addressLine1 ?? '', address_line2: p?.addressLine2 ?? '',
  city: p?.city ?? '', state_code: p?.stateCode ?? '', postal_code: p?.postalCode ?? '', country: p?.country ?? 'IN', email: p?.email ?? '',
});

export function BillingProfileForm({ profile, onSaved }: { profile: BillingProfileView | null; onSaved: (p: BillingProfileView) => void }) {
  const t = useTranslations('Billing.profile');
  const [form, setForm] = useState<Form>(() => toForm(profile));
  const [saving, setSaving] = useState(false);
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await authFetch('/api/billing/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, gstin: form.gstin.trim() || null, address_line2: form.address_line2.trim() || null,
          state_code: form.state_code.trim() || null, country: form.country.trim().toUpperCase() || 'IN' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('saveFailed'));
      onSaved(json.profile);
      setForm(toForm(json.profile));
      toast.success(t('saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof Form, opts: { required?: boolean; maxLength: number; type?: string; className?: string; autoComplete?: string }) => (
    <div className={`space-y-1.5 ${opts.className ?? ''}`}>
      <Label htmlFor={`billing-${key}`}>{t(`fields.${key}`)}</Label>
      <Input id={`billing-${key}`} value={form[key]} onChange={set(key)} required={opts.required} maxLength={opts.maxLength}
        type={opts.type ?? 'text'} autoComplete={opts.autoComplete} />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          {field('legal_name', { required: true, maxLength: 200, className: 'sm:col-span-2', autoComplete: 'organization' })}
          {field('gstin', { maxLength: 15 })}
          {field('email', { required: true, maxLength: 254, type: 'email', autoComplete: 'email' })}
          {field('address_line1', { required: true, maxLength: 200, className: 'sm:col-span-2', autoComplete: 'address-line1' })}
          {field('address_line2', { maxLength: 200, className: 'sm:col-span-2', autoComplete: 'address-line2' })}
          {field('city', { required: true, maxLength: 100, autoComplete: 'address-level2' })}
          {field('postal_code', { required: true, maxLength: 20, autoComplete: 'postal-code' })}
          {field('state_code', { maxLength: 2 })}
          {field('country', { required: true, maxLength: 2, autoComplete: 'country' })}
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('stateHint')}</p>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="size-4 animate-spin" />}{t('save')}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
