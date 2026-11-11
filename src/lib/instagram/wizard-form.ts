// The Instagram quick-automation wizard form (Instagram › Quick automations):
// which boxes each guided setup shows, and which box a field refused by
// POST /api/instagram/wizards belongs to. Client-safe (no server imports).

export type WizardId = 'comment_links' | 'grow_followers' | 'story_leads';

/** The boxes each wizard's form shows. `public_reply` is one box for the API's `public_replies` list. */
export const WIZARD_FORM_FIELDS: Record<WizardId, readonly string[]> = {
  comment_links: ['keywords', 'public_reply', 'message', 'opt_in_label', 'card_title', 'link_label', 'link_url'],
  grow_followers: ['keywords', 'public_reply', 'message', 'opt_in_label', 'follow_prompt', 'followed_label', 'reward_title',
    'reward_label', 'reward_url'],
  story_leads: ['keywords', 'email_prompt', 'email_error', 'thanks'],
};

/**
 * The form box a refused API field is shown under, or null when the form has
 * no box for it (the body, the wizard, the post choice): the page then shows
 * the error as a toast instead of leaving the dialog silently unchanged.
 */
export function formFieldFor(wizard: WizardId, apiField: string): string | null {
  const box = apiField === 'public_replies' ? 'public_reply' : apiField;
  return WIZARD_FORM_FIELDS[wizard].includes(box) ? box : null;
}
