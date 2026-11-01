import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { createCampaign } from './create-campaign';

const configured=config({path:'.env.test',quiet:true}).parsed;
const ownerUrl=process.env.TEST_DATABASE_URL;
const workerUrl=process.env.TEST_WORKER_DATABASE_URL||configured?.WORKER_DATABASE_URL;
if(workerUrl)process.env.WORKER_DATABASE_URL=workerUrl;
const accountId=randomUUID(),otherAccountId=randomUUID(),userId=randomUUID(),viewerId=randomUUID();
const templateId=randomUUID(),foreignTemplateId=randomUUID(),contactId=randomUUID(),tagId=randomUUID(),foreignTagId=randomUUID(),fieldId=randomUUID(),foreignFieldId=randomUUID();
const scope={accountId,userId,role:'agent' as const};
let owner:pg.Client;
const payload=()=>({name:`Campaign ${randomUUID()}`,templateId,audience:{type:'all' as const},variables:{'1':{type:'field' as const,value:'name'},'2':{type:'custom_field' as const,value:fieldId}}});

describe.skipIf(!ownerUrl||!workerUrl)('atomic authenticated campaign creation',{timeout:60_000},()=>{
  beforeAll(async()=>{
    owner=new pg.Client({connectionString:ownerUrl});await owner.connect();
    if((await owner.query('SELECT current_database() AS name')).rows[0].name!=='bodhinox_test')throw new Error('Campaign tests require isolated bodhinox_test');
    const worker=await getWorkerPrisma().$queryRaw<{name:string;role:string}[]>`SELECT current_database() AS name,current_user AS role`;
    if(worker[0].name!=='bodhinox_test'||worker[0].role!=='bodhinox_worker')throw new Error('Campaign tests require constrained test worker');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Campaign agent','test-only-hash'),($3,$4,'Campaign viewer','test-only-hash')",[userId,`${userId}@example.invalid`,viewerId,`${viewerId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Campaign test',$2),($3,'Other campaign test',$2)",[accountId,userId,otherAccountId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($1,$3,'viewer'),($4,$2,'owner')",[accountId,userId,viewerId,otherAccountId]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$2,$3,'campaign_template','Hi {{1}} {{2}}','APPROVED'),($4,$5,$3,'foreign_template','Hi','APPROVED')",[templateId,accountId,userId,foreignTemplateId,otherAccountId]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550123')",[contactId,accountId,userId]);
    await owner.query("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'Audience'),($4,$5,$3,'Foreign audience')",[tagId,accountId,userId,foreignTagId,otherAccountId]);
    await owner.query("INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)",[accountId,contactId,tagId]);
    await owner.query("INSERT INTO custom_fields(id,account_id,user_id,field_name) VALUES($1,$2,$3,'Tier'),($4,$5,$3,'Foreign field')",[fieldId,accountId,userId,foreignFieldId,otherAccountId]);
    await owner.query("INSERT INTO contact_custom_values(account_id,contact_id,custom_field_id,value) VALUES($1,$2,$3,'Gold')",[accountId,contactId,fieldId]);
  });
  afterAll(async()=>{if(owner){await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])',[[accountId,otherAccountId]]);await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])',[[userId,viewerId]]);await owner.end();}await disconnectDatabases();});

  it('commits exact counts, frozen recipient parameters and one credential-free initial job together',async()=>{
    const input=payload();
    const result=await createCampaign(scope,{...input,audience:{type:'tags',tagIds:[tagId]}});
    const broadcast=(await owner.query('SELECT total_recipients,sent_count,failed_count,status FROM broadcasts WHERE id=$1',[result.id])).rows[0];
    expect(broadcast).toEqual({total_recipients:1,sent_count:0,failed_count:0,status:'sending'});
    const recipients=(await owner.query('SELECT contact_id,status,template_params FROM broadcast_recipients WHERE broadcast_id=$1',[result.id])).rows;
    expect(recipients).toEqual([{contact_id:contactId,status:'pending',template_params:['Asha','Gold']}]);
    const jobs=(await owner.query('SELECT tenant_id,payload,status FROM jobs WHERE dedupe_key=$1',[`broadcast:${result.id}:initial`])).rows;
    expect(jobs).toEqual([{tenant_id:accountId,payload:{broadcastId:result.id,scope:'pending'},status:'pending'}]);
    await owner.query("UPDATE contact_custom_values SET value='Platinum' WHERE account_id=$1 AND custom_field_id=$2",[accountId,fieldId]);
    expect((await owner.query('SELECT template_params FROM broadcast_recipients WHERE broadcast_id=$1',[result.id])).rows[0].template_params).toEqual(['Asha','Gold']);
    await owner.query("UPDATE contact_custom_values SET value='Gold' WHERE account_id=$1 AND custom_field_id=$2",[accountId,fieldId]);
  });

  it('deduplicates CSV numbers and reuses owned contacts without changing their names',async()=>{
    const input=payload();const phone=`+1${String(Date.now()).slice(-10)}`;
    const result=await createCampaign(scope,{...input,audience:{type:'csv',csvContacts:[{phone:'+1 (415) 555-0123',name:'Do not overwrite'},{phone:phone,name:'CSV user'},{phone:phone.replace('+',''),name:'Duplicate'}]}});
    expect((await owner.query('SELECT total_recipients FROM broadcasts WHERE id=$1',[result.id])).rows[0].total_recipients).toBe(2);
    const rows=(await owner.query('SELECT r.template_params,c.name FROM broadcast_recipients r JOIN contacts c ON c.id=r.contact_id WHERE r.broadcast_id=$1 ORDER BY c.name',[result.id])).rows;
    expect(rows).toEqual([{template_params:['Asha','Gold'],name:'Asha'},{template_params:['CSV user',''],name:'CSV user'}]);
  });

  it('persists approved template header fallback for worker signing and denies foreign workspace media',async()=>{
    const fallback='https://cdn.example.invalid/campaign-header.png';
    await owner.query("UPDATE message_templates SET header_type='image',header_media_url=$2 WHERE id=$1",[templateId,fallback]);
    try{
      const result=await createCampaign(scope,{...payload(),audience:{type:'tags',tagIds:[tagId]}});
      expect((await owner.query('SELECT payload FROM jobs WHERE dedupe_key=$1',[`broadcast:${result.id}:initial`])).rows[0].payload).toEqual({broadcastId:result.id,scope:'pending',headerMediaUrl:fallback});
      const key=`foreign-${randomUUID()}.png`;
      await owner.query("INSERT INTO media_objects(account_id,bucket,object_key,content_type,byte_size) VALUES($1,'template-media',$2,'image/png',100)",[otherAccountId,key]);
      await expect(createCampaign(scope,{...payload(),headerMediaUrl:`/api/media/object?bucket=template-media&key=${key}`})).rejects.toMatchObject({status:400});
    }finally{await owner.query('UPDATE message_templates SET header_type=NULL,header_media_url=NULL WHERE id=$1',[templateId]);}
  });

  it('never includes opted-out or blocked contacts, and refuses an audience that is entirely suppressed',async()=>{
    const optedOut=randomUUID(),blocked=randomUUID();
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at,opt_out_source) VALUES($1,$2,$3,'Opted out','14155550191',NOW(),'keyword')",[optedOut,accountId,userId]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone,blocked_at) VALUES($1,$2,$3,'Blocked','14155550192',NOW())",[blocked,accountId,userId]);
    await owner.query("INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$4),($1,$3,$4)",[accountId,optedOut,blocked,tagId]);
    try{
      const result=await createCampaign(scope,{...payload(),audience:{type:'tags',tagIds:[tagId]}});
      const recipients=(await owner.query('SELECT contact_id FROM broadcast_recipients WHERE broadcast_id=$1',[result.id])).rows;
      expect(recipients).toEqual([{contact_id:contactId}]);
      await owner.query('UPDATE contacts SET opted_out_at=NOW() WHERE id=$1',[contactId]);
      await expect(createCampaign(scope,{...payload(),audience:{type:'tags',tagIds:[tagId]}})).rejects.toMatchObject({status:400});
    }finally{
      await owner.query('UPDATE contacts SET opted_out_at=NULL WHERE id=$1',[contactId]);
      await owner.query('DELETE FROM contacts WHERE id=ANY($1::uuid[])',[[optedOut,blocked]]);
    }
  });

  it('rejects viewers and all foreign template, tag and custom-field references before persistence',async()=>{
    const input=payload();
    await expect(createCampaign({...scope,userId:viewerId,role:'viewer'},input)).rejects.toMatchObject({status:403});
    // The trusted worker transaction must also enforce live membership, not a caller-supplied role.
    await expect(createCampaign({...scope,userId:viewerId,role:'agent'},input)).rejects.toMatchObject({status:403});
    await expect(createCampaign(scope,{...input,templateId:foreignTemplateId})).rejects.toMatchObject({status:404});
    await expect(createCampaign(scope,{...input,audience:{type:'tags',tagIds:[foreignTagId]}})).rejects.toMatchObject({status:400});
    await expect(createCampaign(scope,{...input,audience:{type:'all',excludeTagIds:[foreignTagId]}})).rejects.toMatchObject({status:400});
    await expect(createCampaign(scope,{...input,audience:{type:'custom_field',customField:{fieldId:foreignFieldId,operator:'is',value:'Gold'}}})).rejects.toMatchObject({status:400});
    await expect(createCampaign(scope,{...input,variables:{'1':{type:'field',value:'name'},'2':{type:'custom_field',value:foreignFieldId}}})).rejects.toMatchObject({status:400});
    await expect(createCampaign(scope,{...input,audience:{type:'all',contactIds:[randomUUID()]}})).rejects.toMatchObject({status:400});
    await expect(createCampaign(scope,{...input,audience:{type:'csv',csvContacts:[{phone:'+14155550123',contact_id:randomUUID()}]}})).rejects.toMatchObject({status:400});
    expect((await owner.query('SELECT count(*)::int AS count FROM broadcasts WHERE account_id=$1 AND name=$2',[accountId,input.name])).rows[0].count).toBe(0);
  });

  it('rejects unapproved templates, missing variable mappings and oversized CSV before creating a campaign',async()=>{
    const input=payload();
    await expect(createCampaign(scope,{...input,variables:{}})).rejects.toMatchObject({status:400});
    await expect(createCampaign(scope,{...input,audience:{type:'csv',csvContacts:Array.from({length:1001},()=>({phone:'+14155550123'}))}})).rejects.toMatchObject({status:400});
    await owner.query("UPDATE message_templates SET status='DRAFT' WHERE id=$1",[templateId]);
    try{await expect(createCampaign(scope,input)).rejects.toMatchObject({status:400});}
    finally{await owner.query("UPDATE message_templates SET status='APPROVED' WHERE id=$1",[templateId]);}
    expect((await owner.query('SELECT count(*)::int AS count FROM broadcasts WHERE account_id=$1 AND name=$2',[accountId,input.name])).rows[0].count).toBe(0);
  });

  it('rolls back CSV contacts, campaign, recipients and outbox if initial job persistence fails',async()=>{
    const input=payload(),phone=`+1${String(Date.now()+1000).slice(-10)}`;
    const suffix=randomUUID().replaceAll('-',''),functionName=`campaign_job_fail_${suffix}`,triggerName=`campaign_job_fail_${suffix}`;
    await owner.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${accountId}'::uuid AND NEW.type='broadcast.dispatch' THEN RAISE EXCEPTION 'Simulated campaign queue failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      await expect(createCampaign(scope,{...input,audience:{type:'csv',csvContacts:[{phone,name:'Rolled back CSV'}]}})).rejects.toThrow();
      expect((await owner.query('SELECT count(*)::int AS count FROM broadcasts WHERE account_id=$1 AND name=$2',[accountId,input.name])).rows[0].count).toBe(0);
      expect((await owner.query("SELECT count(*)::int AS count FROM contacts WHERE account_id=$1 AND name='Rolled back CSV'",[accountId])).rows[0].count).toBe(0);
      expect((await owner.query("SELECT count(*)::int AS count FROM outbox_events WHERE account_id=$1 AND payload->'new'->>'name'=$2",[accountId,input.name])).rows[0].count).toBe(0);
    } finally {await owner.query(`DROP TRIGGER ${triggerName} ON jobs`);await owner.query(`DROP FUNCTION ${functionName}()`);}
  });
});
