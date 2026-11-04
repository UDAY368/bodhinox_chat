import { describe, expect, it } from 'vitest';
import { assistResetOnSwitch, attachMenuItems } from './message-composer';

describe('attachMenuItems', () => {
  it('hides the Ogg/Opus voice note and the media library on Instagram', () => {
    const items = attachMenuItems(true);
    expect(items).not.toContain('voiceNote');
    expect(items).not.toContain('mediaLibrary');
    expect(items).toEqual(['photo', 'video', 'document']);
  });

  it('keeps every WhatsApp attachment, voice note included', () => {
    expect(attachMenuItems(false)).toEqual(['photo', 'video', 'document', 'voiceNote', 'mediaLibrary']);
  });
});

describe('assistResetOnSwitch', () => {
  it('closes the suggestions panel and drops the suggestion and its text on a conversation switch', () => {
    // An open panel would otherwise remount for the next conversation and generate unasked.
    expect(assistResetOnSwitch('conv-a', 'conv-b')).toEqual({ suggestionsOpen: false, aiSuggestionId: null, text: '' });
  });

  it('keeps everything while the conversation is the same', () => {
    expect(assistResetOnSwitch('conv-a', 'conv-a')).toBeNull();
  });
});
