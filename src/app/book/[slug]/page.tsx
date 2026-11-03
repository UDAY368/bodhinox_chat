import { BookingFlow } from '@/components/booking-public/booking-flow';

export const dynamic = 'force-dynamic';

export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <BookingFlow slug={slug} />;
}
