'use client';

// "Started from ad" badge in the conversation header. Reads the stored
// referral (no Meta call); shows nothing when the conversation did not start
// from an ad or post, or when the lookup fails.
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Megaphone } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { authFetch } from '@/lib/auth/client';

export interface AdReferralView {
  headline: string | null;
  source_url: string | null;
  source_type: 'ad' | 'post' | 'unknown';
  created_at: string;
}

/** Only plain web links become clickable. */
const safeUrl = (url: string | null): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
};

export function AdReferralBadgeView({ referral }: { referral: AdReferralView }) {
  const t = useTranslations('Inbox.adReferral');
  const label = referral.source_type === 'post'
    ? t('startedFromPost')
    : referral.headline
      ? t('startedFromAd', { headline: referral.headline })
      : t('startedFromAdNoHeadline');
  const href = safeUrl(referral.source_url);
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
      <Badge variant="outline" className="border-border text-muted-foreground max-w-[16rem] gap-1 text-[10px]" title={label}>
        <Megaphone className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </Badge>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary shrink-0 text-[10px] hover:underline">
          {t('viewAd')}
        </a>
      ) : null}
    </span>
  );
}

export function AdReferralBadge({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<{ id: string; referral: AdReferralView | null } | null>(null);

  useEffect(() => {
    let current = true;
    authFetch(`/api/conversations/${encodeURIComponent(conversationId)}/ad-referral`)
      .then(async (res) => {
        const body = res.ok ? ((await res.json().catch(() => null)) as { referral?: AdReferralView | null } | null) : null;
        if (current) setState({ id: conversationId, referral: body?.referral ?? null });
      })
      .catch(() => {
        if (current) setState({ id: conversationId, referral: null });
      });
    return () => {
      current = false;
    };
  }, [conversationId]);

  // A stale answer for the previous conversation is never shown.
  if (!state || state.id !== conversationId || !state.referral) return null;
  return <AdReferralBadgeView referral={state.referral} />;
}
