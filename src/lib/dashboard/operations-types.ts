export interface DashboardOperations {
  days: number;
  replyTargetMinutes: number;
  attention: { waiting: number; overTarget: number; unassigned: number; expiring: number; failed: number };
  queue: { id: string; name: string; waitingSince: string; closesAt: string; assigned: boolean; handedOff: boolean }[];
  failedMessages: { id: string; conversationId: string; name: string; preview: string; at: string }[];
  team: { id: string; name: string; open: number; replies: number; medianMinutes: number | null }[];
  automated: { replies: number; medianMinutes: number | null };
  pipelines: { id: string; name: string; open: number; won: number; lost: number; idle: number; avgDaysToWin: number | null }[];
  campaigns: { automationRuns: number; automationFailed: number; flowFailed: number; topFailingFlow: string | null; templatesApproved: number; templatesRejected: number };
  latestBroadcast: { id: string; name: string; delivered: number; read: number; replied: number; failed: number } | null;
  setup: { whatsapp: boolean; contacts: boolean; template: boolean; teammate: boolean; conversation: boolean };
}
