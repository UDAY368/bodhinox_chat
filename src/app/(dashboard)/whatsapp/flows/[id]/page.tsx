import { FlowEditorPage } from '@/components/flows/flow-editor-page';

// WhatsApp › Flows › editor (Stage 1). Another channel's flow moves to its own section.
export default async function WhatsAppFlowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FlowEditorPage channel="whatsapp" flowId={id} />;
}
