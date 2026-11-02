'use client';

// The workspace's WhatsApp numbers for pickers, the inbox and settings. Reads
// GET /api/whatsapp/numbers, which any member may call and which never carries
// tokens. Mounted components share one in-flight request and its result until
// reload() is called, so the inbox list, thread header and filters do not each
// fetch it. The shared result is reused for 30 seconds at most.

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/auth/client';
import type { WhatsAppNumberDto } from '@/lib/whatsapp/number-admin';

export type { WhatsAppNumberDto };

const SHARE_MS = 30_000;
let cached: Promise<WhatsAppNumberDto[]> | null = null;
let cachedAt = 0;
const listeners = new Set<(numbers: WhatsAppNumberDto[]) => void>();

async function fetchNumbers(): Promise<WhatsAppNumberDto[]> {
  const res = await authFetch('/api/whatsapp/numbers', { cache: 'no-store' });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { numbers?: WhatsAppNumberDto[] } | null;
  return Array.isArray(body?.numbers) ? body.numbers : [];
}

function load(force: boolean): Promise<WhatsAppNumberDto[]> {
  if (force || !cached || Date.now() - cachedAt > SHARE_MS) {
    const request = fetchNumbers().catch(() => [] as WhatsAppNumberDto[]);
    cached = request;
    cachedAt = Date.now();
    void request.then((numbers) => {
      if (cached === request) listeners.forEach((notify) => notify(numbers));
    });
  }
  return cached;
}

export function useWhatsAppNumbers(): {
  numbers: WhatsAppNumberDto[];
  loading: boolean;
  reload: () => Promise<WhatsAppNumberDto[]>;
} {
  const [numbers, setNumbers] = useState<WhatsAppNumberDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const update = (next: WhatsAppNumberDto[]) => {
      if (!live) return;
      setNumbers(next);
      setLoading(false);
    };
    listeners.add(update);
    void load(false).then(update);
    return () => {
      live = false;
      listeners.delete(update);
    };
  }, []);

  const reload = useCallback(() => load(true), []);
  return { numbers, loading, reload };
}

/** A number's label: its display name, else "Number <phone_number_id>". */
export function numberLabel(
  n: Pick<WhatsAppNumberDto, 'display_name' | 'phone_number_id'>,
  t: (key: 'unnamedNumber', values: { phoneNumberId: string }) => string
): string {
  return n.display_name?.trim() || t('unnamedNumber', { phoneNumberId: n.phone_number_id });
}
