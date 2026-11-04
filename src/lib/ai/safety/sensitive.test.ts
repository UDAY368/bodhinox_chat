import { describe, expect, it } from 'vitest'
import { classifySensitive, hasUncoveredScript } from './sensitive'

describe('classifySensitive', () => {
  it.each([
    ['I have had a fever and a rash for three days', 'medical_symptom_or_diagnosis'],
    ['Tengo fiebre y dolor de cabeza', 'medical_symptom_or_diagnosis'],
    ['Estou com febre e tosse', 'medical_symptom_or_diagnosis'],
    ['어제부터 두통이 심해요', 'medical_symptom_or_diagnosis'],
    ['mujhe 3 din se bukhar hai', 'medical_symptom_or_diagnosis'],
    ['What dosage of paracetamol should I take?', 'treatment_or_dosage'],
    ['¿Qué dosis debo tomar?', 'treatment_or_dosage'],
    ['Posso tomar antibiótico?', 'treatment_or_dosage'],
    ['무슨 약을 먹어야 해요?', 'treatment_or_dosage'],
    ['kaunsi dawai lu?', 'treatment_or_dosage'],
    ['Does this oil cure hair loss?', 'medicinal_claim'],
    ['I want to end my life', 'emergency_self_harm'],
    ['quiero quitarme la vida', 'emergency_self_harm'],
    ['죽고 싶어요', 'emergency_self_harm'],
    ['I am pregnant, is this safe?', 'pregnancy_child_health'],
    ['estou grávida', 'pregnancy_child_health'],
  ])('flags %j', (text, category) => {
    const out = classifySensitive(text)
    expect(out.sensitive).toBe(true)
    expect(out.categories).toContain(category)
  })

  it.each([
    'What is the price of the hair treatment?',
    'Do you sell baby clothes?',
    'Can I book a facial for Saturday?',
    'My order 12345 has not arrived',
    'Is the painting still available?',
    '',
  ])('does not flag ordinary commerce: %j', (text) => {
    expect(classifySensitive(text)).toEqual({ sensitive: false, categories: [] })
  })
})

describe('hasUncoveredScript', () => {
  it('detects scripts the lexicons do not cover', () => {
    expect(hasUncoveredScript('నాకు జ్వరం ఉంది')).toBe(true) // Telugu
    expect(hasUncoveredScript('मुझे बुखार है')).toBe(true) // Devanagari
    expect(hasUncoveredScript('Hello, 안녕하세요, olá')).toBe(false)
  })
})
