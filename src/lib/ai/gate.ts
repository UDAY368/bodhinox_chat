// Deployment-level AI kill switch: the one choke point every provider call
// passes. generateReply (chat) and embedTexts (embeddings) call
// assertProviderCallAllowed() before any HTTP request, so no path, old or
// new, can reach a provider while the switch is off.
//
// AI_ENABLED is an EMERGENCY switch, on by default: existing workspaces that
// configured their own keys keep auto-reply, drafts and flow AI working.
// Setting AI_ENABLED to false, 0 or off (any case) stops every outbound AI
// call at once. The Phase 13 assistant features are additionally off per
// workspace until an admin turns them on (ai_workspace_settings) and need a
// configured key, so deploying them changes nothing by itself.

import { assertLiveEffects } from '@/lib/runtime/dry-run-guard';
import { AiError } from './types';

const OFF_VALUES = new Set(['false', '0', 'off']);

/** False only when AI_ENABLED is explicitly false, 0 or off (case-insensitive). */
export function aiDeploymentEnabled(): boolean {
  const raw = process.env.AI_ENABLED;
  if (raw === undefined) return true;
  return !OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Throws before any provider HTTP request when the deployment switch is off
 * (AiError ai_disabled, 503), and inside a flow dry run
 * (DryRunSideEffectError), so a preview can never reach a paid provider.
 */
export function assertProviderCallAllowed(): void {
  if (!aiDeploymentEnabled()) {
    throw new AiError('AI is turned off on this deployment.', { code: 'ai_disabled', status: 503 });
  }
  assertLiveEffects('fetch');
}
