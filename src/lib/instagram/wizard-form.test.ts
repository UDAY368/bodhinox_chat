// The quick-automation wizard form: every box maps to a field the API takes,
// and a refused field the form has no box for is reported, never swallowed.
import { describe, expect, it } from 'vitest';

import { formFieldFor, WIZARD_FORM_FIELDS, type WizardId } from './wizard-form';
import { INSTAGRAM_WIZARDS, WIZARD_FIELDS } from './wizards';

describe('wizard form fields', () => {
  it('covers exactly the three wizards the API offers', () => {
    expect(Object.keys(WIZARD_FORM_FIELDS).sort()).toEqual([...INSTAGRAM_WIZARDS].sort());
  });

  it.each(INSTAGRAM_WIZARDS.map((w) => [w] as const))('%s: every box is a field the API accepts', (wizard) => {
    for (const box of WIZARD_FORM_FIELDS[wizard]) {
      const apiField = box === 'public_reply' ? 'public_replies' : box;
      expect(WIZARD_FIELDS[wizard], box).toContain(apiField);
      expect(formFieldFor(wizard, apiField)).toBe(box);
    }
  });

  it('has no box for the body, the wizard or the post choice, so the page shows those as a toast', () => {
    const wizards: WizardId[] = ['comment_links', 'grow_followers', 'story_leads'];
    for (const wizard of wizards) {
      for (const field of ['body', 'wizard', 'post_scope', 'media_ids', 'reactions', 'account_id']) {
        expect(formFieldFor(wizard, field)).toBeNull();
      }
    }
    // A story wizard has no comment boxes, and a comment wizard no story boxes.
    expect(formFieldFor('story_leads', 'link_url')).toBeNull();
    expect(formFieldFor('comment_links', 'email_prompt')).toBeNull();
  });
});
