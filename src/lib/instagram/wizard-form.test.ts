// The quick-automation wizard form: every box maps to a field the API takes,
// and a refused field the form has no box for is reported, never swallowed.
import { describe, expect, it } from 'vitest';

import { formFieldFor, wizardBody, wizardFormProblem, WIZARD_FORM_FIELDS, type CommentChoices, type WizardId } from './wizard-form';
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

  it('has no box for the body, the wizard or the post scope, so the page shows those as a toast', () => {
    const wizards: WizardId[] = ['comment_links', 'grow_followers', 'story_leads'];
    for (const wizard of wizards) {
      for (const field of ['body', 'wizard', 'post_scope', 'reactions', 'account_id', 'ask_email', 'ask_follow']) {
        expect(formFieldFor(wizard, field)).toBeNull();
      }
    }
    // A story wizard has no comment boxes, and the post picker belongs to the comment wizards.
    expect(formFieldFor('story_leads', 'link_url')).toBeNull();
    expect(formFieldFor('story_leads', 'media_ids')).toBeNull();
    expect(formFieldFor('comment_links', 'media_ids')).toBe('media_ids');
    expect(formFieldFor('comment_links', 'more_links')).toBe('more_links');
    expect(formFieldFor('grow_followers', 'email_prompt')).toBeNull();
  });
});

describe('the body the setup form sends', () => {
  const values = {
    keywords: 'price, link', message: 'Hi', opt_in_label: 'Send it', card_title: 'Here you go', link_label: 'Open', link_url: 'https://x.example',
    email_prompt: 'Email?', email_error: 'Try again', follow_prompt: 'Follow us', followed_label: 'Done',
  };
  const choices: CommentChoices = {
    postScope: 'any', mediaIds: ['999'], words: 'specific', replyOn: true, replies: ['Sent!', ' ', 'DM sent'],
    askEmail: false, askFollow: false, moreLinks: [],
  };

  it('sends the words only for "specific words", and the rotating replies only while the reply switch is on', () => {
    const body = wizardBody('comment_links', values, choices, false);
    expect(body).toMatchObject({ post_scope: 'any', keywords: ['price', 'link'], public_replies: ['Sent!', 'DM sent'] });
    expect(body).not.toHaveProperty('media_ids');
    expect(wizardBody('comment_links', values, { ...choices, words: 'any', replyOn: false }, false))
      .toMatchObject({ keywords: [], public_replies: [] });
  });

  it('sends the chosen posts only for "a specific post or reel"', () => {
    expect(wizardBody('comment_links', values, { ...choices, postScope: 'specific' }, false))
      .toMatchObject({ post_scope: 'specific', media_ids: ['999'] });
  });

  it('sends the email and follow copy only while their switch is on, and drops empty link rows', () => {
    const off = wizardBody('comment_links', values, { ...choices, moreLinks: [{ label: '', url: '' }] }, false);
    expect(off).toMatchObject({ ask_email: false, ask_follow: false, more_links: [] });
    expect(off).not.toHaveProperty('email_prompt');
    expect(off).not.toHaveProperty('follow_prompt');
    const on = wizardBody('comment_links', values,
      { ...choices, askEmail: true, askFollow: true, moreLinks: [{ label: 'Pricing', url: 'https://x.example/p' }] }, false);
    expect(on).toMatchObject({
      ask_email: true, email_prompt: 'Email?', email_error: 'Try again', ask_follow: true, follow_prompt: 'Follow us',
      followed_label: 'Done', more_links: [{ label: 'Pricing', url: 'https://x.example/p' }],
    });
  });

  it('every key the comment-link body carries is one the API accepts', () => {
    const body = wizardBody('comment_links', values,
      { ...choices, postScope: 'specific', askEmail: true, askFollow: true }, false);
    for (const key of Object.keys(body)) expect(WIZARD_FIELDS.comment_links, key).toContain(key);
    for (const key of Object.keys(wizardBody('grow_followers', values, choices, false))) expect(WIZARD_FIELDS.grow_followers, key).toContain(key);
  });

  it('stops before sending when no post is chosen or no word is given', () => {
    expect(wizardFormProblem('comment_links', values, { ...choices, postScope: 'specific', mediaIds: [] }))
      .toEqual({ field: 'media_ids', problem: 'posts' });
    expect(wizardFormProblem('comment_links', { ...values, keywords: ' , ' }, choices)).toEqual({ field: 'keywords', problem: 'keywords' });
    expect(wizardFormProblem('comment_links', values, choices)).toBeNull();
    expect(wizardFormProblem('story_leads', {}, { ...choices, postScope: 'specific', mediaIds: [] })).toBeNull();
  });
});
