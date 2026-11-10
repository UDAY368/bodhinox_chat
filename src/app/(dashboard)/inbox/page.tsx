import { redirect } from 'next/navigation';
import { InboxView } from '@/components/inbox/inbox-view';
import { resolveInboxRedirect } from '@/lib/inbox/channel-inbox';

// /inbox: the All view (every channel) while both channels are enabled. With
// one channel enabled it redirects to that channel's inbox, and an old
// /inbox?c=<id> link (bookmarks, notifications) opens in its conversation's
// channel inbox. Without a resolvable session it renders the All view.
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const target = await resolveInboxRedirect('all', await searchParams);
  if (target) redirect(target);
  return <InboxView channel="all" />;
}
