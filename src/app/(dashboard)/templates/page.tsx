'use client';

// Campaigns > Templates (Campaigns redesign): the WhatsApp template manager as
// a Campaigns tab, next to Broadcasts, Ads and Forms. It is the one templates
// screen: /settings?tab=templates redirects here (next.config.ts).

import { TemplateManager } from '@/components/settings/template-manager';

export default function TemplatesPage() {
  return <TemplateManager variant="campaigns" />;
}
