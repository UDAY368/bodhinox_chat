import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';
import { assertMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { normalizePhone, isValidE164 } from '@/lib/whatsapp/phone-utils';

export const CAMPAIGN_LIMITS={bodyBytes:1024*1024,recipients:1000,tags:100,variables:50,frozenBytes:2*1024*1024} as const;
const mapping=z.discriminatedUnion('type',[
  z.object({type:z.literal('static'),value:z.string().max(1024)}).strict(),
  z.object({type:z.literal('field'),value:z.enum(['name','phone','email','company'])}).strict(),
  z.object({type:z.literal('custom_field'),value:z.string().uuid()}).strict(),
]);
const audienceSchema=z.object({
  type:z.enum(['all','tags','custom_field','csv']),
  tagIds:z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.tags).optional(),
  excludeTagIds:z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.tags).optional(),
  customField:z.object({fieldId:z.string().uuid(),operator:z.enum(['is','is_not','contains']),value:z.string().max(1024)}).strict().optional(),
  csvContacts:z.array(z.object({phone:z.string().min(1).max(64),name:z.string().max(256).optional()}).strict()).max(CAMPAIGN_LIMITS.recipients).optional(),
}).strict().superRefine((a,ctx)=>{
  if((a.type==='tags'&&!a.tagIds?.length)||(a.type==='custom_field'&&!a.customField)||(a.type==='csv'&&!a.csvContacts?.length))
    ctx.addIssue({code:'custom',message:'Audience configuration is incomplete'});
});
const inputSchema=z.object({
  name:z.string().trim().min(1).max(200),templateId:z.string().uuid(),audience:audienceSchema,
  variables:z.record(z.string().regex(/^[1-9]\d?$/),mapping),headerMediaUrl:z.string().trim().min(1).max(2048).optional(),
}).strict();
export type CampaignInput=z.infer<typeof inputSchema>;
type ContactRow={id:string;phone:string;name:string|null;email:string|null;company:string|null};
function invalid(message:string):never{throw new AuthError(message,400,'campaign_input');}
const jsonIds=(ids:string[])=>Prisma.sql`SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)`;

async function assertOwnedIds(tx:TenantTransaction,accountId:string,kind:'tags'|'custom_fields',ids:string[]){
  const unique=[...new Set(ids)];if(!unique.length)return;
  // Identifiers are fixed enum values; only values become SQL parameters.
  const table=kind==='tags'?Prisma.sql`tags`:Prisma.sql`custom_fields`;
  const found=await tx.$queryRaw<{id:string}[]>(Prisma.sql`SELECT id FROM ${table} WHERE account_id=${accountId}::uuid AND id IN (${jsonIds(unique)}) FOR SHARE`);
  if(found.length!==unique.length)invalid(`Some ${kind==='tags'?'audience tags':'custom fields'} are unavailable in this workspace`);
}

async function assertMedia(tx:TenantTransaction,accountId:string,value:string|undefined){
  if(!value)return;
  const origin=process.env.APP_URL||process.env.NEXT_PUBLIC_SITE_URL||'http://localhost:3000';
  let url:URL;try{url=new URL(value,origin);}catch{invalid('Invalid header media URL');}
  if(url.username||url.password||url.hash)invalid('Invalid header media URL');
  if(url.origin===new URL(origin).origin&&url.pathname==='/api/media/object'){
    const bucket=url.searchParams.get('bucket'),key=url.searchParams.get('key');
    if(!bucket||!key)invalid('Invalid workspace header media');
    const found=await tx.$queryRaw<{id:string}[]>`SELECT id FROM media_objects WHERE account_id=${accountId}::uuid AND bucket=${bucket} AND object_key=${key} FOR SHARE`;
    if(!found.length)invalid('Header media is unavailable in this workspace');
  }else if(url.protocol!=='https:'||value.startsWith('/'))invalid('Header media requires an HTTPS URL or workspace media object');
}

async function resolveContacts(tx:TenantTransaction,scope:TenantContext,input:CampaignInput):Promise<ContactRow[]>{
  const {audience}=input;const accountId=scope.accountId;
  const conditions:Prisma.Sql[]=[Prisma.sql`c.account_id=${accountId}::uuid`];
  if(audience.type==='csv'){
    const byPhone=new Map<string,{phone:string;name:string|null}>();
    for(const row of audience.csvContacts!){
      if(!/^\+?[\d\s().-]+$/.test(row.phone))invalid('CSV phones must contain international numbers');
      const phone=normalizePhone(row.phone);if(!isValidE164(phone))invalid('CSV phones must contain 8–15 international digits');
      if(!byPhone.has(phone))byPhone.set(phone,{phone,name:row.name?.trim()||null});
    }
    // Canonical sorting gives concurrent overlapping imports the same unique-index lock order.
    const rows=[...byPhone.values()].sort((a,b)=>a.phone.localeCompare(b.phone));
    await tx.$executeRaw`INSERT INTO contacts(account_id,user_id,phone,name)
      SELECT ${accountId}::uuid,${scope.userId}::uuid,x.phone,x.name
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(phone text,name text) ORDER BY x.phone
      ON CONFLICT(account_id,phone_normalized) WHERE phone_normalized<>'' DO NOTHING`;
    conditions.push(Prisma.sql`c.phone_normalized IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify([...byPhone.keys()])}::jsonb))`);
  }else if(audience.type==='tags'){
    conditions.push(Prisma.sql`EXISTS(SELECT 1 FROM contact_tags t WHERE t.account_id=${accountId}::uuid AND t.contact_id=c.id AND t.tag_id IN (${jsonIds(audience.tagIds!)}))`);
  }else if(audience.type==='custom_field'){
    const f=audience.customField!;
    const match=f.operator==='is'?Prisma.sql`v.value=${f.value}`:f.operator==='is_not'?Prisma.sql`v.value<>${f.value}`:Prisma.sql`strpos(lower(v.value),lower(${f.value}))>0`;
    conditions.push(Prisma.sql`EXISTS(SELECT 1 FROM contact_custom_values v WHERE v.account_id=${accountId}::uuid AND v.contact_id=c.id AND v.custom_field_id=${f.fieldId}::uuid AND ${match})`);
  }
  // Opted-out and blocked contacts never receive campaigns (lib/contacts/consent).
  conditions.push(Prisma.sql`c.opted_out_at IS NULL AND c.blocked_at IS NULL`);
  if(audience.excludeTagIds?.length)conditions.push(Prisma.sql`NOT EXISTS(SELECT 1 FROM contact_tags t WHERE t.account_id=${accountId}::uuid AND t.contact_id=c.id AND t.tag_id IN (${jsonIds(audience.excludeTagIds)}))`);
  const contacts=await tx.$queryRaw<ContactRow[]>(Prisma.sql`SELECT c.id,c.phone,c.name,c.email,c.company FROM contacts c
    WHERE ${Prisma.join(conditions,' AND ')} ORDER BY c.id LIMIT ${CAMPAIGN_LIMITS.recipients+1} FOR SHARE OF c`);
  if(!contacts.length)invalid('No contacts match this audience');
  if(contacts.length>CAMPAIGN_LIMITS.recipients)invalid(`Campaigns support at most ${CAMPAIGN_LIMITS.recipients} recipients`);
  return contacts;
}

/** The authenticated server owns audience resolution, frozen parameters and the initial durable job. */
export async function createCampaign(scope:TenantContext,raw:unknown):Promise<{id:string}>{
  if(!scope.userId||!scope.role||!hasMinRole(scope.role,'agent'))throw new ForbiddenError('Campaign creation requires an agent role');
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)invalid('Invalid campaign configuration');
  const input=parsed.data;
  if(Object.keys(input.variables).length>CAMPAIGN_LIMITS.variables)invalid('Too many template variables');
  return withTenant(scope,async tx=>{
    const membership=await tx.$queryRaw<{role:string}[]>`SELECT role FROM account_memberships
      WHERE account_id=${scope.accountId}::uuid AND user_id=${scope.userId}::uuid`;
    if(!membership[0]||!['agent','admin','owner'].includes(membership[0].role))throw new ForbiddenError('Campaign creation requires an active agent membership');
    const templates=await tx.$queryRaw<unknown[]>`SELECT * FROM message_templates WHERE account_id=${scope.accountId}::uuid AND id=${input.templateId}::uuid FOR SHARE`;
    if(!templates[0])throw new AuthError('Template unavailable',404,'not_found');
    const template=assertMessageTemplate(templates[0],'campaign creation');
    if(template.status!=='APPROVED')invalid('Choose an approved template');
    const expected=extractVariableIndices(template.body_text).map(String);
    const keys=Object.keys(input.variables).sort((a,b)=>Number(a)-Number(b));
    if(keys.length!==expected.length||keys.some((key,i)=>key!==expected[i]))invalid('Variable mappings must match every template body placeholder');
    const fieldIds=[...keys.flatMap(key=>input.variables[key].type==='custom_field'?[input.variables[key].value]:[]),...(input.audience.customField?[input.audience.customField.fieldId]:[])];
    await assertOwnedIds(tx,scope.accountId,'tags',[...(input.audience.tagIds??[]),...(input.audience.excludeTagIds??[])]);
    await assertOwnedIds(tx,scope.accountId,'custom_fields',fieldIds);
    const headerMediaUrl=input.headerMediaUrl??(template.header_media_url?.trim()||undefined);
    await assertMedia(tx,scope.accountId,headerMediaUrl);
    const contacts=await resolveContacts(tx,scope,input);
    const values=fieldIds.length?await tx.$queryRaw<{contact_id:string;custom_field_id:string;value:string|null}[]>(Prisma.sql`SELECT contact_id,custom_field_id,value FROM contact_custom_values WHERE account_id=${scope.accountId}::uuid AND contact_id IN (${jsonIds(contacts.map(c=>c.id))}) AND custom_field_id IN (${jsonIds([...new Set(fieldIds)])}) FOR SHARE`):[];
    const custom=new Map<string,Map<string,string>>();
    for(const row of values){const bucket=custom.get(row.contact_id)??new Map<string,string>();bucket.set(row.custom_field_id,row.value??'');custom.set(row.contact_id,bucket);}
    const recipients=contacts.map(contact=>({contact_id:contact.id,template_params:keys.map(key=>{
      const v=input.variables[key];const value=v.type==='static'?v.value:v.type==='field'?(contact[v.value]??''):(custom.get(contact.id)?.get(v.value)??'');
      if(value.length>1024)invalid('A resolved template value exceeds 1024 characters');return value;
    })}));
    if(Buffer.byteLength(JSON.stringify(recipients))>CAMPAIGN_LIMITS.frozenBytes)invalid('Resolved campaign parameters are too large');
    for(const recipient of recipients){try{buildSendComponents(template,{body:recipient.template_params,...(headerMediaUrl?{headerMediaUrl}:{})});}catch{invalid('Template send parameters are incomplete; check header media and body variables');}}
    const {csvContacts:_,...audienceFilter}=input.audience;void _;
    const broadcasts=await tx.$queryRaw<{id:string}[]>`INSERT INTO broadcasts(account_id,user_id,name,template_name,template_language,template_variables,audience_filter,status,total_recipients)
      VALUES(${scope.accountId}::uuid,${scope.userId}::uuid,${input.name},${template.name},${template.language||'en_US'},${JSON.stringify(input.variables)}::jsonb,${JSON.stringify(audienceFilter)}::jsonb,'sending',${recipients.length}) RETURNING id`;
    const id=broadcasts[0].id;
    await tx.$executeRaw`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,template_params)
      SELECT ${scope.accountId}::uuid,${id}::uuid,x.contact_id,'pending',x.template_params
      FROM jsonb_to_recordset(${JSON.stringify(recipients)}::jsonb) AS x(contact_id uuid,template_params jsonb)`;
    const payload={broadcastId:id,scope:'pending',...(headerMediaUrl?{headerMediaUrl}:{})};
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES('broadcast.dispatch',${scope.accountId}::uuid,${JSON.stringify(payload)}::jsonb,${`broadcast:${id}:initial`})`;
    return {id};
  },getWorkerPrisma());
}
