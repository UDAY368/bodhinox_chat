import { redirect } from 'next/navigation';
import { channelPath } from '@/lib/channels/routes';

// /instagram (Stage 5, 5F): the Instagram section opens on its home page.
export default function InstagramIndexPage() {
  redirect(channelPath('instagram', 'home'));
}
