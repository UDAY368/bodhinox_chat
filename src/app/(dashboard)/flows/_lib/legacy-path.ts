// Pure: where an old /flows or /flows/[id] link goes now that each channel has
// its own flows section (Stage 1). Shared by the server redirect and its
// client fallback, so both agree.
import { channelPath, firstEnabledChannel, sectionForFlowScope } from '@/lib/channels/routes';
import type { FlowChannelScope } from '@/lib/flows/types';
import type { Channel } from '@/types';

/**
 * /flows goes to the first enabled channel (WhatsApp first). /flows/[id] goes
 * to the flow's own channel; a legacy 'any' flow to WhatsApp unless only
 * Instagram is enabled; a flow that was not found (null scope) to the first
 * enabled channel, whose editor says so.
 */
export function legacyFlowsPath(enabled: readonly Channel[], flowId?: string,
  scope?: FlowChannelScope | null): string {
  if (!flowId) return channelPath(firstEnabledChannel(enabled), 'flows');
  const channel = scope ? sectionForFlowScope(scope, enabled) : firstEnabledChannel(enabled);
  return channelPath(channel, 'flows', flowId);
}
