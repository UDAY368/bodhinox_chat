'use client';

/**
 * Browser side of Web Push: register /sw.js, subscribe this browser with the
 * server's VAPID key and hand the subscription to the API. The alert text is
 * passed to the service worker in its URL so it is shown in the member's
 * language (the push itself carries nothing).
 */
import { authFetch } from '@/lib/auth/client';

export const PUSH_ENDPOINT = '/api/notifications/push-subscriptions';

export interface PushStatus {
  available: boolean;
  public_key: string | null;
  devices: number;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Whether a subscription's application server key is this key (an unknown key counts as the same). */
function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}

async function registration(labels: { title: string; body: string }): Promise<ServiceWorkerRegistration> {
  const url = `/sw.js?${new URLSearchParams({ title: labels.title, body: labels.body }).toString()}`;
  return navigator.serviceWorker.register(url, { scope: '/' });
}

/** This browser's current push subscription, if any. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export type EnablePushResult = 'enabled' | 'denied' | 'unsupported' | 'failed';

/** Ask for permission, subscribe and register this browser with the server. */
export async function enablePush(publicKey: string, labels: { title: string; body: string }): Promise<EnablePushResult> {
  if (!pushSupported()) return 'unsupported';
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  try {
    const reg = await registration(labels);
    await navigator.serviceWorker.ready;
    const serverKey = keyBytes(publicKey);
    let existing = await reg.pushManager.getSubscription();
    // A subscription made with an older VAPID key would be refused by the push service: replace it.
    if (existing && !sameKey(existing.options.applicationServerKey, serverKey)) {
      await existing.unsubscribe().catch(() => false);
      existing = null;
    }
    const subscription = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
    const response = await authFetch(PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
    return response.ok ? 'enabled' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Forget this browser on the server and unsubscribe it. */
export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await authFetch(PUSH_ENDPOINT, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => false);
}
