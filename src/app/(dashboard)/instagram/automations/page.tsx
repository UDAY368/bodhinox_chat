import { AutomationList } from '@/components/automations/automation-list';

// Instagram › Automations: only Instagram automations (the instagram layout gates the section).
export default function InstagramAutomationsPage() {
  return <AutomationList channel="instagram" />;
}
