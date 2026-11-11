import { describe, expect, it, vi } from 'vitest';
import {
  buildAppendRequest, buildReadRequest, buildUpdateRequest, columnIndex, columnLetter, findRow, idTokenEmail, isSheetName, isSpreadsheetId,
  needsHeader, quoteSheet, resolveColumn, rowFor, sheetsCall, SheetsHttpError, tokenRequest,
} from './api';
import { readSheetsState, signSheetsState } from './connection';

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('request builders', () => {
  it('always target the fixed Sheets host with RAW input', () => {
    const append = buildAppendRequest(SHEET_ID, "Leads 'May'", ['a', '=HYPERLINK("x")']);
    expect(append.url.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/`)).toBe(true);
    expect(append.url).toContain('valueInputOption=RAW');
    expect(decodeURIComponent(append.url)).toContain("'Leads ''May'''!A1");
    expect(append.body).toEqual({ majorDimension: 'ROWS', values: [['a', '=HYPERLINK("x")']] });
    expect(buildReadRequest(SHEET_ID, 'Leads', 2000).method).toBe('GET');
    const update = buildUpdateRequest(SHEET_ID, 'Leads', 7, [{ index: 0, value: 'x' }, { index: 27, value: 'y' }]);
    expect(update.body).toMatchObject({ valueInputOption: 'RAW', data: [{ range: "'Leads'!A7" }, { range: "'Leads'!AB7" }] });
  });
  it('columns resolve by letter or by header, case-insensitively', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('AA')).toBe(26);
    expect(columnLetter(26)).toBe('AA');
    expect(resolveColumn('C', [])).toBe(2);
    expect(resolveColumn(' email ', ['Name', 'Email'])).toBe(1);
    expect(resolveColumn('Phone', ['Name'])).toBeNull();
    expect(needsHeader(['A', 'B'])).toBe(false);
    expect(needsHeader(['A', 'Email'])).toBe(true);
  });
  it('rows place values under their columns and lookups skip the header', () => {
    expect(rowFor([{ index: 2, value: 'c' }, { index: 0, value: 'a' }])).toEqual(['a', '', 'c']);
    const rows = [['Email'], ['x@y.example'], ['A@B.example']];
    expect(findRow(rows, 0, 'a@b.example')).toBe(3);
    expect(findRow(rows, 0, 'Email')).toBeNull();
    expect(findRow(rows, 0, ' ')).toBeNull();
  });
  it('validates ids and sheet names and quotes names', () => {
    expect(isSpreadsheetId(SHEET_ID)).toBe(true);
    expect(isSpreadsheetId('../etc')).toBe(false);
    expect(isSheetName('Leads')).toBe(true);
    expect(isSheetName('a/b')).toBe(false);
    expect(isSheetName(' padded')).toBe(false);
    expect(quoteSheet("it's")).toBe("'it''s'");
  });
});

describe('HTTP calls', () => {
  it('refuses any other host and never follows redirects', async () => {
    const fetcher = vi.fn(async () => json(200, {}));
    await expect(sheetsCall('t', { method: 'GET', url: 'https://evil.example/v4' }, fetcher)).rejects.toThrow('host refused');
    expect(fetcher).not.toHaveBeenCalled();
    await sheetsCall('t', buildReadRequest(SHEET_ID, 'Leads', 1), fetcher);
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/sheets\.googleapis\.com\//), expect.objectContaining({ redirect: 'error' }));
  });
  it('maps an HTTP error to SheetsHttpError with the status', async () => {
    await expect(sheetsCall('t', buildReadRequest(SHEET_ID, 'Leads', 1), vi.fn(async () => json(403, { error: { status: 'PERMISSION_DENIED' } }))))
      .rejects.toMatchObject({ status: 403, reason: 'PERMISSION_DENIED' });
    await expect(tokenRequest({ grant_type: 'refresh_token' }, vi.fn(async () => json(400, { error: 'invalid_grant' }))))
      .rejects.toBeInstanceOf(SheetsHttpError);
  });
  it('reads a verified email from the id token only', () => {
    const token = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    expect(idTokenEmail(token({ email: 'Owner@Shop.example', email_verified: true }))).toBe('owner@shop.example');
    expect(idTokenEmail(token({ email: 'owner@shop.example', email_verified: false }))).toBeNull();
    expect(idTokenEmail('garbage')).toBeNull();
  });
});

describe('OAuth state cookie', () => {
  const state = { nonce: 'n'.repeat(24), accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
    expiresAt: Date.now() + 60_000, verifier: 'v'.repeat(64) };
  it('round-trips a signed state and refuses a tampered or foreign one', () => {
    const cookie = signSheetsState('secret-a', state);
    expect(readSheetsState('secret-a', cookie)).toEqual(state);
    expect(readSheetsState('secret-b', cookie)).toBeNull();
    const [body, mac] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), a: '33333333-3333-4333-8333-333333333333' })).toString('base64url');
    expect(readSheetsState('secret-a', `${forged}.${mac}`)).toBeNull();
    expect(readSheetsState('secret-a', null)).toBeNull();
  });
});
