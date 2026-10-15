'use client';

import { useState } from 'react';
import { requestBroadcastCreation, type VariableMapping } from '@/lib/broadcast-create';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import type { MessageTemplate } from '@/types';
export type { AudienceConfig, CustomFieldFilter, CustomFieldOperator } from '@/lib/broadcast-audience';
export type { VariableMapping } from '@/lib/broadcast-create';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

export function useBroadcastSending() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(10);
    try {
      const id = await requestBroadcastCreation({
        name: payload.name,
        templateId: payload.template.id,
        audience: payload.audience,
        variables: payload.variables,
        headerMediaUrl: payload.headerMediaUrl,
      });
      setProgress(100);
      return id;
    } finally {
      setIsProcessing(false);
    }
  }
  return { createAndSendBroadcast, isProcessing, progress };
}
