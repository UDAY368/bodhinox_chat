'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Camera, MessageCircle, PlugZap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import { ChannelsSaveError, useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { channelSettingsPath } from '@/lib/channels/routes';
import type { WorkspaceChannel } from '@/lib/channels/workspace';
import type { Channel } from '@/types';

/**
 * The /whatsapp and /instagram section layouts (Stage 1). An `off` or
 * `unavailable` channel shows an explanation instead of the page, so a shared
 * link still says why it shows nothing (never a 404); an enabled channel
 * renders the page, with a slim banner while it is not connected (`setup`)
 * or needs attention.
 *
 * This is presentation only: every API enforces role, tenancy and the
 * channel rules itself. If the state cannot be loaded the page still renders.
 */
export function ChannelGate({ channel, children }: { channel: Channel; children: ReactNode }) {
  const { data, loading, error, refresh } = useWorkspaceChannels();
  const pathname = usePathname() ?? '';
  const t = useTranslations('ChannelGate');

  if (!data) {
    if (loading && !error)
      return <p className="text-muted-foreground p-6 text-sm" role="status">{t('loading')}</p>;
    // Fail open: the APIs behind the page refuse what the workspace cannot do.
    return <>{children}</>;
  }
  const state = data.channels[channel];
  if (state.state === 'off' || state.state === 'unavailable')
    return <ChannelOffState state={state} onRetry={error ? refresh : undefined} />;
  // The inbox and the full-screen flow editor place the banner inside their own layout.
  const ownBanner = pathname === `/${channel}/inbox` || new RegExp(`^/${channel}/flows/[^/]+$`).test(pathname);
  return (
    <>
      {!ownBanner && <ChannelStatusBanner state={state} />}
      {children}
    </>
  );
}

/** The empty state for a channel that is turned off or not available. */
export function ChannelOffState({ state, onRetry }: { state: WorkspaceChannel; onRetry?: () => void }) {
  const t = useTranslations('ChannelGate');
  const tNames = useTranslations('Channels.names');
  const tErrors = useTranslations('Channels.errors');
  const canEdit = useCan('edit-settings');
  const { save } = useWorkspaceChannels();
  const [saving, setSaving] = useState(false);
  const name = tNames(state.channel);
  const Icon = state.channel === 'instagram' ? Camera : MessageCircle;

  const turnOn = async () => {
    setSaving(true);
    try {
      await save({ [state.channel]: true });
    } catch (error) {
      toast.error(error instanceof ChannelsSaveError && error.message ? error.message : tErrors('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const title = state.state === 'unavailable'
    ? t(state.unavailableReason === 'plan' ? 'unavailablePlanTitle' : 'unavailablePlatformTitle', { channel: name })
    : t('offTitle', { channel: name });

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center" data-channel-gate={state.state}>
      <Icon className="text-muted-foreground h-10 w-10" aria-hidden />
      <h1 className="text-lg font-semibold">{title}</h1>
      {state.state === 'off' && (
        <>
          <p className="text-muted-foreground text-sm">{canEdit ? t('offBodyAdmin') : t('offBodyMember')}</p>
          {canEdit ? (
            <Button onClick={turnOn} disabled={saving}>{t('turnOn', { channel: name })}</Button>
          ) : (
            <p className="text-sm font-medium">{t('askAdmin')}</p>
          )}
        </>
      )}
      {state.state === 'unavailable' && state.unavailableReason === 'plan' && canEdit && (
        <Link href="/settings?tab=plan" className="text-primary text-sm font-medium underline-offset-2 hover:underline">
          {t('seePlans')}
        </Link>
      )}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>
      )}
    </div>
  );
}

/** The slim banner for an enabled channel that is not connected yet or needs attention; nothing otherwise. */
export function ChannelStatusBanner({ state }: { state: WorkspaceChannel }) {
  const t = useTranslations('ChannelGate');
  const canEdit = useCan('edit-settings');
  if (state.state !== 'setup' && state.state !== 'attention') return null;
  const setup = state.state === 'setup';
  const instagram = state.channel === 'instagram';
  const message = setup
    ? t(instagram ? 'setupInstagram' : 'setupWhatsapp')
    : t(instagram ? 'attentionInstagram' : 'attentionWhatsapp');
  const Icon = setup ? PlugZap : AlertTriangle;
  return (
    <div
      data-channel-banner={state.state}
      className="mb-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400"
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <p>{message}</p>
      {setup && instagram && <p className="basis-full text-center">{t('instagramRoutingHint')}</p>}
      {canEdit ? (
        <Link href={channelSettingsPath(state.channel)} className="font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-300">
          {setup ? t('connect') : t('fix')}
        </Link>
      ) : (
        <span className="font-medium">{t('askAdmin')}</span>
      )}
    </div>
  );
}
