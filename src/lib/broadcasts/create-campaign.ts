import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';
import { assertMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { templateKindOf } from '@/lib/whatsapp/template-validators';
import {
  CAMPAIGN_SEND_EXTRAS_KEY, CAMPAIGN_VARIABLE_KEY, campaignVariableKeys, parseCampaignSendExtras, splitFrozenParams, templateSendRefusal,
} from '@/lib/whatsapp/template-send-params';
import { normalizePhone, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { AudienceFilterError, assertFilterReferences, compileAudienceFilter } from '@/lib/audience/filter';
import { listFilter } from '@/lib/audience/lists';
import { loadSegmentFilter } from '@/lib/audience/segments';
import { trackedButtonIndex, validTrackedUrl } from './tracking';
import { requireFeature, requireWithinLimit } from '@/lib/billing/entitlements';
import { requireSendingAllowed } from '@/lib/billing/suspension';
import { campaignNumberId } from './api-campaign';

// Recipients and their frozen parameters are built in SQL, so the cap bounds one insert, not request memory.
// parameterCells bounds recipients × variables, so one request cannot freeze an unbounded amount of data.
export const CAMPAIGN_LIMITS={bodyBytes:5*1024*1024,recipients:50_000,csvRows:10_000,csvColumns:20,tags:100,variables:50,parameterCells:500_000,maxScheduleDays:90} as const;
export const variableMapping=z.discriminatedUnion('type',[
  z.object({type:z.literal('static'),value:z.string().max(1024)}).strict(),
  z.object({type:z.literal('field'),value:z.enum(['name','phone','email','company'])}).strict(),
  z.object({type:z.literal('custom_field'),value:z.string().uuid()}).strict(),
  /** A column of the uploaded CSV (CSV audiences only); each row supplies its own value. */
  z.object({type:z.literal('csv_column'),value:z.string().trim().min(1).max(64)}).strict(),
]);
const mapping=variableMapping;
const csvRow=z.object({
  phone:z.string().min(1).max(64),name:z.string().max(256).optional(),
  values:z.record(z.string().max(64),z.string().max(1024)).refine(v=>Object.keys(v).length<=CAMPAIGN_LIMITS.csvColumns,'Too many CSV columns').optional(),
}).strict();
/** Exported for the cost estimate (lib/analytics/campaign-cost), which counts the same audience. */
export const audienceSchema=z.object({
  type:z.enum(['all','tags','custom_field','csv','segment','list']),
  segmentId:z.string().uuid().optional(),
  listId:z.string().uuid().optional(),
  tagIds:z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.tags).optional(),
  excludeTagIds:z.array(z.string().uuid()).max(CAMPAIGN_LIMITS.tags).optional(),
  customField:z.object({fieldId:z.string().uuid(),operator:z.enum(['is','is_not','contains']),value:z.string().max(1024)}).strict().optional(),
  csvContacts:z.array(csvRow).max(CAMPAIGN_LIMITS.csvRows).optional(),
  /** CSV only: send once per row even when a number repeats (each row keeps its own values). */
  allowDuplicates:z.boolean().optional(),
}).strict().superRefine((a,ctx)=>{
  if((a.type==='tags'&&!a.tagIds?.length)||(a.type==='custom_field'&&!a.customField)||(a.type==='csv'&&!a.csvContacts?.length)||(a.type==='segment'&&!a.segmentId)||(a.type==='list'&&!a.listId))
    ctx.addIssue({code:'custom',message:'Audience configuration is incomplete'});
});
const inputSchema=z.object({
  name:z.string().trim().min(1).max(200),templateId:z.string().uuid(),audience:audienceSchema,
  /** Body {{n}} as "n"; a carousel card's body {{n}} as "c<card>_n" (lib/whatsapp/template-send-params). */
  variables:z.record(z.string().regex(CAMPAIGN_VARIABLE_KEY),mapping),headerMediaUrl:z.string().trim().min(1).max(2048).optional(),
  /** Send later instead of now (ISO timestamp, 1 minute to 90 days ahead). */
  scheduledAt:z.string().datetime({offset:true}).optional(),
  /** Where a trackable template's link button finally leads (lib/broadcasts/tracking). */
  trackedUrl:z.string().trim().max(2048).optional(),
  /** Location, offer end and coupon code: the same for every recipient. */
  sendExtras:z.unknown().optional(),
  /** The number to send from; the workspace default when omitted. */
  whatsappConfigId:z.string().uuid().nullish(),
}).strict();
export type CampaignInput=z.infer<typeof inputSchema>;
const FIELD_COLUMNS={name:Prisma.sql`c.name`,phone:Prisma.sql`c.phone`,email:Prisma.sql`c.email`,company:Prisma.sql`c.company`};

/** When the campaign should start, or null to start now. Requires an ISO time with an explicit offset. */
export function parseSchedule(value:string|undefined,now=new Date()):Date|null{
  if(!value)return null;
  if(!z.string().datetime({offset:true}).safeParse(value).success)invalid('Choose a valid date and time');
  const at=new Date(value);
  if(at.getTime()<now.getTime()+60_000)invalid('Schedule the campaign at least one minute ahead');
  if(at.getTime()>now.getTime()+CAMPAIGN_LIMITS.maxScheduleDays*86_400_000)invalid(`Campaigns can be scheduled at most ${CAMPAIGN_LIMITS.maxScheduleDays} days ahead`);
  return at;
}
function invalid(message:string):never{throw new AuthError(message,400,'campaign_input');}
const jsonIds=(ids:string[])=>Prisma.sql`SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)`;

async function assertOwnedIds(tx:TenantTransaction,accountId:string,kind:'tags'|'custom_fields',ids:string[]){
  const unique=[...new Set(ids)];if(!unique.length)return;
  // Identifiers are fixed enum values; only values become SQL parameters.
  const table=kind==='tags'?Prisma.sql`tags`:Prisma.sql`custom_fields`;
  const found=await tx.$queryRaw<{id:string}[]>(Prisma.sql`SELECT id FROM ${table} WHERE account_id=${accountId}::uuid AND id IN (${jsonIds(unique)}) FOR SHARE`);
  if(found.length!==unique.length)invalid(`Some ${kind==='tags'?'audience tags':'custom fields'} are unavailable in this workspace`);
}

export async function assertMedia(tx:TenantTransaction,accountId:string,value:string|undefined){
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

/**
 * The audience as `FROM … WHERE … ORDER BY` over `contacts c`. A CSV audience first upserts its
 * contacts, then joins its rows as `x` (one recipient per row, so a row can carry its own values).
 * Read-only callers must not pass a CSV audience (it writes contacts).
 */
export async function audienceSource(tx:TenantTransaction,scope:TenantContext,input:Pick<CampaignInput,'audience'>):Promise<{from:Prisma.Sql;where:Prisma.Sql;order:Prisma.Sql}>{
  const {audience}=input;const accountId=scope.accountId;
  const conditions:Prisma.Sql[]=[Prisma.sql`c.account_id=${accountId}::uuid`];
  let from=Prisma.sql`contacts c`,order=Prisma.sql`c.id`;
  if(audience.type==='csv'){
    const byPhone=new Map<string,{phone:string;name:string|null}>();
    const sendRows:{ord:number;phone:string;vals:Record<string,string>}[]=[];
    for(const row of audience.csvContacts!){
      if(!/^\+?[\d\s().-]+$/.test(row.phone))invalid('CSV phones must contain international numbers');
      const phone=normalizePhone(row.phone);if(!isValidE164(phone))invalid('CSV phones must contain 8–15 international digits');
      const repeat=byPhone.has(phone);
      if(!repeat)byPhone.set(phone,{phone,name:row.name?.trim()||null});
      if(!repeat||audience.allowDuplicates)sendRows.push({ord:sendRows.length,phone,vals:row.values??{}});
    }
    // Canonical sorting gives concurrent overlapping imports the same unique-index lock order.
    const rows=[...byPhone.values()].sort((a,b)=>a.phone.localeCompare(b.phone));
    await tx.$executeRaw`INSERT INTO contacts(account_id,user_id,phone,name)
      SELECT ${accountId}::uuid,${scope.userId}::uuid,x.phone,x.name
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(phone text,name text) ORDER BY x.phone
      ON CONFLICT(account_id,phone_normalized) WHERE phone_normalized<>'' DO NOTHING`;
    from=Prisma.sql`jsonb_to_recordset(${JSON.stringify(sendRows)}::jsonb) AS x(ord int,phone text,vals jsonb)
      JOIN contacts c ON c.account_id=${accountId}::uuid AND c.phone_normalized=x.phone`;
    order=Prisma.sql`x.ord`;
  }else if(audience.type==='segment'){
    try{
      const filter=await loadSegmentFilter(tx,accountId,audience.segmentId!,{lock:true});
      // Tags, lists or campaigns the segment names may have been deleted since it was saved.
      await assertFilterReferences(tx,accountId,filter);
      conditions.push(compileAudienceFilter(accountId,filter));
    }catch(error){if(error instanceof AudienceFilterError)invalid(error.message);throw error;}
  }else if(audience.type==='list'){
    const filter=listFilter(audience.listId!);
    try{await assertFilterReferences(tx,accountId,filter);}
    catch(error){if(error instanceof AudienceFilterError)invalid(error.message);throw error;}
    // A list archived by a plan downgrade cannot start a new campaign.
    const [archived]=await tx.$queryRaw<{n:number}[]>`SELECT count(*)::int AS n FROM contact_lists WHERE account_id=${accountId}::uuid AND id=${audience.listId!}::uuid AND archived_at IS NOT NULL`;
    if(archived.n)invalid('This list is archived because of your plan. Upgrade or restore it to use it in a campaign');
    conditions.push(compileAudienceFilter(accountId,filter));
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
  return {from,where:Prisma.join(conditions,' AND '),order};
}

/** Each recipient's frozen template parameters as a SQL jsonb array, resolved per contact row. */
function paramsSql(accountId:string,input:CampaignInput,keys:string[]):Prisma.Sql{
  if(!keys.length)return Prisma.sql`'[]'::jsonb`;
  // left(…,1025) bounds each stored value; anything over 1,024 characters is rejected after the insert.
  return Prisma.sql`jsonb_build_array(${Prisma.join(keys.map(key=>{
    const v=input.variables[key];
    if(v.type==='static')return Prisma.sql`${v.value}::text`;
    if(v.type==='field')return Prisma.sql`left(COALESCE(${FIELD_COLUMNS[v.value]},''),1025)`;
    if(v.type==='csv_column')return Prisma.sql`left(COALESCE(x.vals->>${v.value},''),1025)`;
    return Prisma.sql`left(COALESCE((SELECT v.value FROM contact_custom_values v WHERE v.account_id=${accountId}::uuid AND v.contact_id=c.id AND v.custom_field_id=${v.value}::uuid),''),1025)`;
  }))})`;
}

/**
 * The authenticated server owns audience resolution, frozen parameters and the initial durable job.
 * A scheduled campaign freezes its recipients now and its job waits until `scheduledAt`;
 * consent is checked again when each recipient is sent.
 */
export async function createCampaign(scope:TenantContext,raw:unknown,now=new Date()):Promise<{id:string}>{
  if(!scope.userId||!scope.role||!hasMinRole(scope.role,'agent'))throw new ForbiddenError('Campaign creation requires an agent role');
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)invalid('Invalid campaign configuration');
  const input=parsed.data;
  if(Object.keys(input.variables).length>CAMPAIGN_LIMITS.variables)invalid('Too many template variables');
  if(input.audience.type!=='csv'&&Object.values(input.variables).some(v=>v.type==='csv_column'))invalid('CSV columns can only be used with a CSV audience');
  if(input.audience.type!=='csv'&&input.audience.allowDuplicates)invalid('Duplicates can only be allowed for a CSV audience');
  if(input.audience.type==='csv'){
    const columns=new Set(input.audience.csvContacts!.flatMap(row=>Object.keys(row.values??{})));
    const missing=Object.values(input.variables).find(v=>v.type==='csv_column'&&!columns.has(v.value));
    if(missing)invalid(`The CSV has no "${missing.value}" column; map that variable again`);
  }
  const scheduledAt=parseSchedule(input.scheduledAt,now);
  return withTenant(scope,async tx=>{
    const membership=await tx.$queryRaw<{role:string}[]>`SELECT role FROM account_memberships
      WHERE account_id=${scope.accountId}::uuid AND user_id=${scope.userId}::uuid`;
    if(!membership[0]||!['agent','admin','owner'].includes(membership[0].role))throw new ForbiddenError('Campaign creation requires an active agent membership');
    await requireSendingAllowed(tx,scope.accountId);
    const templates=await tx.$queryRaw<unknown[]>`SELECT * FROM message_templates WHERE account_id=${scope.accountId}::uuid AND id=${input.templateId}::uuid FOR SHARE`;
    if(!templates[0])throw new AuthError('Template unavailable',404,'not_found');
    const template=assertMessageTemplate(templates[0],'campaign creation');
    if(template.status!=='APPROVED')invalid('Choose an approved template');
    // A campaign never carries a per-person one-time code.
    const refusal=templateSendRefusal(template,'campaign');if(refusal)invalid(refusal);
    // The sending number must be this workspace's, and the template must be from its WABA.
    const numberId=await campaignNumberId(tx,scope.accountId,input.whatsappConfigId,template as {waba_id?:string|null});
    // Values are frozen in this order: body placeholders, then each carousel card's.
    const keys=campaignVariableKeys(template);
    if(Object.keys(input.variables).length!==keys.length||keys.some(key=>!Object.hasOwn(input.variables,key)))invalid('Variable mappings must match every template body placeholder');
    const extras=parseCampaignSendExtras(input.sendExtras,(scheduledAt??now).getTime());
    if(!extras.ok)invalid(extras.error);
    const fieldIds=[...keys.flatMap(key=>input.variables[key].type==='custom_field'?[input.variables[key].value]:[]),...(input.audience.customField?[input.audience.customField.fieldId]:[])];
    await assertOwnedIds(tx,scope.accountId,'tags',[...(input.audience.tagIds??[]),...(input.audience.excludeTagIds??[])]);
    await assertOwnedIds(tx,scope.accountId,'custom_fields',fieldIds);
    const headerMediaUrl=input.headerMediaUrl??(template.header_media_url?.trim()||undefined);
    await assertMedia(tx,scope.accountId,headerMediaUrl);
    const tracked=trackedButtonIndex(template);
    if(scheduledAt)await requireFeature(tx,scope.accountId,'campaign_scheduling');
    if(tracked>=0)await requireFeature(tx,scope.accountId,'click_tracking');
    if(tracked>=0&&!(input.trackedUrl&&validTrackedUrl(input.trackedUrl)))invalid('This template tracks link clicks: enter the HTTPS page the button should open');
    // Header media, body count and the tracking button are the same for every recipient, so one sample validates the campaign.
    try{buildSendComponents(template,{...extras.value,...splitFrozenParams(template,keys.map(()=>'x')),...(headerMediaUrl?{headerMediaUrl}:{}),...(tracked>=0?{buttonParams:{[tracked]:'x'}}:{})});}
    catch(error){
      // Standard templates keep the general hint; the new kinds name the missing value (location, offer end, card).
      invalid(templateKindOf(template)==='standard'||!(error instanceof Error)?'Template send parameters are incomplete; check header media, body variables and link buttons':error.message);
    }
    const {from,where,order}=await audienceSource(tx,scope,input);
    const [{matched}]=await tx.$queryRaw<{matched:number}[]>(Prisma.sql`SELECT count(*)::int AS matched FROM (SELECT 1 FROM ${from} WHERE ${where} LIMIT ${CAMPAIGN_LIMITS.recipients+1}) m`);
    if(!matched)invalid('No contacts match this audience');
    if(matched>CAMPAIGN_LIMITS.recipients)invalid(`Campaigns support at most ${CAMPAIGN_LIMITS.recipients.toLocaleString('en')} recipients`);
    await requireWithinLimit(tx,scope.accountId,'campaign_recipients',matched);
    if(matched*keys.length>CAMPAIGN_LIMITS.parameterCells)invalid('This audience is too large for this many template variables; narrow the audience or use fewer variables');
    const {csvContacts:_,...audienceFilter}=input.audience;void _;
    const trackedUrl=tracked>=0?input.trackedUrl!:null;
    const broadcasts=await tx.$queryRaw<{id:string}[]>`INSERT INTO broadcasts(account_id,user_id,name,template_name,template_language,template_variables,audience_filter,status,scheduled_at,total_recipients,tracked_url,whatsapp_config_id)
      VALUES(${scope.accountId}::uuid,${scope.userId}::uuid,${input.name},${template.name},${template.language||'en_US'},${JSON.stringify(Object.keys(extras.value).length?{...input.variables,[CAMPAIGN_SEND_EXTRAS_KEY]:extras.value}:input.variables)}::jsonb,${JSON.stringify(audienceFilter)}::jsonb,${scheduledAt?'scheduled':'sending'},${scheduledAt},0,${trackedUrl},${numberId}::uuid) RETURNING id`;
    const id=broadcasts[0].id;
    // 122 random bits per recipient when tracking; the token is the button's {{1}}.
    const token=trackedUrl?Prisma.sql`replace(gen_random_uuid()::text,'-','')`:Prisma.sql`NULL`;
    const total=await tx.$executeRaw(Prisma.sql`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,template_params,click_token)
      SELECT ${scope.accountId}::uuid,${id}::uuid,c.id,'pending',${paramsSql(scope.accountId,input,keys)},${token}
      FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ${CAMPAIGN_LIMITS.recipients+1}`);
    // The pre-count ran in this transaction, but rows can change between the two statements.
    if(!total)invalid('No contacts match this audience');
    if(total>CAMPAIGN_LIMITS.recipients)invalid(`Campaigns support at most ${CAMPAIGN_LIMITS.recipients.toLocaleString('en')} recipients`);
    const [tooLong]=await tx.$queryRaw<{found:boolean}[]>`SELECT EXISTS(SELECT 1 FROM broadcast_recipients r, jsonb_array_elements_text(r.template_params) p
      WHERE r.account_id=${scope.accountId}::uuid AND r.broadcast_id=${id}::uuid AND length(p)>1024) AS found`;
    if(tooLong.found)invalid('A resolved template value exceeds 1024 characters');
    await tx.$executeRaw`UPDATE broadcasts SET total_recipients=${total} WHERE id=${id}::uuid`;
    const payload={broadcastId:id,scope:'pending',...(headerMediaUrl?{headerMediaUrl}:{})};
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
      VALUES('broadcast.dispatch',${scope.accountId}::uuid,${JSON.stringify(payload)}::jsonb,${`broadcast:${id}:initial`},${scheduledAt??now})`;
    return {id};
  },getWorkerPrisma());
}
