import { describe, expect, it } from 'vitest';
import { attachMenuItems } from './message-composer';

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
