'use client';

// Campaigns > Templates (Campaigns redesign): the WhatsApp template manager as
// a Campaigns tab, next to Broadcasts, Ads and Forms. Settings > Templates
// keeps rendering the same manager, so older links still work.

import { TemplateManager } from '@/components/settings/template-manager';

export default function TemplatesPage() {
  return <TemplateManager variant="campaigns" />;
}
