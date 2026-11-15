import { cache } from 'react';
import { loadShopOnly } from '@/lib/commerce/public-shop';

/** One shop read per request, shared by the layout, metadata and pages. */
export const getShop = cache((handle: string) => loadShopOnly(handle));
