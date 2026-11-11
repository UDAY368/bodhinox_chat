'use client';

// Instagram › Sequences › one sequence (Stage 5, 5H): the timeline editor.
import { use } from 'react';
import { SequenceEditor } from '@/components/sequences/sequence-editor';

export default function InstagramSequencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <SequenceEditor id={id} />;
}
