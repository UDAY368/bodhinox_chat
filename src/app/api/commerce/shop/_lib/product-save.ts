/**
 * The product form's one Save (POST /products, PATCH /products/[id]): the
 * product, photos, variants and bundle parts in one app-role transaction, then
 * the typed stock counts in one worker transaction. When the stock step is
 * refused (for example the count moved meanwhile) the product is still saved;
 * the response says so with `stock_error` and carries the product as it is now.
 */
import { ForbiddenError } from '@/lib/auth/errors';
import { setStockLevels } from '@/lib/commerce/catalogue/inventory';
import { saveProductForm } from '@/lib/commerce/catalogue/product-form';
import { CatalogueError, getShopProduct, type ShopProduct } from '@/lib/commerce/catalogue/products';
import { inTenant, type StaffCaller } from './http';

export async function saveProduct(caller: StaffCaller, id: string | null, body: unknown): Promise<{ product: ShopProduct; stock_error?: string }> {
  const saved = await inTenant(caller, (tx) => saveProductForm(tx, caller.accountId, caller.userId, id, body));
  if (!saved.stock.length) return { product: saved.product };
  let stockError: string | undefined;
  try {
    await setStockLevels(caller.tenant, saved.stock);
  } catch (error) {
    if (error instanceof CatalogueError) stockError = error.code;
    else if (error instanceof ForbiddenError) stockError = 'forbidden';
    else throw error;
  }
  const product = await inTenant(caller, (tx) => getShopProduct(tx, caller.accountId, saved.product.id));
  return stockError ? { product, stock_error: stockError } : { product };
}
