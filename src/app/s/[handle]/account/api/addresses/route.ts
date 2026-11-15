// POST /s/<handle>/account/api/addresses
//   { action: 'save', id?, address: { name, phone, line1, line2, city, state, state_code, postal_code, country, instructions } }
//   { action: 'delete', id }
// The signed-in buyer's saved addresses in this shop (at most five). 200 { addresses }.
// 401 signed_out without a live session; another buyer's address id is not_found.

import { deleteAddressTx, saveAddressTx, withCustomer } from '@/lib/commerce/shop-customer';
import { StoreError } from '@/lib/commerce/store-settings';
import { customerPost, type HandleParams } from '../_lib/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return customerPost(request, context, 'addresses', (handle, body, token) => {
    if (body.action !== 'save' && body.action !== 'delete') throw new StoreError('invalid', { field: 'action' });
    return withCustomer(handle, token, async (tx, customer) => ({
      addresses: body.action === 'delete' ? await deleteAddressTx(tx, customer, body.id)
        : await saveAddressTx(tx, customer, { id: body.id, address: body.address }),
    }), { mutate: true });
  });
}
