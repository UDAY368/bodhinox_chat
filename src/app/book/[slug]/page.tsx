import { BookingFlow } from '@/components/booking-public/booking-flow';

export const dynamic = 'force-dynamic';

type Query = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);

// ?service=<serviceId>&staff=<staffId> preselects; ids not on the page are ignored by the flow.
export default async function BookPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Query> }) {
  const { slug } = await params;
  const query = await searchParams;
  return <BookingFlow slug={slug} query={{ service: one(query.service), staff: one(query.staff) }} />;
}
