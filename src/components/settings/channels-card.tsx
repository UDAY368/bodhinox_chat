'use client';

/**
 * Settings › Channels (Stage 1 channel separation): which channels the
 * workspace uses, each with its state and a link to connect or manage it.
 * Admins turn a channel on or off; everyone else sees it read-only.
 *
 * The rules live on the server (PUT /api/account/channels): a connected
 * channel cannot be turned off, one channel stays on, Instagram needs the
 * plan and the platform. The switches mirror them so the usual case never
 * reaches a refusal, and a refusal still shows the server's reason.
 */

import { useState } from 'react';
import Link from 'next/link';
import { AtSign, Loader2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useCan } from '@/hooks/use-can';
import { ChannelsSaveError, useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { CHANNELS } from '@/lib/channels/capabilities';
import { channelSettingsPath } from '@/lib/channels/routes';
import type { WorkspaceChannel, WorkspaceChannels } from '@/lib/channels/workspace';
import type { Channel } from '@/types';

const PLAN_PATH = '/settings?tab=plan';
const SERVER_CODES = new Set(['invalid_request', 'channel_connected', 'last_channel', 'plan_required', 'platform_off']);

/** Why a channel's switch cannot be flipped right now, or null when it can. */
export function switchBlock(channels: WorkspaceChannels, channel: Channel):
  'unavailable' | 'connected' | 'lastChannel' | null {
  const state = channels.channels[channel];
  if (!state.available) return 'unavailable';
  if (state.enabled && state.connection !== 'none') return 'connected';
  if (state.enabled && channels.enabled.length === 1) return 'lastChannel';
  return null;
}

export function ChannelsCard() {
  const t = useTranslations('Channels.settings');
  const tErrors = useTranslations('Channels.errors');
  const tNames = useTranslations('Channels.names');
  const tGate = useTranslations('ChannelGate');
  const canEdit = useCan('edit-settings');
  const { data, loading, error, refresh, save } = useWorkspaceChannels();
  const [saving, setSaving] = useState<Channel | null>(null);

  const toggle = async (channel: Channel, on: boolean) => {
    setSaving(channel);
    try {
      await save({ [channel]: on });
      toast.success(t('saved'));
    } catch (err) {
      const code = err instanceof ChannelsSaveError ? err.code : null;
      toast.error(code && SERVER_CODES.has(code)
        ? tErrors(code as 'channel_connected', { channel: tNames(channel) })
        : tErrors('saveFailed'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data && loading && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tGate('loading')} />}
        {!data && !loading && error && (
          <div className="flex items-center gap-3 text-sm">
            <p className="text-destructive">{tErrors('loadFailed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>{tGate('retry')}</Button>
          </div>
        )}
        {data && CHANNELS.map((channel) => (
          <ChannelRow key={channel} state={data.channels[channel]} block={switchBlock(data, channel)}
            canEdit={canEdit} busy={saving !== null} saving={saving === channel}
            onToggle={(on) => void toggle(channel, on)} />
        ))}
        {data && !canEdit && <p className="text-muted-foreground text-xs">{t('adminOnly')}</p>}
      </CardContent>
    </Card>
  );
}

function ChannelRow({ state, block, canEdit, busy, saving, onToggle }: {
  state: WorkspaceChannel;
  block: ReturnType<typeof switchBlock>;
  canEdit: boolean;
  busy: boolean;
  saving: boolean;
  onToggle: (on: boolean) => void;
}) {
  const t = useTranslations('Channels.settings');
  const tStates = useTranslations('Channels.states');
  const tNames = useTranslations('Channels.names');
  const tPicker = useTranslations('Channels.picker');
  const name = tNames(state.channel);
  const Icon = state.channel === 'instagram' ? AtSign : MessageCircle;

  const note = block === 'unavailable'
    ? (state.unavailableReason === 'plan' ? t('notIncluded') : t('notAvailableYet'))
    : canEdit && block === 'connected' ? t('disconnectFirst', { channel: name })
    : canEdit && block === 'lastChannel' ? t('lastChannel')
    : null;

  return (
    <div className="border-border flex flex-wrap items-center gap-3 rounded-lg border p-4" data-channel-row={state.channel}
      data-channel-state={state.state}>
      <span className="bg-primary-soft text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-sm font-semibold">{name}</span>
          <Badge variant={state.state === 'attention' ? 'destructive' : state.state === 'live' ? 'secondary' : 'outline'}>
            {tStates(state.state)}
          </Badge>
        </div>
        {note && <p className="text-muted-foreground mt-1 text-xs">{note}</p>}
      </div>
      {state.enabled && canEdit && (
        <Link href={channelSettingsPath(state.channel)}
          className={buttonVariants({ variant: state.state === 'setup' ? 'default' : 'outline', size: 'sm' })}>
          {state.state === 'setup' ? t('connect') : t('manage')}
        </Link>
      )}
      {block === 'unavailable' && state.unavailableReason === 'plan' && canEdit && (
        <Link href={PLAN_PATH} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{tPicker('upgrade')}</Link>
      )}
      <span className="flex items-center gap-2">
        {saving && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
        <Switch
          checked={state.enabled}
          disabled={!canEdit || busy || block !== null}
          onCheckedChange={(on: boolean) => onToggle(on)}
          aria-label={state.enabled ? t('turnOff', { channel: name }) : t('turnOn', { channel: name })}
        />
      </span>
    </div>
  );
}
