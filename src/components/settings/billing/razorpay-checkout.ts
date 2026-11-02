'use client';

// Razorpay Checkout for platform subscriptions. The script is loaded only when
// an admin subscribes. Its success callback changes nothing on our side: the
// plan changes when the provider's signed webhook confirms the authorisation.

const SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayOptions {
  key: string;
  subscription_id: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
  handler: () => void;
  modal: { ondismiss: () => void };
}
type RazorpayCtor = new (options: RazorpayOptions) => { open: () => void };

let loading: Promise<RazorpayCtor> | null = null;

function loadScript(): Promise<RazorpayCtor> {
  const existing = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      const ctor = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (ctor) resolve(ctor); else reject(new Error('Checkout unavailable'));
    };
    script.onerror = () => reject(new Error('Checkout unavailable'));
    document.head.appendChild(script);
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export interface CheckoutSession {
  subscription_id: string;
  short_url: string | null;
  key_id: string;
  prefill: { name: string; email: string };
}

export type CheckoutOutcome = 'authorised' | 'dismissed' | { redirect: string };

/**
 * Opens Checkout; resolves 'authorised' when the buyer finished, 'dismissed'
 * when they closed it, or `{ redirect }` with the provider's hosted page when
 * the script could not load. The caller shows that page as a link: opening a
 * tab here, after awaited requests, would be stopped by popup blockers.
 */
export async function openCheckout(session: CheckoutSession, text: { name: string; description: string }): Promise<CheckoutOutcome> {
  let Razorpay: RazorpayCtor;
  try {
    Razorpay = await loadScript();
  } catch {
    if (session.short_url && session.short_url.startsWith('https://')) return { redirect: session.short_url };
    throw new Error('Checkout unavailable');
  }
  return new Promise((resolve) => {
    new Razorpay({
      key: session.key_id,
      subscription_id: session.subscription_id,
      name: text.name,
      description: text.description,
      prefill: session.prefill,
      handler: () => resolve('authorised'),
      modal: { ondismiss: () => resolve('dismissed') },
    }).open();
  });
}
