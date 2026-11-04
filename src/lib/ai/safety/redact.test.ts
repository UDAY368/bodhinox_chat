import { describe, expect, it } from 'vitest'
import { ibanValid, luhnValid, redactForProvider, verhoeffValid } from './redact'

const r = (text: string) => redactForProvider(text)

describe('redactForProvider', () => {
  it('masks emails and strips URL query strings', () => {
    expect(r('Mail me at priya.s@example.co.in please').text).toBe('Mail me at [email] please')
    expect(r('See https://shop.example.com/pay?token=abc123&u=9 now').text).toBe('See https://shop.example.com/pay now')
  })

  it('masks phone numbers in E.164 and Indian mobile forms', () => {
    expect(r('Call +91 98765 43210 today').text).toBe('Call [phone] today')
    expect(r('my number is 9876543210').text).toBe('my number is [phone]')
    expect(r('or 98765-43210').text).toBe('or [phone]')
    expect(r('US +1 415 555 0134').text).toBe('US [phone]')
  })

  it('masks + numbers with parentheses and Indian mobiles in any grouping', () => {
    expect(r('call +1 (415) 555 0134 now').text).toBe('call [phone] now')
    expect(r('my mobile 9876 543 210').text).toBe('my mobile [phone]')
    expect(r('or 987 654 3210').text).toBe('or [phone]')
    expect(r('or 98765.43210 please').text).toBe('or [phone] please')
    // Business references keep their digits whatever the grouping.
    expect(r('order 9876 543 210 is late').text).toBe('order 9876 543 210 is late')
  })

  it('keeps order, booking, invoice and AWB numbers', () => {
    for (const text of ['order 9876543210 is late', 'Order #9876543210', 'booking no. 7012345678', 'invoice 8123456789', 'AWB 9123456780 not moving']) {
      const out = r(text)
      expect(out.text).toBe(text)
      expect(out.redacted).toBe(false)
    }
  })

  it('masks Luhn-valid card numbers only', () => {
    expect(r('card 4111 1111 1111 1111 exp 12/29').text).toBe('card [card] exp 12/29')
    expect(r('ref 4111 1111 1111 1112').text).toBe('ref 4111 1111 1111 1112')
  })

  it('masks Verhoeff-valid Aadhaar numbers, PAN and IBAN', () => {
    expect(verhoeffValid('234123412346')).toBe(true)
    expect(r('aadhaar 2341 2341 2346').text).toBe('aadhaar [id]')
    expect(r('aadhaar 2341 2341 2347').text).toBe('aadhaar 2341 2341 2347')
    expect(r('PAN ABCDE1234F').text).toBe('PAN [id]')
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true)
    expect(r('IBAN GB82 WEST 1234 5698 7654 32').text).toBe('IBAN [id]')
  })

  it('masks UPI ids but not emails twice', () => {
    expect(r('pay to ravi.k@okaxis').text).toBe('pay to [upi]')
    expect(r('a@b.com and x@ybl').text).toBe('[email] and [upi]')
  })

  it('masks one-time codes near otp, code or pin', () => {
    expect(r('my OTP is 482913').text).toBe('my OTP is [code]')
    expect(r('482913 is your OTP').text).toContain('[code]')
    expect(r('pin: 4321').text).toBe('pin: [code]')
  })

  it('reports whether anything was masked', () => {
    expect(r('hello, what are your prices?')).toEqual({ text: 'hello, what are your prices?', redacted: false })
    expect(r('x@y.com').redacted).toBe(true)
  })

  it('validates checksums', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('4111111111111112')).toBe(false)
    expect(ibanValid('GB82WEST12345698765433')).toBe(false)
  })
})
