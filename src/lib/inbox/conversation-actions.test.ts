import { describe, expect, it } from 'vitest';
import { conversationCsv, exportFileName, EXPORT_MESSAGE_LIMIT } from './conversation-actions';

const row = (over: Partial<Parameters<typeof conversationCsv>[0][number]> = {}) => ({
  created_at: new Date('2026-11-13T10:00:00Z'),
  sender_type: 'customer',
  sender_name: null,
  content_type: 'text',
  content_text: 'Hello',
  media_url: null,
  status: 'read',
  ...over,
});

describe('conversationCsv', () => {
  it('writes a header and one quoted row per message', () => {
    const csv = conversationCsv([row(), row({ sender_type: 'agent', sender_name: 'Asha', content_text: 'Hi "there"' })], { mask: false, truncated: false });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('"Time","From","Sender","Type","Text","Attachment","Status"');
    expect(lines[1]).toBe('"2026-11-13T10:00:00.000Z","Customer","","text","Hello","","read"');
    expect(lines[2]).toContain('"Team","Asha"');
    expect(lines[2]).toContain('"Hi ""there"""');
  });

  it('neutralises spreadsheet formulas and marks attachments', () => {
    const csv = conversationCsv([row({ content_text: '=SUM(A1)', media_url: 'https://x/y.png' })], { mask: false, truncated: false });
    expect(csv).toContain(`"'=SUM(A1)"`);
    expect(csv).toContain('"yes"');
  });

  it('masks phone numbers for a masked member and notes a cut-off export', () => {
    const csv = conversationCsv([row({ content_text: 'Call +91 98765 43210' })], { mask: true, truncated: true });
    expect(csv).not.toContain('98765 43210');
    expect(csv).toContain(String(EXPORT_MESSAGE_LIMIT));
  });
});

describe('exportFileName', () => {
  it('makes a safe slug from the contact name', () => {
    expect(exportFileName('Ravi Kumar')).toBe('ravi-kumar.csv');
    expect(exportFileName('../"evil"\r\n')).toBe('evil.csv');
    expect(exportFileName(null)).toBe('chat.csv');
    expect(exportFileName('अनु')).toBe('chat.csv');
  });
});
