import { cache } from 'react';
import { loadShopGate, loadShopOnly } from '@/lib/commerce/public-shop';

/** One shop read per request, shared by the layout, metadata and pages. */
export const getShop = cache((handle: string) => loadShopOnly(handle));

/** The shop or its lock screen (password / coming soon), once per request. */
export const getShopGate = cache((handle: string) => loadShopGate(handle));
