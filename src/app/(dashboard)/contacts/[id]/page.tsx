import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ContactProfile } from '@/components/contacts/contact-profile';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /contacts/[id]: one contact's full-page profile. The contact and every section load through
// the tenant-scoped data client and /api/contacts/[id], so another workspace's id shows "not found".
export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return (
    <Suspense fallback={null}>
      <ContactProfile key={id} contactId={id} />
    </Suspense>
  );
}
