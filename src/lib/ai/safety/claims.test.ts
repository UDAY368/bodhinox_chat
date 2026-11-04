import { describe, expect, it } from 'vitest'
import { checkOutputClaims, failClosedForScript, isHealthBusinessType, MEDICAL_PLACEHOLDER, STATUS_PLACEHOLDER } from './claims'

describe('checkOutputClaims: blocked assertions', () => {
  it.each([
    ['Good news: your payment has been received and confirmed.', 'payment_confirmed'],
    ['We have received your payment.', 'payment_confirmed'],
    ['Payment received, thank you!', 'payment_confirmed'],
    ['Su pago ha sido confirmado.', 'payment_confirmed'],
    ['결제가 완료되었습니다.', 'payment_confirmed'],
    ['Your refund has been processed.', 'refund_processed'],
    ['Your attendance has been marked.', 'attendance_marked'],
    ['Your appointment was marked as attended.', 'appointment_attended'],
    ['Your order has been shipped today.', 'order_shipped'],
    ['We have dispatched your parcel.', 'order_shipped'],
    ['Your package was delivered this morning.', 'order_delivered'],
    ['Seu pedido foi entregue.', 'order_delivered'],
    ['This sounds like a viral infection.', 'medical_diagnosis'],
    ['Take 500 mg of paracetamol three times a day.', 'dosage'],
    ['You should take an antibiotic.', 'treatment_recommendation'],
    ['Our oil cures hair loss.', 'medicinal_claim'],
    ['Clinically proven to work.', 'medicinal_claim'],
    // A conditional word or '?' in another clause does not excuse the claim.
    ['Your order has been shipped and will arrive by Friday.', 'order_shipped'],
    ['Your refund has been processed and should reach your account in 5-7 days.', 'refund_processed'],
    ['Your order was delivered yesterday, is there anything else?', 'order_delivered'],
    // Abbreviation periods do not end the sentence.
    ['Your payment of Rs. 1500 has been received.', 'payment_confirmed'],
    ['Your order no. 4521 has been shipped.', 'order_shipped'],
    // Common phrasings.
    ['Your refund is complete.', 'refund_processed'],
    ['Your package has shipped.', 'order_shipped'],
    ['Your payment is done.', 'payment_confirmed'],
  ])('blocks %j', (text, category) => {
    const out = checkOutputClaims(text)
    expect(out.blocked).toBe(true)
    expect(out.categories).toContain(category)
  })
})

describe('checkOutputClaims: allowed conditional and neutral wording', () => {
  it.each([
    'Once your payment is confirmed, we will ship your order.',
    'We will ship your order as soon as the payment is received.',
    'Your payment has not been received yet.',
    'I will check whether your refund was processed.',
    "We'll let you know when your order has been shipped.",
    'Has your order been delivered?',
    'Please share your order number so a team member can check the delivery status.',
    'Our clinic is open from 9 to 5. A doctor will answer your health question.',
    'The price of the shampoo is 499 rupees.',
    'Your appointment is on Monday at 10am.',
    'We will ship your order once payment has been received.',
    'Can you confirm your order was delivered?',
    'The 2.5 kg pack costs Rs. 1500.',
  ])('allows %j', (text) => {
    expect(checkOutputClaims(text)).toEqual({ blocked: false, categories: [], sanitized: text })
  })
})

describe('checkOutputClaims: staff summaries', () => {
  it('replaces only the offending sentence', () => {
    const out = checkOutputClaims('Customer asked about delivery. Your order has been delivered. They want an invoice.')
    expect(out.sanitized).toBe(`Customer asked about delivery. ${STATUS_PLACEHOLDER} They want an invoice.`)
    const medical = checkOutputClaims('Customer reports a rash. It is likely an allergic reaction.')
    expect(medical.sanitized).toContain(MEDICAL_PLACEHOLDER)
    expect(medical.sanitized).toContain('Customer reports a rash.')
  })
})

describe('fail closed for uncovered scripts', () => {
  it('withholds Telugu output only for health workspaces', () => {
    expect(failClosedForScript('మీ అపాయింట్‌మెంట్ నిర్ధారించబడింది', true)).toBe(true)
    expect(failClosedForScript('మీ అపాయింట్‌మెంట్ నిర్ధారించబడింది', false)).toBe(false)
    expect(failClosedForScript('Your appointment is on Monday', true)).toBe(false)
  })

  it('recognises health business types', () => {
    expect(isHealthBusinessType('Dental clinic')).toBe(true)
    expect(isHealthBusinessType('Ayurveda wellness')).toBe(true)
    expect(isHealthBusinessType('Fashion D2C')).toBe(false)
    expect(isHealthBusinessType(null)).toBe(false)
  })
})
