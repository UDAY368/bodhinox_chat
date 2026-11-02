// The account's forms as the flow validator sees them: status and the
// field ids a send_form step stores as variables.

import type { TenantTransaction } from '@/lib/db/tenant';
import type { FlowFormLookup } from '@/lib/flows/validate';
import { normaliseFormDefinition } from './definition';
import { formInputFields } from './flow-json';

export async function loadFlowFormLookup(tx: TenantTransaction, accountId: string): Promise<FlowFormLookup> {
  const rows = await tx.$queryRaw<{ id: string; status: string; definition: unknown }[]>`SELECT id,status,definition
    FROM whatsapp_forms WHERE account_id=${accountId}::uuid`;
  return new Map(rows.map((row) => [row.id, {
    status: row.status,
    fields: formInputFields(normaliseFormDefinition(row.definition)).map((field) => field.id),
  }]));
}
