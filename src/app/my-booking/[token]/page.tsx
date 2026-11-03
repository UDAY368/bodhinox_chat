import { ManageBooking } from '@/components/booking-public/manage-booking';

export const dynamic = 'force-dynamic';

export default async function MyBookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ManageBooking token={token} />;
}
