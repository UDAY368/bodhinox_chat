'use client';

import { useState } from 'react';
import { requestBroadcastCreation, type VariableMapping } from '@/lib/broadcast-create';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { MessageTemplate } from '@/types';
import type { CampaignSendExtras } from '@/lib/whatsapp/template-send-params';
export type { AudienceConfig, CustomFieldFilter, CustomFieldOperator } from '@/lib/broadcast-audience';
export type { VariableMapping } from '@/lib/broadcast-create';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
  /** ISO time to send later; omitted sends now. */
  scheduledAt?: string;
  /** Destination of a click-tracked link button. */
  trackedUrl?: string;
  /** Location, offer end and coupon code for templates that need them. */
  sendExtras?: CampaignSendExtras;
  /** The number to send from; omitted uses the workspace default. */
  whatsappConfigId?: string | null;
  /** One id per wizard session, so a retry or double submit returns the campaign already created. */
  clientRequestId?: string;
}

export function useBroadcastSending() {
  const [isProcessing, setIsProcessing] = useState(false);
  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    try {
      const id = await requestBroadcastCreation({
        name: payload.name,
        templateId: payload.template.id,
        audience: payload.audience,
        variables: payload.variables,
        headerMediaUrl: payload.headerMediaUrl,
        scheduledAt: payload.scheduledAt,
        trackedUrl: payload.trackedUrl,
        ...(payload.sendExtras && Object.keys(payload.sendExtras).length ? { sendExtras: payload.sendExtras } : {}),
        ...(payload.whatsappConfigId ? { whatsappConfigId: payload.whatsappConfigId } : {}),
        ...(payload.clientRequestId ? { clientRequestId: payload.clientRequestId } : {}),
      });
      return id;
    } finally {
      setIsProcessing(false);
    }
  }
  return { createAndSendBroadcast, isProcessing };
}
