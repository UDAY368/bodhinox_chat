import { createAdminClient } from "@/lib/data/admin";
import { withJobScope } from "@/lib/jobs/scope";
import { resumeAwaitingReply, runAutomationsForTrigger } from "@/lib/automations/engine";
import { dispatchInboundToFlows } from "@/lib/flows/engine";
import type { ParsedInbound } from "@/lib/flows/types";
import { dispatchInboundToAiReply } from "@/lib/ai/auto-reply";
import { dispatchWebhookEvent } from "@/lib/webhooks/deliver";
import { dispatchQuickReplyAction } from "./quick-reply-actions";
import { runInboundStage, type InboundActionsPayload } from "./ingest";
import { applyConsentKeyword, consentKeyword } from "@/lib/contacts/consent";
import { withTenant } from "@/lib/db/tenant";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { applyFormSaveTo, loadFormDefinition } from "./forms/responses";
import type { InboundFormPayload } from "./inbound-structured";
import { asOrderMessagePayload, orderFlowVars, type OrderMessagePayload } from "@/lib/commerce/order-format";
import { sendOrderConfirmation } from "@/lib/commerce/order-confirmation";
import { applyInboundLifecycle } from "@/lib/inbox/lifecycle";
import { sendAwayMessage } from "@/lib/inbox/away-message";
import { parseHoldCodeMessage } from "@/lib/appointments/types";
import { handleBookingCode } from "@/lib/appointments/inbound";
import { aiDeploymentEnabled } from "@/lib/ai/gate";
import { enqueueAssessmentForInbound } from "@/lib/ai/assess/enqueue";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validatePayload(input: InboundActionsPayload): void {
  if (!input || !["message", "status"].includes(input.kind) ||
    ![input.accountId,input.messageId,input.conversationId].every(value=>typeof value==="string" && uuid.test(value)) ||
    typeof input.metaMessageId!=="string") throw new Error("Invalid inbound actions contract");
  if (input.kind==="message" && (!uuid.test(input.userId) || !uuid.test(input.contactId) ||
    typeof input.contentType!=="string" || (input.contentText!==null && typeof input.contentText!=="string") ||
    (input.interactiveReplyId!==null && typeof input.interactiveReplyId!=="string") ||
    (input.contextMetaId!==undefined && (typeof input.contextMetaId!=="string" || input.contextMetaId.length>256)))) throw new Error("Invalid message actions contract");
  if (input.kind==="message" && input.adReferral!==undefined && !validAdReferral(input.adReferral)) throw new Error("Invalid message actions contract");
  if (input.kind==="status" && !["sent","delivered","read","failed"].includes(input.status)) throw new Error("Invalid status actions contract");
}

/** The optional ad summary (jobs queued before it existed have none). */
function validAdReferral(value: unknown): boolean {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const r=value as Record<string,unknown>;
  const optional=(v:unknown,max:number)=>v===null||(typeof v==="string"&&v.length<=max);
  return typeof r.id==="string" && uuid.test(r.id) &&
    (r.sourceId===null||(typeof r.sourceId==="string"&&/^[0-9_]{1,64}$/.test(r.sourceId))) &&
    (r.sourceType==="ad"||r.sourceType==="post"||r.sourceType==="unknown") &&
    optional(r.headline,256) && optional(r.sourceUrl,2048);
}

/** The flow engine's view of the referral (never the click id). */
function flowReferral(input: MessageInput): Pick<ParsedInbound,"referral"> {
  const r=input.adReferral;
  return r ? {referral:{source_id:r.sourceId,source_type:r.sourceType,headline:r.headline,source_url:r.sourceUrl}} : {};
}

/** Invoked only from the persisted inbound.actions worker job, never the HTTP acknowledgment. */
export async function processInboundActions(input: InboundActionsPayload, assertLease: ()=>void = ()=>{}): Promise<void> {
  validatePayload(input);
  const scope = {accountId:input.accountId,role:"owner" as const,...(input.kind==="message" ? {userId:input.userId}: {})};
  await withJobScope(scope,async()=>{
    const db=createAdminClient(scope);
    const stage=<T>(name:string,action:()=>Promise<T>)=>runInboundStage(input.accountId,input.messageId,name,action,assertLease);
    if(input.kind==="status") {
      await stage(`status_webhook:${input.status}`,()=>dispatchWebhookEvent(db,input.accountId,"message.status_updated",{
        whatsapp_message_id:input.metaMessageId,conversation_id:input.conversationId,status:input.status,
      }));
      return;
    }
    // The channel comes from the stored conversation, never from the job payload.
    const stored=await storedConversation(db,input);
    if(stored.channel==="instagram") {
      // A link/unlink can move the conversation to another contact after this job
      // was queued: act for the contact that owns the conversation now, never the
      // queued one (ids-only log).
      const contactId=stored.contactId??input.contactId;
      if(contactId!==input.contactId) console.info("[inbound-actions] contact_rebound",{accountId:input.accountId,
        conversationId:input.conversationId,messageId:input.messageId});
      await processInstagramActions(db,{...input,contactId},stage);
      return;
    }
    if(input.wasConversationCreated) await stage("conversation_webhook",()=>dispatchWebhookEvent(db,input.accountId,"conversation.created",{
      conversation_id:input.conversationId,contact_id:input.contactId,
    }));
    // This local update is idempotent and retryable; external stages carry checkpoints below.
    await markBroadcastReply(db,input);
    const text=input.contentText??"";
    const form=await submittedForm(db,input);
    // A trusted submission fills the contact fields its form maps answers to.
    // Idempotent writes, applied whatever the contact's consent: the customer sent them.
    if(form?.trusted&&form.form_id) {
      const definition=await withTenant({accountId:input.accountId,role:"owner"},tx=>loadFormDefinition(tx,input.accountId,form.form_id!),getWorkerPrisma());
      if(definition) await applyFormSaveTo(db,input.accountId,input.contactId,definition,form.answers);
    }
    // A STOP/START message only records consent, and a blocked contact gets
    // no automated response; both still reach the message.received webhook.
    const keyword=input.contentType==="text"&&!input.interactiveReplyId ? consentKeyword(text) : null;
    if(keyword) await applyConsentKeyword(db,input.accountId,input.contactId,keyword);
    // STOP also ends the contact's running flows, so no timer or payment resume sends more.
    if(keyword==="opt_out") await endRunsOnOptOut(db,input);
    const {data:contact,error:contactError}=await db.from("contacts").select("blocked_at")
      .eq("id",input.contactId).eq("account_id",input.accountId).maybeSingle();
    if(contactError) throw new Error("Contact consent lookup failed");
    const order=form ? null : await cartOrder(db,input);
    if(!keyword&&!contact?.blocked_at) {
      // "BOOK <CODE>" confirms a public booking hold for this sender. Local and
      // transactional (customer messages go out as queued jobs), so it needs no
      // stage checkpoint. It handles only a real code of a workspace with the
      // appointments feature and a booking page; then flows, automations, AI and
      // the away message stay silent. Anything else ("book sunday") falls through.
      const holdCode=input.contentType==="text"&&!input.interactiveReplyId&&!form&&!order ? parseHoldCodeMessage(text) : null;
      const booking=holdCode ? await handleBookingCode({accountId:input.accountId,userId:input.userId,contactId:input.contactId,
        conversationId:input.conversationId,messageId:input.messageId,whatsappConfigId:input.whatsappConfigId??null,code:holdCode}) : {handled:false};
      if(!booking.handled) await respondAutomatically(db,input,text,stage,Boolean(form)||Boolean(order));
      // After the flow and automations, so an unresolved confirmation never holds them back.
      if(order) await stage("order_confirmation",()=>sendOrderConfirmation({accountId:input.accountId,userId:input.userId,
        conversationId:input.conversationId,contactId:input.contactId,order}));
      // Lifecycle and routing once the bots had their turn. Local and
      // transactional, so a retried job repeats it safely without a checkpoint.
      const lifecycle=await applyInboundLifecycle({accountId:input.accountId,conversationId:input.conversationId,
        contactId:input.contactId,messageId:input.messageId,text});
      // Out of hours and nobody automatic answered: the away message, once per window.
      if(!booking.handled&&!lifecycle.botOwned&&!lifecycle.botReplied) await stage("away_message",()=>sendAwayMessage({accountId:input.accountId,
        userId:input.userId,conversationId:input.conversationId,contactId:input.contactId,messageId:input.messageId}));
    }
    await stage("message_webhook",()=>dispatchWebhookEvent(db,input.accountId,"message.received",{
      conversation_id:input.conversationId,contact_id:input.contactId,whatsapp_message_id:input.metaMessageId,
      content_type:input.contentType,content_text:input.contentText,
    }));
    // Advisory AI assessment (Phase 13): only queues a debounced job for typed
    // customer text, never sends, and never throws. The env check keeps the
    // stage off the hot path when the deployment kill switch is off.
    if(!keyword&&!contact?.blocked_at&&input.contentType==="text"&&!input.interactiveReplyId&&text.trim()&&aiDeploymentEnabled())
      await stage("ai_assess",()=>enqueueAssessmentForInbound(input.accountId,input.conversationId));
  });
}

type Stage=<T>(name:string,action:()=>Promise<T>)=>Promise<T>;
type MessageInput=Extract<InboundActionsPayload,{kind:"message"}>;
type Db=ReturnType<typeof createAdminClient>;

/**
 * The stored conversation's channel and current contact. Only a stored
 * Instagram conversation (Phase 11) takes the Instagram path; every other row
 * keeps the WhatsApp path.
 */
async function storedConversation(db:Db,input:MessageInput): Promise<{channel:"instagram"|"whatsapp";contactId:string|null}> {
  const {data,error}=await db.from("conversations").select("channel,contact_id")
    .eq("account_id",input.accountId).eq("id",input.conversationId).maybeSingle();
  if(error) throw new Error("Conversation channel lookup failed");
  const row=data as {channel?:string|null;contact_id?:string|null}|null;
  return {channel:row?.channel==="instagram" ? "instagram" : "whatsapp",contactId:row?.contact_id??null};
}

/**
 * Instagram inbound (Phase 11): STOP/START consent, then flows only, then
 * lifecycle and routing (channel-neutral). Skipped because they are
 * WhatsApp-only or WhatsApp-shaped: campaign reply credit, WhatsApp forms, cart
 * orders and their confirmation, BOOK codes, automations, AI auto-reply, the
 * away message, and the message.received / conversation.created webhooks (their
 * payload carries whatsapp_message_id). Skips are logged with ids only.
 */
async function processInstagramActions(db:Db,input:MessageInput,stage:Stage): Promise<void> {
  const text=input.contentText??"";
  const keyword=input.contentType==="text"&&!input.interactiveReplyId ? consentKeyword(text) : null;
  if(keyword) await applyConsentKeyword(db,input.accountId,input.contactId,keyword);
  if(keyword==="opt_out") await endRunsOnOptOut(db,input);
  const {data:contact,error:contactError}=await db.from("contacts").select("blocked_at")
    .eq("id",input.contactId).eq("account_id",input.accountId).maybeSingle();
  if(contactError) throw new Error("Contact consent lookup failed");
  if(keyword||contact?.blocked_at) return;
  // Read before the stage claims its checkpoint: a failed read sends nothing, so the job retries.
  const message=await flowMessage(db,input,text);
  const flow=await stage("flow",()=>dispatchInboundToFlows({
    accountId:input.accountId,userId:input.userId,contactId:input.contactId,conversationId:input.conversationId,
    message,
    isFirstInboundMessage:input.isFirstInboundMessage,
  }));
  if(!flow?.consumed) console.info("[inbound-actions] channel_not_supported",{accountId:input.accountId,
    conversationId:input.conversationId,skipped:"automations_ai_away"});
  await applyInboundLifecycle({accountId:input.accountId,conversationId:input.conversationId,
    contactId:input.contactId,messageId:input.messageId,text});
}

/** Matches analytics (lib/analytics/queries REPLY_WINDOW): a later message is not a campaign reply. */
export const BROADCAST_REPLY_WINDOW_MS=72*3_600_000;
const OPEN_RECIPIENT=["sent","delivered","read"];

/**
 * Marks the contact's latest open campaign send as replied, but only one sent
 * from the number this message came in on, within the reply window. Campaigns
 * from before numbers were recorded (NULL) count as the default number's.
 */
async function markBroadcastReply(db:Db,input:MessageInput): Promise<void> {
  const {data:conversation,error:conversationError}=await db.from("conversations").select("whatsapp_config_id")
    .eq("account_id",input.accountId).eq("id",input.conversationId).maybeSingle();
  if(conversationError) throw new Error("Broadcast reply lookup failed");
  const numberId=(conversation as {whatsapp_config_id?:string|null}|null)?.whatsapp_config_id??null;
  const {data:numbers,error:numberError}=await db.from("whatsapp_config").select("id,is_default")
    .eq("account_id",input.accountId).order("is_default",{ascending:false}).order("created_at",{ascending:true}).limit(2);
  if(numberError) throw new Error("Broadcast reply lookup failed");
  const rows=(numbers??[]) as Array<{id:string;is_default:boolean}>;
  const defaultId=rows[0]&&(rows[0].is_default||rows.length===1) ? rows[0].id : null;
  const ids=[numberId??defaultId].filter((id):id is string=>Boolean(id));
  const legacy=numberId===null||numberId===defaultId;
  const since=new Date(Date.now()-BROADCAST_REPLY_WINDOW_MS).toISOString();
  const latest=async(match:(q:ReturnType<Db["from"]>)=>ReturnType<Db["from"]>)=>{
    const {data,error}=await match(db.from("broadcast_recipients")
      .select("id,sent_at,broadcasts!inner(account_id)").eq("contact_id",input.contactId)
      .eq("broadcasts.account_id",input.accountId).in("status",OPEN_RECIPIENT).gte("sent_at",since))
      .order("sent_at",{ascending:false}).limit(1);
    if(error) throw new Error("Broadcast reply lookup failed");
    return (data as Array<{id:string;sent_at:string|null}>|null)?.[0]??null;
  };
  const candidates=[
    ids.length ? await latest(q=>q.in("broadcasts.whatsapp_config_id",ids)) : null,
    legacy ? await latest(q=>q.is("broadcasts.whatsapp_config_id",null)) : null,
  ].filter((row):row is {id:string;sent_at:string|null}=>row!==null)
    .sort((a,b)=>Date.parse(b.sent_at??"")-Date.parse(a.sent_at??""));
  if(!candidates[0]) return;
  const reply=await db.from("broadcast_recipients").update({status:"replied",replied_at:new Date().toISOString()})
    .eq("id",candidates[0].id).in("status",OPEN_RECIPIENT);
  if(reply.error) throw new Error("Broadcast reply update failed");
}

/** Cancels the contact's active flow runs after a STOP. Idempotent on a retried job. */
async function endRunsOnOptOut(db:Db,input:MessageInput): Promise<void> {
  const {error}=await db.from("flow_runs").update({status:"cancelled",ended_at:new Date().toISOString(),end_reason:"contact_opted_out",wait_until:null})
    .eq("account_id",input.accountId).eq("contact_id",input.contactId).eq("status","active");
  if(error) throw new Error("Flow run opt-out update failed");
}

const MEDIA_TYPES=new Set(["image","video","document","audio"]);

/** The submitted form an inbound interactive message carries, if any. */
async function submittedForm(db:ReturnType<typeof createAdminClient>,input:MessageInput): Promise<InboundFormPayload|null> {
  if(input.contentType!=="interactive"||input.interactiveReplyId) return null;
  const {data,error}=await db.from("messages").select("interactive_payload")
    .eq("account_id",input.accountId).eq("id",input.messageId).maybeSingle();
  if(error) throw new Error("Inbound message lookup failed");
  const form=((data as {interactive_payload:unknown}|null)?.interactive_payload as {form?:InboundFormPayload}|null)?.form;
  return form&&typeof form==="object"&&form.answers&&typeof form.answers==="object" ? form : null;
}

/** The cart an inbound order message carries (stored by ingest), if any. */
async function cartOrder(db:ReturnType<typeof createAdminClient>,input:MessageInput): Promise<OrderMessagePayload|null> {
  if(input.contentType!=="interactive"||input.interactiveReplyId) return null;
  const {data,error}=await db.from("messages").select("interactive_payload")
    .eq("account_id",input.accountId).eq("id",input.messageId).maybeSingle();
  if(error) throw new Error("Inbound message lookup failed");
  return asOrderMessagePayload(((data as {interactive_payload:unknown}|null)?.interactive_payload as {order?:unknown}|null)?.order);
}

/**
 * The inbound as the flow engine sees it. Photos, locations and address
 * forms are re-read from the stored message, so queued jobs keep their
 * original payload shape.
 */
async function flowMessage(db:ReturnType<typeof createAdminClient>,input:MessageInput,text:string): Promise<ParsedInbound> {
  return {...await flowMessageBody(db,input,text),...flowReferral(input)};
}

async function flowMessageBody(db:ReturnType<typeof createAdminClient>,input:MessageInput,text:string): Promise<ParsedInbound> {
  const meta_message_id=input.metaMessageId;
  if(input.interactiveReplyId) {
    const context_template=await repliedTemplate(db,input);
    return {kind:"interactive_reply",reply_id:input.interactiveReplyId,reply_title:text,meta_message_id,...(context_template?{context_template}:{})};
  }
  if(!MEDIA_TYPES.has(input.contentType)&&input.contentType!=="location"&&input.contentType!=="interactive") return {kind:"text",text,meta_message_id};
  const {data,error}=await db.from("messages").select("media_url,media_type,interactive_payload")
    .eq("account_id",input.accountId).eq("id",input.messageId).maybeSingle();
  if(error) throw new Error("Inbound message lookup failed");
  const row=data as {media_url:string|null;media_type:string|null;interactive_payload:unknown}|null;
  const structured=row?.interactive_payload as Partial<{location:{latitude:number;longitude:number;name?:string;address?:string};address:Record<string,string>;form:InboundFormPayload;order:unknown}>|null|undefined;
  if(MEDIA_TYPES.has(input.contentType)&&row?.media_url) {
    return {kind:"media",media_type:input.contentType as "image"|"video"|"document"|"audio",url:row.media_url,caption:text,meta_message_id};
  }
  if(input.contentType==="location"&&structured?.location) return {kind:"location",...structured.location,meta_message_id};
  if(input.contentType==="interactive"&&structured?.address) return {kind:"address",values:structured.address,meta_message_id};
  const order=input.contentType==="interactive" ? asOrderMessagePayload(structured?.order) : null;
  if(order) return {kind:"order",summary:text,vars:orderFlowVars(order),meta_message_id};
  if(input.contentType==="interactive"&&structured?.form) {
    const f=structured.form;
    return {kind:"form",form_id:f.form_id,answers:f.answers??{},summary:text,trusted:f.trusted===true,
      flow_run_id:f.flow_run_id??null,node_key:f.node_key??null,meta_message_id};
  }
  return {kind:"text",text,meta_message_id};
}

/** The template a quick-reply tap answers: Meta sends the tap as a reply to that template message. */
async function repliedTemplate(db:ReturnType<typeof createAdminClient>,input:MessageInput): Promise<string|undefined> {
  const {data:tap,error}=await db.from("messages").select("reply_to_message_id")
    .eq("account_id",input.accountId).eq("id",input.messageId).maybeSingle();
  if(error) throw new Error("Inbound message lookup failed");
  const parent=(tap as {reply_to_message_id:string|null}|null)?.reply_to_message_id;
  if(!parent) {
    // Broadcast sends are recorded on their recipient row, not as messages.
    if(!input.contextMetaId) return undefined;
    const {data:recipients,error:recipientError}=await db.from("broadcast_recipients").select("id,broadcasts!inner(account_id,template_name)")
      .eq("whatsapp_message_id",input.contextMetaId).eq("broadcasts.account_id",input.accountId).limit(1);
    if(recipientError) throw new Error("Broadcast reply lookup failed");
    const broadcast=(recipients as Array<{broadcasts:{template_name:string|null}|Array<{template_name:string|null}>}>|null)?.[0]?.broadcasts;
    const name=Array.isArray(broadcast)?broadcast[0]?.template_name:broadcast?.template_name;
    return name||undefined;
  }
  const {data:sent,error:sentError}=await db.from("messages").select("content_type,template_name")
    .eq("account_id",input.accountId).eq("id",parent).maybeSingle();
  if(sentError) throw new Error("Replied message lookup failed");
  const row=sent as {content_type:string;template_name:string|null}|null;
  return row?.content_type==="template"&&row.template_name ? row.template_name : undefined;
}

/** Quick-reply actions, flows, automations and the AI fallback, in that order. */
async function respondAutomatically(db:ReturnType<typeof createAdminClient>,input:MessageInput,text:string,stage:Stage,isForm=false): Promise<void> {
    const explicit=await stage("quick_reply_action",()=>dispatchQuickReplyAction(db,input));
    // The stored-message reads run before the flow stage claims its checkpoint: a DB blip there
    // sent nothing, so the job retries instead of ending every later stage as uncertain.
    const message=explicit.handled ? null : await flowMessage(db,input,text);
    const flow=!message ? {consumed:true,outcome:undefined} : await stage("flow",()=>dispatchInboundToFlows({
      accountId:input.accountId,userId:input.userId,contactId:input.contactId,conversationId:input.conversationId,
      message,
      isFirstInboundMessage:input.isFirstInboundMessage,
    }));
    const replied=flow.consumed ? false : await stage("reply_resume",()=>resumeAwaitingReply({
      accountId:input.accountId,contactId:input.contactId,reserveMenuTextForAi:input.contentType==="text",context:{message_text:text,conversation_id:input.conversationId,interactive_reply_id:input.interactiveReplyId??undefined},
    }));
    const consumed=flow.consumed||replied;
    const triggers: Array<"new_contact_created"|"first_inbound_message"|"new_message_received"|"keyword_match"|"interactive_reply"|"ad_click">=[];
    if(!consumed) {
      // A form summary is not typed text, so it never matches keywords.
      triggers.push("new_message_received",...(isForm ? [] : ["keyword_match" as const]));
      if(input.interactiveReplyId) triggers.push("interactive_reply");
    }
    const aiFallback=flow.outcome==="ai_fallback"||replied==="ai_fallback";
    if(!explicit.handled&&!aiFallback&&input.wasContactCreated) triggers.unshift("new_contact_created");
    if(!explicit.handled&&!aiFallback&&input.isFirstInboundMessage) triggers.unshift("first_inbound_message");
    // A click-to-WhatsApp ad message runs its own stage, ahead of the first-message trigger.
    const ad=input.adReferral?.sourceType==="ad" ? input.adReferral : undefined;
    if(!explicit.handled&&!aiFallback&&ad) triggers.unshift("ad_click");
    let automationMatched=false;
    for(const triggerType of triggers) {
      const matched=await stage(`automation:${triggerType}`,()=>runAutomationsForTrigger({
      accountId:input.accountId,triggerType,contactId:input.contactId,
      context:{message_text:text,conversation_id:input.conversationId,interactive_reply_id:input.interactiveReplyId??undefined,
        ...(triggerType==="ad_click"&&ad ? {ad_id:ad.sourceId??""} : {})},
      }));
      // Older completed stages persisted null; their dispatch decision is
      // unknown, so do not introduce a second responder during replay.
      automationMatched=automationMatched||matched!==false;
    }
    if((aiFallback||(!consumed&&!automationMatched))&&!input.interactiveReplyId&&input.contentType==="text"&&text.trim()) await stage("ai_reply",()=>dispatchInboundToAiReply({
      accountId:input.accountId,conversationId:input.conversationId,contactId:input.contactId,
      configOwnerUserId:input.userId,inboundMessageId:input.metaMessageId,
      routingChecked:true,requireHandoffOnUnavailable:aiFallback,
    }));
}
