// The Instagram quick-automation wizard form (Instagram › Quick automations):
// which boxes each guided setup shows, and which box a field refused by
// POST /api/instagram/wizards belongs to. Client-safe (no server imports).

export type WizardId = 'comment_links' | 'grow_followers' | 'story_leads';

/**
 * The boxes each wizard's form shows. `public_reply` is one box for the API's
 * `public_replies` list; `media_ids` is the post/reel picker; `more_links`
 * the extra link rows.
 */
export const WIZARD_FORM_FIELDS: Record<WizardId, readonly string[]> = {
  comment_links: ['media_ids', 'keywords', 'public_reply', 'message', 'opt_in_label', 'email_prompt', 'email_error', 'follow_prompt',
    'followed_label', 'card_title', 'link_label', 'link_url', 'more_links'],
  grow_followers: ['media_ids', 'keywords', 'public_reply', 'message', 'opt_in_label', 'follow_prompt', 'followed_label', 'reward_title',
    'reward_label', 'reward_url'],
  story_leads: ['keywords', 'email_prompt', 'email_error', 'thanks'],
};

/**
 * The form box a refused API field is shown under, or null when the form has
 * no box for it (the body, the wizard, the post scope): the page then shows
 * the error as a toast instead of leaving the dialog silently unchanged.
 */
export function formFieldFor(wizard: WizardId, apiField: string): string | null {
  const box = apiField === 'public_replies' ? 'public_reply' : apiField;
  return WIZARD_FORM_FIELDS[wizard].includes(box) ? box : null;
}

/** What a refused field breaks (as POST /api/instagram/wizards reports it). */
export type FieldProblem = 'invalid' | 'keywords' | 'posts' | 'text' | 'button' | 'title' | 'url' | 'publicReply';

export type PostScope = 'specific' | 'any' | 'next';
export type LinkRow = { label: string; url: string };

/** Comment setups: everything beyond the plain text boxes. */
export interface CommentChoices {
  postScope: PostScope;
  mediaIds: string[];
  /** 'any' answers every comment; 'specific' needs at least one word. */
  words: 'specific' | 'any';
  replyOn: boolean;
  /** 1–3 public replies that rotate. */
  replies: string[];
  askEmail: boolean;
  askFollow: boolean;
  /** Up to 2 links after the first one. */
  moreLinks: LinkRow[];
}

/** "a, b ,c" → ["a","b","c"] */
export const keywordList = (value: string): string[] => value.split(',').map((k) => k.trim()).filter(Boolean);

const isCommentWizard = (wizard: WizardId) => wizard !== 'story_leads';

/**
 * The POST /api/instagram/wizards body for the form (pure, so the mapping is
 * unit-tested). Optional steps send their copy only while switched on.
 */
export function wizardBody(wizard: WizardId, values: Record<string, string>, choices: CommentChoices, reactions: boolean): Record<string, unknown> {
  const v = (name: string) => values[name] ?? '';
  if (wizard === 'story_leads') {
    return { wizard, keywords: keywordList(v('keywords')), reactions, email_prompt: v('email_prompt'), email_error: v('email_error'), thanks: v('thanks') };
  }
  const common = {
    wizard,
    post_scope: choices.postScope,
    ...(choices.postScope === 'specific' ? { media_ids: choices.mediaIds } : {}),
    keywords: choices.words === 'specific' ? keywordList(v('keywords')) : [],
    public_replies: choices.replyOn ? choices.replies.map((r) => r.trim()).filter(Boolean) : [],
    message: v('message'),
    opt_in_label: v('opt_in_label'),
  };
  if (wizard === 'comment_links') {
    return {
      ...common,
      card_title: v('card_title'), link_label: v('link_label'), link_url: v('link_url'),
      more_links: choices.moreLinks.filter((l) => l.label.trim() || l.url.trim()),
      ask_email: choices.askEmail,
      ...(choices.askEmail ? { email_prompt: v('email_prompt'), email_error: v('email_error') } : {}),
      ask_follow: choices.askFollow,
      ...(choices.askFollow ? { follow_prompt: v('follow_prompt'), followed_label: v('followed_label') } : {}),
    };
  }
  return {
    ...common, follow_prompt: v('follow_prompt'), followed_label: v('followed_label'), reward_title: v('reward_title'),
    reward_label: v('reward_label'), reward_url: v('reward_url'),
  };
}

/** A problem the form can see before sending (the server checks again), or null. */
export function wizardFormProblem(wizard: WizardId, values: Record<string, string>, choices: CommentChoices): { field: string; problem: FieldProblem } | null {
  if (!isCommentWizard(wizard)) return null;
  if (choices.postScope === 'specific' && choices.mediaIds.length === 0) return { field: 'media_ids', problem: 'posts' };
  if (choices.words === 'specific' && keywordList(values.keywords ?? '').length === 0) return { field: 'keywords', problem: 'keywords' };
  return null;
}
