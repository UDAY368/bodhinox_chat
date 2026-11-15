import { describe, expect, it } from 'vitest';
import { encodeQr, formatBits, QrTooLongError, qrSvgPath, rsDivisor, rsRemainder, versionBits } from './encode';

describe('QR encoder', () => {
  it('computes Reed-Solomon error correction like the standard (HELLO WORLD, 1-M)', () => {
    // The worked example from the ISO standard tutorials: 16 data codewords, 10 ECC codewords.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('writes the standard format bits for level M and every mask', () => {
    const table = ['101010000010010', '101000100100101', '101111001111100', '101101101001011',
      '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
    table.forEach((bits, mask) => expect(formatBits(mask).toString(2).padStart(15, '0')).toBe(bits));
  });

  it('writes the standard version bits', () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(8)).toBe(0x085bc);
    expect(versionBits(9)).toBe(0x09a99);
    expect(versionBits(10)).toBe(0x0a4d3);
  });

  it('draws finder patterns, timing and the dark module, sized by the text', () => {
    const url = 'https://app.bodhinox.com/s/kumar-ayurveda';
    const m = encodeQr(url);
    expect(m.length).toBe(29); // 41 bytes: version 3 at level M holds up to 42
    const finderAt = (x: number, y: number) => {
      for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        expect(m[y + dy][x + dx]).toBe(ring !== 2);
      }
    };
    finderAt(0, 0);
    finderAt(m.length - 7, 0);
    finderAt(0, m.length - 7);
    for (let i = 8; i < m.length - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
    expect(m[m.length - 8][8]).toBe(true);
    // Deterministic, and the two copies of the format bits agree.
    expect(encodeQr(url)).toEqual(m);
    const first = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => m[y][8]);
    const second = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => m[8][m.length - 1 - i]);
    expect(first).toEqual(second);
  });

  it('grows the version with the text and refuses text that does not fit version 10', () => {
    expect(encodeQr('a').length).toBe(21);
    expect(encodeQr('x'.repeat(200)).length).toBe(57);
    expect(() => encodeQr('x'.repeat(400))).toThrow(QrTooLongError);
  });

  it('draws one path with a quiet zone', () => {
    const path = qrSvgPath([[true, false], [false, true]], 4);
    expect(path).toBe('M4 4h1v1h-1zM5 5h1v1h-1z');
  });
});
