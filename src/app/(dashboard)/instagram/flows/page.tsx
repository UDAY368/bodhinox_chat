import { redirect } from 'next/navigation';

// Instagram › Flows moved into the unified Automation list; old links open it filtered to Instagram.
export default function InstagramFlowsPage() {
  redirect('/automation?channel=instagram');
}
