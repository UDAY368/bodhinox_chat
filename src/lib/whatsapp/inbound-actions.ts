import { createAdminClient } from "@/lib/data/admin";
import { withJobScope } from "@/lib/jobs/scope";
import { resumeAwaitingReply, runAutomationsForTrigger } from "@/lib/automations/engine";
import { dispatchInboundToFlows } from "@/lib/flows/engine";
import { dispatchInboundToAiReply } from "@/lib/ai/auto-reply";
import { dispatchWebhookEvent } from "@/lib/webhooks/deliver";
import { dispatchQuickReplyAction } from "./quick-reply-actions";
import { runInboundStage, type InboundActionsPayload } from "./ingest";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validatePayload(input: InboundActionsPayload): void {
  if (!input || !["message", "status"].includes(input.kind) ||
    ![input.accountId,input.messageId,input.conversationId].every(value=>typeof value==="string" && uuid.test(value)) ||
    typeof input.metaMessageId!=="string") throw new Error("Invalid inbound actions contract");
  if (input.kind==="message" && (!uuid.test(input.userId) || !uuid.test(input.contactId) ||
    typeof input.contentType!=="string" || (input.contentText!==null && typeof input.contentText!=="string") ||
    (input.interactiveReplyId!==null && typeof input.interactiveReplyId!=="string"))) throw new Error("Invalid message actions contract");
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
    const explicit=await stage("quick_reply_action",()=>dispatchQuickReplyAction(db,input));
    const flow=explicit.handled ? {consumed:true} : await stage("flow",()=>dispatchInboundToFlows({
      accountId:input.accountId,userId:input.userId,contactId:input.contactId,conversationId:input.conversationId,
      message:input.interactiveReplyId ? {kind:"interactive_reply",reply_id:input.interactiveReplyId,reply_title:text,meta_message_id:input.metaMessageId}
        : {kind:"text",text,meta_message_id:input.metaMessageId},
      isFirstInboundMessage:input.isFirstInboundMessage,
    }));
    const replied=flow.consumed ? false : await stage("reply_resume",()=>resumeAwaitingReply({
      accountId:input.accountId,contactId:input.contactId,context:{message_text:text,conversation_id:input.conversationId,interactive_reply_id:input.interactiveReplyId??undefined},
    }));
    const consumed=flow.consumed||replied;
    const triggers: Array<"new_contact_created"|"first_inbound_message"|"new_message_received"|"keyword_match"|"interactive_reply">=[];
    if(!consumed) {
      triggers.push("new_message_received","keyword_match");
      if(input.interactiveReplyId) triggers.push("interactive_reply");
    }
    if(!explicit.handled&&input.wasContactCreated) triggers.unshift("new_contact_created");
    if(!explicit.handled&&input.isFirstInboundMessage) triggers.unshift("first_inbound_message");
    for(const triggerType of triggers) await stage(`automation:${triggerType}`,()=>runAutomationsForTrigger({
      accountId:input.accountId,triggerType,contactId:input.contactId,
      context:{message_text:text,conversation_id:input.conversationId,interactive_reply_id:input.interactiveReplyId??undefined},
    }));
    if(!consumed&&!input.interactiveReplyId&&text.trim()) await stage("ai_reply",()=>dispatchInboundToAiReply({
      accountId:input.accountId,conversationId:input.conversationId,contactId:input.contactId,
      configOwnerUserId:input.userId,inboundMessageId:input.metaMessageId,
    }));
    await stage("message_webhook",()=>dispatchWebhookEvent(db,input.accountId,"message.received",{
      conversation_id:input.conversationId,contact_id:input.contactId,whatsapp_message_id:input.metaMessageId,
      content_type:input.contentType,content_text:input.contentText,
    }));
  });
}
