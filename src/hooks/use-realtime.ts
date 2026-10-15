'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { createClient } from '@/lib/data/client';
import type { Message, Conversation } from '@/types';
import type { RealtimeChannel } from '@/lib/data/types';

interface RealtimeEvent<T> {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  onResync?: () => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  onResync,
  enabled = true,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  const onResyncRef = useRef(onResync);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
    onResyncRef.current = onResync;
  });

  useEffect(() => {
    if (!enabled) return;

    const db = createClient();

    const channel = db
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Message>['eventType'],
            new: payload.new as unknown as Message,
            old: payload.old as Partial<Message>,
          });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (payload) => {
          onConversationRef.current?.({
            eventType:
              payload.eventType as RealtimeEvent<Conversation>['eventType'],
            new: payload.new as unknown as Conversation,
            old: payload.old as Partial<Conversation>,
          });
        }
      )
      .onResync(() => onResyncRef.current?.())
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    channelRef.current = channel;

    return () => {
      db.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const db = createClient();
      db.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
