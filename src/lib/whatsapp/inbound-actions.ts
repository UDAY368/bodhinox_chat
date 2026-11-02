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

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validatePayload(input: InboundActionsPayload): void {
  if (!input || !["message", "status"].includes(input.kind) ||
    ![input.accountId,input.messageId,input.conversationId].every(value=>typeof value==="string" && uuid.test(value)) ||
    typeof input.metaMessageId!=="string") throw new Error("Invalid inbound actions contract");
  if (input.kind==="message" && (!uuid.test(input.userId) || !uuid.test(input.contactId) ||
    typeof input.contentType!=="string" || (input.contentText!==null && typeof input.contentText!=="string") ||
    (input.interactiveReplyId!==null && typeof input.interactiveReplyId!=="string") ||
    (input.contextMetaId!==undefined && (typeof input.contextMetaId!=="string" || input.contextMetaId.length>256)))) throw new Error("Invalid message actions contract");
  if (input.kind==="status" && !["sent","delivered","read","failed"].includes(input.status)) throw new Error("Invalid status actions contract");
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
    if(input.wasConversationCreated) await stage("conversation_webhook",()=>dispatchWebhookEvent(db,input.accountId,"conversation.created",{
      conversation_id:input.conversationId,contact_id:input.contactId,
    }));
    // This local update is idempotent and retryable; external stages carry checkpoints below.
    const {data:recipients,error:replyLookupError}=await db.from("broadcast_recipients")
      .select("id,status,broadcast_id,broadcasts!inner(account_id)").eq("contact_id",input.contactId)
      .eq("broadcasts.account_id",input.accountId).in("status",["sent","delivered","read"])
      .order("sent_at",{ascending:false}).limit(1);
    if(replyLookupError) throw new Error("Broadcast reply lookup failed");
    if(recipients?.[0]) {
      const reply=await db.from("broadcast_recipients").update({status:"replied",replied_at:new Date().toISOString()})
        .eq("id",recipients[0].id).in("status",["sent","delivered","read"]);
      if(reply.error) throw new Error("Broadcast reply update failed");
    }
    const text=input.contentText??"";
    // A STOP/START message only records consent, and a blocked contact gets
    // no automated response; both still reach the message.received webhook.
    const keyword=input.contentType==="text"&&!input.interactiveReplyId ? consentKeyword(text) : null;
    if(keyword) await applyConsentKeyword(db,input.accountId,input.contactId,keyword);
    const {data:contact,error:contactError}=await db.from("contacts").select("blocked_at")
      .eq("id",input.contactId).eq("account_id",input.accountId).maybeSingle();
    if(contactError) throw new Error("Contact consent lookup failed");
    if(!keyword&&!contact?.blocked_at) await respondAutomatically(db,input,text,stage);
    await stage("message_webhook",()=>dispatchWebhookEvent(db,input.accountId,"message.received",{
      conversation_id:input.conversationId,contact_id:input.contactId,whatsapp_message_id:input.metaMessageId,
      content_type:input.contentType,content_text:input.contentText,
    }));
  });
}

type Stage=<T>(name:string,action:()=>Promise<T>)=>Promise<T>;
type MessageInput=Extract<InboundActionsPayload,{kind:"message"}>;

const MEDIA_TYPES=new Set(["image","video","document","audio"]);

/**
 * The inbound as the flow engine sees it. Photos, locations and address
 * forms are re-read from the stored message, so queued jobs keep their
 * original payload shape.
 */
async function flowMessage(db:ReturnType<typeof createAdminClient>,input:MessageInput,text:string): Promise<ParsedInbound> {
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
  const structured=row?.interactive_payload as Partial<{location:{latitude:number;longitude:number;name?:string;address?:string};address:Record<string,string>}>|null|undefined;
  if(MEDIA_TYPES.has(input.contentType)&&row?.media_url) {
    return {kind:"media",media_type:input.contentType as "image"|"video"|"document"|"audio",url:row.media_url,caption:text,meta_message_id};
  }
  if(input.contentType==="location"&&structured?.location) return {kind:"location",...structured.location,meta_message_id};
  if(input.contentType==="interactive"&&structured?.address) return {kind:"address",values:structured.address,meta_message_id};
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
async function respondAutomatically(db:ReturnType<typeof createAdminClient>,input:MessageInput,text:string,stage:Stage): Promise<void> {
    const explicit=await stage("quick_reply_action",()=>dispatchQuickReplyAction(db,input));
    const flow=explicit.handled ? {consumed:true,outcome:undefined} : await stage("flow",async()=>dispatchInboundToFlows({
      accountId:input.accountId,userId:input.userId,contactId:input.contactId,conversationId:input.conversationId,
      message:await flowMessage(db,input,text),
      isFirstInboundMessage:input.isFirstInboundMessage,
    }));
    const replied=flow.consumed ? false : await stage("reply_resume",()=>resumeAwaitingReply({
      accountId:input.accountId,contactId:input.contactId,reserveMenuTextForAi:input.contentType==="text",context:{message_text:text,conversation_id:input.conversationId,interactive_reply_id:input.interactiveReplyId??undefined},
    }));
    const consumed=flow.consumed||replied;
    const triggers: Array<"new_contact_created"|"first_inbound_message"|"new_message_received"|"keyword_match"|"interactive_reply">=[];
    if(!consumed) {
      triggers.push("new_message_received","keyword_match");
      if(input.interactiveReplyId) triggers.push("interactive_reply");
    }
    const aiFallback=flow.outcome==="ai_fallback"||replied==="ai_fallback";
    if(!explicit.handled&&!aiFallback&&input.wasContactCreated) triggers.unshift("new_contact_created");
    if(!explicit.handled&&!aiFallback&&input.isFirstInboundMessage) triggers.unshift("first_inbound_message");
    let automationMatched=false;
    for(const triggerType of triggers) {
      const matched=await stage(`automation:${triggerType}`,()=>runAutomationsForTrigger({
      accountId:input.accountId,triggerType,contactId:input.contactId,
      context:{message_text:text,conversation_id:input.conversationId,interactive_reply_id:input.interactiveReplyId??undefined},
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
