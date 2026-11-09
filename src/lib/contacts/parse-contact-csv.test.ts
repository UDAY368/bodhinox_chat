import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: true,
      hasCompanyColumn: false,
      phoneColumn: 'phone',
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
          cells: { phone: '+15551234567', name: 'Alice', tags: 'VIP, Lead' },
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
          cells: { phone: '+15559876543', name: 'Bob', tags: 'Customer' },
        },
      ],
    });
  });

  it('keeps a row with an empty phone cell instead of dropping it silently', () => {
    const csv = `phone,name
+15551234567,Alice
,Bob`;

    const { rows } = parseContactCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      phone: '',
      name: 'Bob',
      email: undefined,
      company: undefined,
      tagNames: [],
      cells: { phone: '', name: 'Bob' },
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: false,
      hasCompanyColumn: false,
      phoneColumn: 'phone',
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
          cells: { phone: '+15551234567', name: 'Alice' },
        },
      ],
    });
  });

  it('accepts common header names and joins first and last name', () => {
    const csv = `Mobile No.,First Name,Last Name,E-mail Address,Organisation,Labels
9876543210,Siobhan,O'Brien,sob@example.com,Acme,"VIP; Lead"`;
    const result = parseContactCsv(csv);
    expect(result).toMatchObject({ hasPhoneColumn: true, hasTagsColumn: true, hasCompanyColumn: true, phoneColumn: 'mobile no.' });
    expect(result.rows[0]).toMatchObject({
      phone: '9876543210',
      name: "Siobhan O'Brien",
      email: 'sob@example.com',
      company: 'Acme',
      tagNames: ['VIP', 'Lead'],
    });
  });

  it.each(['Phone Number', 'WhatsApp', 'whatsapp_number', 'Cell', 'Contact Number'])('finds the phone column under %j', (header) => {
    expect(parseContactCsv(`${header},Name\n+15551234567,A`).rows[0].phone).toBe('+15551234567');
  });

  it('keeps apostrophes in names and companies but drops the export formula guard', () => {
    const csv = `phone,name,company
'+15551234567,D'Souza,"Kelly's ""Best"" Cafe"
+15551234568,'=Boss,'-Minus Ltd`;
    const { rows } = parseContactCsv(csv);
    expect(rows[0]).toMatchObject({ phone: '+15551234567', name: "D'Souza", company: `Kelly's "Best" Cafe` });
    expect(rows[1]).toMatchObject({ name: '=Boss', company: '-Minus Ltd' });
  });

  it('reads a byte-order mark, CRLF, semicolon files and quoted line breaks', () => {
    const csv = '\uFEFFphone;name;company\r\n+15551234567;Alice;"Line one\r\nLine two"\r\n+15551234568;Bob;Acme\r\n';
    const { rows } = parseContactCsv(csv);
    expect(rows.map((r) => [r.phone, r.name, r.company])).toEqual([
      ['+15551234567', 'Alice', 'Line one\r\nLine two'],
      ['+15551234568', 'Bob', 'Acme'],
    ]);
  });

  it('reports a missing phone column', () => {
    expect(parseContactCsv('name,email\nA,a@example.com')).toMatchObject({ hasPhoneColumn: false, rows: [] });
  });
});
