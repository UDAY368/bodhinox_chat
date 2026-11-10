import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: null }) }));

import { aiAccountStatus, autoReplyOnFor } from './ai-thread-banner';

const config = (patch: Record<string, unknown> = {}) => ({
  configured: true, is_active: true, auto_reply_enabled: false, instagram_auto_reply_enabled: false, ...patch,
});

describe('the AI banner follows the conversation channel switch', () => {
  it('an Instagram thread uses the Instagram switch, never the WhatsApp one', () => {
    const whatsappOnly = aiAccountStatus(config({ auto_reply_enabled: true }));
    expect(autoReplyOnFor(whatsappOnly, 'instagram')).toBe(false);
    expect(autoReplyOnFor(whatsappOnly, 'whatsapp')).toBe(true);
    const instagramOnly = aiAccountStatus(config({ instagram_auto_reply_enabled: true }));
    expect(autoReplyOnFor(instagramOnly, 'instagram')).toBe(true);
    expect(autoReplyOnFor(instagramOnly, 'whatsapp')).toBe(false);
  });

  it('treats a legacy conversation without a channel as WhatsApp', () => {
    const status = aiAccountStatus(config({ auto_reply_enabled: true }));
    expect(autoReplyOnFor(status, null)).toBe(true);
    expect(autoReplyOnFor(status, undefined)).toBe(true);
  });

  it('is off on every channel without a configured, active assistant or an older response', () => {
    for (const json of [config({ configured: false, auto_reply_enabled: true, instagram_auto_reply_enabled: true }),
      config({ is_active: false, auto_reply_enabled: true, instagram_auto_reply_enabled: true }),
      { configured: true, is_active: true, auto_reply_enabled: true }, null]) {
      const status = aiAccountStatus(json);
      expect(autoReplyOnFor(status, 'instagram')).toBe(false);
    }
  });
});
