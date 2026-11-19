"use client";

/**
 * Commerce → Settings → Marketing (store plan Phase 8, batch 6): email and order-confirmation settings, email campaigns, referrals and
 * affiliates, and the link-in-bio page. Admins edit; agents read (every API and its table enforce the same rule).
 */
import { useState } from "react";
import type { MarketingSettings } from "@/lib/commerce/marketing-settings";
import { EmailCampaignsCard } from "./email-campaigns-card";
import { LinkPageCard } from "./link-page-card";
import { MarketingSettingsCard } from "./marketing-settings-card";
import { ReferralsCard } from "./referrals-card";

export function MarketingPanel({ canEdit, currency }: { canEdit: boolean; currency: string }) {
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <>
      <MarketingSettingsCard canEdit={canEdit} currency={currency} onChanged={(s: MarketingSettings) => { setConnected(s.email_connected); setVersion((n) => n + 1); }} />
      <EmailCampaignsCard canEdit={canEdit} connected={connected} />
      <ReferralsCard canEdit={canEdit} refreshKey={version} />
      <LinkPageCard canEdit={canEdit} />
    </>
  );
}
