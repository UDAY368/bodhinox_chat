// Browser shapes of the /api/billing/* responses.

import type { SubscriptionStatus } from '@/lib/billing/entitlements-catalogue';

export type Interval = 'month' | 'year';

export interface SubscriptionView {
  plan: string;
  planName: string;
  status: SubscriptionStatus;
  interval: Interval | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: string | null;
  graceEndsAt: string | null;
  suspendedAt: string | null;
  managed: boolean;
}

export interface PendingChange {
  kind: 'checkout' | 'change_plan' | 'cancel';
  status: 'pending' | 'unknown' | 'created';
  plan: string | null;
  interval: Interval | null;
}

export interface BillingOverview {
  configured: boolean;
  can_manage: boolean;
  subscription: SubscriptionView | null;
  pending: PendingChange[];
}

export interface PlanPrice {
  plan: string;
  interval: Interval;
  currency: string;
  amountMinor: number;
}

export interface BillingProfileView {
  legalName: string;
  gstin: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string | null;
  postalCode: string;
  country: string;
  email: string;
}

export interface InvoiceRow {
  id: string;
  number: string;
  issuedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  totalMinor: number;
  status: 'issued' | 'paid' | 'void';
}

/** ₹1,234.50 from paise. */
export function formatAmount(minor: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
}

export function formatDay(iso: string | null, locale?: string): string {
  return iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}
