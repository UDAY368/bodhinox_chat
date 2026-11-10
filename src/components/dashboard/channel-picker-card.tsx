'use client';

/**
 * "Which channels do you use?" (Stage 1 onboarding). Shown on the dashboard
 * while the workspace has never picked channels (no workspace_channels row)
 * and has no WhatsApp number or Instagram account attached, so long-standing
 * WhatsApp workspaces never see it. An admin picks WhatsApp, Instagram or
 * both; the choice is written through PUT /api/account/channels, which
 * enforces the plan and platform gates. Everyone else sees that the admin has
 * not picked yet. Settings › Channels changes the choice later.
 */

import { useState } from 'react';
import Link from 'next/link';
import { AtSign, Layers, Loader2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan } from '@/hooks/use-can';
import { ChannelsSaveError, useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import type { ChannelChanges, WorkspaceChannels } from '@/lib/channels/workspace';
import { cn } from '@/lib/utils';
import type { Channel } from '@/types';

export type ChannelChoice = 'whatsapp' | 'instagram' | 'both';

export const CHOICES: Record<ChannelChoice, ChannelChanges> = {
  whatsapp: { whatsapp: true, instagram: false },
  instagram: { whatsapp: false, instagram: true },
  both: { whatsapp: true, instagram: true },
};

/** The picker shows while no channel was ever chosen and nothing is connected. */
export function showChannelPicker(channels: WorkspaceChannels | null): boolean {
  if (!channels || channels.chosen) return false;
  return Object.values(channels.channels).every((channel) => channel.connection === 'none');
}

/**
 * The channel a refused choice is about: channel_connected names the channel
 * the choice turns off (the other one); plan and platform refusals are Instagram's.
 */
export function refusedChannel(choice: ChannelChoice, code: string | null): Channel {
  if (code === 'channel_connected') return choice === 'instagram' ? 'whatsapp' : 'instagram';
  return 'instagram';
}

const PLAN_PATH = '/settings?tab=plan';
const SERVER_CODES = new Set(['invalid_request', 'channel_connected', 'last_channel', 'plan_required', 'platform_off']);

export function ChannelPickerCard() {
  const t = useTranslations('Channels.picker');
  const tErrors = useTranslations('Channels.errors');
  const tNames = useTranslations('Channels.names');
  const canEdit = useCan('edit-settings');
  const { data, save } = useWorkspaceChannels();
  const [saving, setSaving] = useState<ChannelChoice | null>(null);

  if (!data || !showChannelPicker(data)) return null;
  const instagram = data.channels.instagram;
  const instagramBlocked = instagram.available ? null : instagram.unavailableReason;

  const choose = async (choice: ChannelChoice) => {
    setSaving(choice);
    try {
      await save(CHOICES[choice]);
    } catch (err) {
      const code = err instanceof ChannelsSaveError ? err.code : null;
      toast.error(code && SERVER_CODES.has(code)
        ? tErrors(code as 'plan_required', { channel: tNames(refusedChannel(choice, code)) })
        : tErrors('saveFailed'));
      setSaving(null);
    }
  };

  const options: { choice: ChannelChoice; icon: typeof MessageCircle; title: string; description: string }[] = [
    { choice: 'whatsapp', icon: MessageCircle, title: t('whatsappTitle'), description: t('whatsappDescription') },
    { choice: 'instagram', icon: AtSign, title: t('instagramTitle'), description: t('instagramDescription') },
    { choice: 'both', icon: Layers, title: t('bothTitle'), description: t('bothDescription') },
  ];

  return (
    <Card data-testid="channel-picker">
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </CardHeader>
      <CardContent>
        {!canEdit ? (
          <p className="text-muted-foreground text-sm">{t('waitingForAdmin')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {options.map(({ choice, icon: Icon, title, description }) => {
              const blocked = choice !== 'whatsapp' ? instagramBlocked : null;
              return (
                <div key={choice} data-channel-choice={choice}
                  className={cn('border-border flex flex-col gap-2 rounded-xl border p-4', blocked && 'opacity-70')}>
                  <span className="bg-primary-soft text-primary flex size-9 items-center justify-center rounded-lg">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="text-foreground text-sm font-semibold">{title}</span>
                  <span className="text-muted-foreground flex-1 text-xs">{description}</span>
                  {blocked === 'platform_off' ? (
                    <span className="text-muted-foreground text-xs font-medium">{t('comingSoon')}</span>
                  ) : blocked === 'plan' ? (
                    <Link href={PLAN_PATH} className="text-primary text-xs font-medium underline-offset-2 hover:underline">
                      {t('upgrade')}
                    </Link>
                  ) : (
                    <Button type="button" size="sm" disabled={saving !== null} onClick={() => void choose(choice)}>
                      {saving === choice && <Loader2 className="size-3.5 animate-spin" />}
                      {saving === choice ? t('saving') : t('choose')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
