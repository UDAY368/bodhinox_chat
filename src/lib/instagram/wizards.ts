// Instagram quick-automation wizards (Stage 2, plan item 10).
//
// Three guided setups turn a few answers into an ordinary draft Instagram
// flow, editable in the builder afterwards:
//   - comment_links: "Auto-DM links from comments"
//   - grow_followers: "Grow followers from comments" (the follow gate)
//   - story_leads: "Leads from story replies"
// The graphs are the same ones the Instagram starter templates use
// (src/lib/flows/templates.ts), so a wizard draft is a template with the
// customer's own copy and links. Nothing is published or sent here: the draft
// goes through the normal publish validation before it can run.
//
// Every text and link is checked against Instagram's limits
// (src/lib/instagram/graph-limits.ts) so a draft never holds a message Meta
// would refuse. Bodies are strict: unknown fields are refused.

import { Prisma } from '@prisma/client';

import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import {
  commentLinkNodes,
  emailLeadNodes,
  followGateNodes,
  type FlowTemplateNode,
} from '@/lib/flows/templates';
import {
  IG_TRIGGER_LIMITS,
  type FlowTriggerType,
  type IgCommentTriggerConfig,
  type IgPostScope,
  type IgStoryReplyTriggerConfig,
} from '@/lib/flows/types';
import { charLength, INSTAGRAM_LIMITS, validCommentReply, validHttpsUrl, validInstagramText } from './graph-limits';

export const INSTAGRAM_WIZARDS = ['comment_links', 'grow_followers', 'story_leads'] as const;
export type InstagramWizard = (typeof INSTAGRAM_WIZARDS)[number];

/** What a refused field breaks, so the form can say how to fix it. */
export type WizardFieldProblem = 'invalid' | 'keywords' | 'posts' | 'text' | 'button' | 'title' | 'url' | 'publicReply';

export class WizardInputError extends Error {
  constructor(readonly field: string, readonly problem: WizardFieldProblem) {
    super(`Invalid wizard field: ${field}`);
    this.name = 'WizardInputError';
  }
}

interface PostChoice {
  post_scope: IgPostScope;
  media_ids?: string[];
}

export interface CommentLinksInput extends PostChoice {
  wizard: 'comment_links';
  keywords: string[];
  public_replies: string[];
  message: string;
  opt_in_label: string;
  card_title: string;
  link_label: string;
  link_url: string;
}

export interface GrowFollowersInput extends PostChoice {
  wizard: 'grow_followers';
  keywords: string[];
  public_replies: string[];
  message: string;
  opt_in_label: string;
  follow_prompt: string;
  followed_label: string;
  reward_title: string;
  reward_label: string;
  reward_url: string;
}

export interface StoryLeadsInput {
  wizard: 'story_leads';
  keywords: string[];
  reactions: boolean;
  email_prompt: string;
  email_error: string;
  thanks: string;
}

export type WizardInput = CommentLinksInput | GrowFollowersInput | StoryLeadsInput;

/** A draft Instagram flow, in the shape POST /api/flows clones a template into. */
export interface WizardFlowDraft {
  name: string;
  description: string;
  trigger_type: FlowTriggerType;
  trigger_config: IgCommentTriggerConfig | IgStoryReplyTriggerConfig;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
}

const FIELDS: Record<InstagramWizard, readonly string[]> = {
  comment_links: ['wizard', 'post_scope', 'media_ids', 'keywords', 'public_replies', 'message', 'opt_in_label', 'card_title', 'link_label', 'link_url'],
  grow_followers: ['wizard', 'post_scope', 'media_ids', 'keywords', 'public_replies', 'message', 'opt_in_label', 'follow_prompt',
    'followed_label', 'reward_title', 'reward_label', 'reward_url'],
  story_leads: ['wizard', 'keywords', 'reactions', 'email_prompt', 'email_error', 'thanks'],
};

const tDefaults = getT('Instagram.quickAutomations.defaults');
const tWizard = getT('Instagram.quickAutomations');

const isWizard = (value: unknown): value is InstagramWizard =>
  typeof value === 'string' && (INSTAGRAM_WIZARDS as readonly string[]).includes(value);

/** A trimmed string field, or the fallback when absent or blank (null fallback: required). */
function text(body: Record<string, unknown>, field: string, fallback: string | null, fits: (value: string) => boolean,
  problem: WizardFieldProblem): string {
  const raw = body[field];
  if (raw !== undefined && typeof raw !== 'string') throw new WizardInputError(field, problem);
  const value = typeof raw === 'string' ? raw.trim() : '';
  const chosen = value || fallback;
  if (!chosen || !fits(chosen)) throw new WizardInputError(field, problem);
  return chosen;
}

const message = (body: Record<string, unknown>, field: string, fallback: string | null = null) =>
  text(body, field, fallback, validInstagramText, 'text');
const buttonTitle = (body: Record<string, unknown>, field: string, fallback: string | null = null) =>
  text(body, field, fallback, (v) => charLength(v) <= INSTAGRAM_LIMITS.buttonTitleChars, 'button');
const cardTitle = (body: Record<string, unknown>, field: string, fallback: string | null = null) =>
  text(body, field, fallback, (v) => charLength(v) <= INSTAGRAM_LIMITS.cardTitleChars, 'title');
const link = (body: Record<string, unknown>, field: string) => text(body, field, null, validHttpsUrl, 'url');

/** Keywords: distinct (case-insensitive), each 1–100 characters, at most 50; empty matches everything. */
function keywordList(body: Record<string, unknown>, required: boolean): string[] {
  const raw = body.keywords;
  if (raw === undefined && !required) return [];
  if (!Array.isArray(raw) || raw.length > IG_TRIGGER_LIMITS.keywords) throw new WizardInputError('keywords', 'keywords');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new WizardInputError('keywords', 'keywords');
    const keyword = item.trim();
    if (!keyword) continue;
    if (charLength(keyword) > IG_TRIGGER_LIMITS.keywordChars) throw new WizardInputError('keywords', 'keywords');
    if (seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    out.push(keyword);
  }
  return out;
}

/** 0–3 public reply variants; blanks are dropped. */
function publicReplies(body: Record<string, unknown>): string[] {
  const raw = body.public_replies;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > IG_TRIGGER_LIMITS.publicReplies) throw new WizardInputError('public_replies', 'publicReply');
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new WizardInputError('public_replies', 'publicReply');
    const reply = item.trim();
    if (!reply) continue;
    if (!validCommentReply(reply)) throw new WizardInputError('public_replies', 'publicReply');
    out.push(reply);
  }
  return out;
}

/** Which posts the comment trigger listens on: any, the next one, or 1–50 specific media ids. */
function postChoice(body: Record<string, unknown>): PostChoice {
  const scope = body.post_scope ?? 'any';
  if (scope === 'any' || scope === 'next') {
    if (body.media_ids !== undefined) throw new WizardInputError('media_ids', 'posts');
    return { post_scope: scope };
  }
  if (scope !== 'specific') throw new WizardInputError('post_scope', 'posts');
  const ids = body.media_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > IG_TRIGGER_LIMITS.mediaIds ||
    ids.some((id) => typeof id !== 'string' || !/^\d{1,32}$/.test(id))) throw new WizardInputError('media_ids', 'posts');
  return { post_scope: 'specific', media_ids: [...new Set(ids as string[])] };
}

/**
 * A wizard body → its answers, or WizardInputError naming the first bad
 * field. Optional copy (button labels, card titles, the email error) falls
 * back to the localized defaults; links and the main messages are required.
 */
export function parseWizardInput(body: unknown): WizardInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WizardInputError('body', 'invalid');
  const input = body as Record<string, unknown>;
  if (!isWizard(input.wizard)) throw new WizardInputError('wizard', 'invalid');
  const wizard = input.wizard;
  const unknown = Object.keys(input).find((key) => !FIELDS[wizard].includes(key));
  if (unknown) throw new WizardInputError(unknown, 'invalid');

  if (wizard === 'comment_links') {
    const d = (key: string) => tDefaults(`commentLinks.${key}`);
    return {
      wizard,
      ...postChoice(input),
      keywords: keywordList(input, false),
      public_replies: publicReplies(input),
      message: message(input, 'message'),
      opt_in_label: buttonTitle(input, 'opt_in_label', d('optInLabel')),
      card_title: cardTitle(input, 'card_title', d('cardTitle')),
      link_label: buttonTitle(input, 'link_label', d('linkLabel')),
      link_url: link(input, 'link_url'),
    };
  }
  if (wizard === 'grow_followers') {
    const d = (key: string) => tDefaults(`growFollowers.${key}`);
    return {
      wizard,
      ...postChoice(input),
      keywords: keywordList(input, false),
      public_replies: publicReplies(input),
      message: message(input, 'message'),
      opt_in_label: buttonTitle(input, 'opt_in_label', d('optInLabel')),
      follow_prompt: message(input, 'follow_prompt', d('followPrompt')),
      followed_label: buttonTitle(input, 'followed_label', d('followedButton')),
      reward_title: cardTitle(input, 'reward_title', d('rewardTitle')),
      reward_label: buttonTitle(input, 'reward_label', d('rewardButton')),
      reward_url: link(input, 'reward_url'),
    };
  }
  const reactions = input.reactions ?? false;
  if (typeof reactions !== 'boolean') throw new WizardInputError('reactions', 'invalid');
  return {
    wizard,
    keywords: keywordList(input, false),
    reactions,
    email_prompt: message(input, 'email_prompt'),
    email_error: message(input, 'email_error', tDefaults('storyLeads.emailError')),
    thanks: message(input, 'thanks'),
  };
}

function commentTrigger(input: CommentLinksInput | GrowFollowersInput, now: Date): IgCommentTriggerConfig {
  return {
    post_scope: input.post_scope,
    ...(input.post_scope === 'specific' ? { media_ids: input.media_ids } : {}),
    // The next post is the first one published after this choice (the engine resolves it on its first comment).
    ...(input.post_scope === 'next' ? { next_after: now.toISOString() } : {}),
    ...(input.keywords.length ? { include_keywords: input.keywords, include_mode: 'contains' as const } : {}),
    ...(input.public_replies.length ? { public_replies: input.public_replies } : {}),
  };
}

const WIZARD_TITLE_KEY: Record<InstagramWizard, string> = {
  comment_links: 'commentLinks',
  grow_followers: 'growFollowers',
  story_leads: 'storyLeads',
};

function flowName(input: WizardInput): string {
  const title = tWizard(`${WIZARD_TITLE_KEY[input.wizard]}.title`);
  const name = input.keywords.length ? tWizard('flowName', { title, keyword: input.keywords[0] }) : title;
  return [...name].slice(0, 120).join('');
}

/** The answers → a draft Instagram flow (pure; `now` fixes the "next post" cut-off). */
export function buildWizardFlow(input: WizardInput, now: Date = new Date()): WizardFlowDraft {
  const base = {
    name: flowName(input),
    description: tWizard(`${WIZARD_TITLE_KEY[input.wizard]}.description`),
    entry_node_id: 'start',
  };
  switch (input.wizard) {
    case 'comment_links':
      return {
        ...base,
        trigger_type: 'ig_comment',
        trigger_config: commentTrigger(input, now),
        nodes: commentLinkNodes({
          opening: input.message, optInLabel: input.opt_in_label, cardTitle: input.card_title,
          buttonLabel: input.link_label, url: input.link_url,
        }),
      };
    case 'grow_followers':
      return {
        ...base,
        trigger_type: 'ig_comment',
        trigger_config: commentTrigger(input, now),
        nodes: followGateNodes({
          opening: input.message, optInLabel: input.opt_in_label, followPrompt: input.follow_prompt,
          followedLabel: input.followed_label, rewardTitle: input.reward_title, rewardButton: input.reward_label,
          rewardUrl: input.reward_url,
        }),
      };
    case 'story_leads':
      return {
        ...base,
        trigger_type: 'ig_story_reply',
        trigger_config: {
          ...(input.keywords.length ? { keywords: input.keywords, match_mode: 'contains' as const } : {}),
          reactions: input.reactions,
        },
        nodes: emailLeadNodes({ askEmail: input.email_prompt, emailError: input.email_error, thanks: input.thanks }),
      };
  }
}

export interface CreatedWizardFlow {
  id: string;
  name: string;
  status: string;
  channel_scope: string;
}

/**
 * Saves the draft as a new Instagram flow and its steps in the caller's
 * transaction (withTenant), so a failure leaves no half-made flow. RLS and
 * the flow write policy apply to both inserts; `account_id` is the tenant's.
 */
export async function createWizardFlow(
  tx: TenantTransaction,
  owner: { accountId: string; userId: string },
  draft: WizardFlowDraft,
): Promise<CreatedWizardFlow> {
  const [flow] = await tx.$queryRaw<CreatedWizardFlow[]>(Prisma.sql`
    INSERT INTO flows (account_id, user_id, name, description, status, trigger_type, trigger_config, entry_node_id, channel_scope)
    VALUES (${owner.accountId}::uuid, ${owner.userId}::uuid, ${draft.name}, ${draft.description}, 'draft',
      ${draft.trigger_type}, ${JSON.stringify(draft.trigger_config)}::jsonb, ${draft.entry_node_id}, 'instagram')
    RETURNING id::text, name, status, channel_scope`);
  const nodes = draft.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config }));
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO flow_nodes (account_id, flow_id, node_key, node_type, config)
    SELECT ${owner.accountId}::uuid, ${flow.id}::uuid, n.node_key, n.node_type, n.config
    FROM jsonb_to_recordset(${JSON.stringify(nodes)}::jsonb) AS n(node_key text, node_type text, config jsonb)`);
  return flow;
}
