'use client';

// WhatsApp › Sequences › one sequence (batch 7): the same timeline editor as
// Instagram's, reachable while Instagram is off (the WhatsApp section layout
// explains a WhatsApp channel that is off).
import { use } from 'react';
import { SequenceEditor } from '@/components/sequences/sequence-editor';

export default function WhatsAppSequencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <SequenceEditor id={id} />;
}
