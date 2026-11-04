// Output guard: AI text must never diagnose, prescribe or make medicinal
// claims, and must never ASSERT that a payment was received, a refund was
// processed, attendance was marked, an appointment was attended or an order
// was shipped or delivered. Those statuses come only from the domain tables
// (staff look them up); the AI has no write path to them.
//
// Status claims are checked per sentence (abbreviation and decimal periods
// do not end one), and a claim whose own clause has conditional or future
// wording ("once your payment is confirmed...", "we will ship...", "has not
// been received") or is itself a question is allowed. Medical claims are blocked in any form.
// Covers en, es, pt, ko and common Hinglish. Customer-facing text that trips
// the guard is withheld (guard_blocked); a staff summary gets the sentence
// replaced instead.

import { hasUncoveredScript } from './sensitive';

export const CLAIM_CATEGORIES = [
  'medical_diagnosis', 'dosage', 'treatment_recommendation', 'medicinal_claim',
  'payment_confirmed', 'refund_processed', 'attendance_marked', 'appointment_attended',
  'order_shipped', 'order_delivered',
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

const STATUS: ReadonlySet<ClaimCategory> = new Set(['payment_confirmed', 'refund_processed', 'attendance_marked', 'appointment_attended', 'order_shipped', 'order_delivered']);

const PATTERNS: Array<[ClaimCategory, RegExp]> = [
  ['medical_diagnosis', /\b(?:you|it|this|that)\s+(?:most\s+|very\s+)?(?:probably|likely)?\s*(?:have|has|sounds like|seems like|looks like|is likely|could be|might be|is)\b[^.!?\n]{0,30}\b(?:an?\s+)?(?:infection|virus|viral|flu|diabetes|allergy|allergic reaction|disease|disorder|syndrome|deficiency|cancer|migraine|fever|pneumonia|anxiety disorder|depression)\b/i],
  ['medical_diagnosis', /\b(?:my|the)\s+diagnosis\s+is\b|\byou(?:'re| are)\s+(?:diabetic|anaemic|anemic|hypertensive)\b/i],
  ['dosage', /\b(?:take|dose|dosage|tomar|tome|dosis|dose de)\b[^.!?\n]{0,40}\b\d+(?:[.,]\d+)?\s?(?:mg|ml|mcg|g|iu|tablets?|pills?|capsules?|drops?|pastillas?|comprimidos?|gotas)\b/i],
  ['dosage', /\b\d+(?:[.,]\d+)?\s?(?:mg|ml|mcg)\b[^.!?\n]{0,40}\b(?:times? (?:a|per) day|daily|twice|thrice|veces al d[ií]a|vezes ao dia)\b/i],
  ['dosage', /\d+\s?(?:mg|ml)\s?(?:을|를)?\s?(?:하루|복용)/],
  ['treatment_recommendation', /\b(?:you should|i(?:'d)? recommend|we recommend|i suggest|try|please take|deber[ií]as tomar|te recomiendo|voc[eê] deve tomar|recomendo)\b[^.!?\n]{0,40}\b(?:antibiotics?|paracetamol|ibuprofen|aspirin|steroids?|antihistamines?|medicine|medication|tablets?|antibi[oó]ticos?|medicamento|rem[eé]dio)\b/i],
  ['treatment_recommendation', /(?:약을|항생제를)\s?(?:드세요|복용하세요)|dawai (?:lo|le lo|khao)/i],
  ['medicinal_claim', /\b(?:cures?|heals?|treats?|reverses?|eliminates?|curan?|trata)\s+(?:your\s+|tu\s+|seu\s+|sua\s+)?(?:diabetes|cancer|c[aá]ncer|acne|psoriasis|eczema|infections?|arthritis|thyroid|pcos|hair loss|obesity|disease|enfermedad|doen[cç]a)\b/i],
  ['medicinal_claim', /\b(?:clinically proven|guaranteed (?:cure|results)|100% (?:cure|effective)|cl[ií]nicamente (?:probado|comprovado))\b|완치|pakka ilaa?j/i],
  ['payment_confirmed', /\bpayment\b[^.!?\n]{0,40}\b(?:has been|have been|was|is|got)\s+(?:successfully\s+|now\s+)?(?:received|confirmed|successful|processed|completed|complete|done|credited|verified|approved)\b/i],
  ['payment_confirmed', /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:successfully\s+)?(?:received|confirmed|verified)\s+(?:your\s+|the\s+)?payment\b|\bpayment\s+(?:received|confirmed|successful)\b/i],
  ['payment_confirmed', /\b(?:pago|pagamento)\b[^.!?\n]{0,30}\b(?:(?:ha sido|fue|foi|est[aá])\s+)?(?:recibido|confirmado|recebido|aprovado|aprobado)\b|결제(?:가|는)?\s?(?:완료|확인)되|payment (?:mil gaya|receive ho gaya|aa gaya)/i],
  ['refund_processed', /\brefund\b[^.!?\n]{0,40}\b(?:has been|was|is)\s+(?:successfully\s+|now\s+)?(?:processed|issued|credited|completed|complete|done|sent|initiated)\b|\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:processed|issued)\s+(?:your\s+|the\s+)?refund\b/i],
  ['refund_processed', /\breembolso\b[^.!?\n]{0,30}\b(?:(?:ha sido|fue|foi)\s+)?(?:procesado|processado|emitido|realizado)\b|환불(?:이|은)?\s?(?:처리|완료)되|refund (?:ho gaya|mil gaya)/i],
  ['attendance_marked', /\battendance\b[^.!?\n]{0,30}\b(?:has been|was|is)\s+(?:successfully\s+)?(?:marked|recorded|confirmed)\b|\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+marked\s+(?:you|your attendance)\b|출석(?:이)?\s?(?:처리|확인)되|asistencia (?:ha sido |fue )?(?:marcada|registrada)|presen[cç]a (?:foi )?(?:marcada|registrada)/i],
  ['appointment_attended', /\b(?:you|your (?:appointment|session|visit|consultation))\s+(?:has been|was|is|were)\s+(?:marked\s+)?(?:as\s+)?(?:attended|completed)\b|\byou attended\b/i],
  ['order_shipped', /\b(?:order|package|parcel|shipment|item)s?\b[^.!?\n]{0,40}\b(?:has been|have been|was|is|has|have)\s+(?:successfully\s+|now\s+|already\s+)?(?:shipped|dispatched|sent out|out for delivery|handed to the courier)\b|\b(?:we(?:'ve| have)?)\s+(?:shipped|dispatched)\s+(?:your|the)\b/i],
  ['order_shipped', /\b(?:pedido|encomenda)\b[^.!?\n]{0,30}\b(?:(?:ha sido|fue|foi)\s+)?(?:enviad[oa]|despachad[oa])\b|배송(?:이)?\s?(?:시작|출발)되|order (?:ship|dispatch) ho gaya/i],
  ['order_delivered', /\b(?:order|package|parcel|shipment|item)s?\b[^.!?\n]{0,40}\b(?:has been|have been|was|is)\s+(?:successfully\s+|now\s+)?delivered\b|\b(?:we(?:'ve| have)?)\s+delivered\s+(?:your|the)\b/i],
  ['order_delivered', /\b(?:pedido|encomenda)\b[^.!?\n]{0,30}\b(?:(?:ha sido|fue|foi)\s+)?(?:entregad[oa]|entregue)\b|배송(?:이)?\s?완료|order deliver ho gaya/i],
];

// Conditional, future, negated or request wording: a status sentence with one of these is not an assertion.
const CONDITIONAL = /\b(?:once|when|whenever|after|as soon as|if|until|unless|will|would|should|shall|pending|awaiting|waiting|not yet|yet to|hasn'?t|has not|haven'?t|have not|isn'?t|is not|wasn'?t|was not|cannot|can'?t|could not|unable|confirm whether|let me|please (?:share|send|confirm|make)|expected|estimated|cuando|despu[eé]s|una vez|si se|todav[ií]a no|a[uú]n no|ser[aá]|quando|depois|assim que|se o|ainda n[aã]o|ser[aá]|jab|baad mein|agar|abhi nahi)\b|'ll\b|(?:되면|후에|예정|아직)/i;

// A status match is judged only within its own clause: a conditional word in
// another clause ("...has been shipped and will arrive Friday") does not
// excuse it, and a question mark counts only when the claim's own clause is
// the question.
const CLAUSE_BOUNDARY = /[,;:]|\s(?:and|but|so|y|e|pero|mas|aur|lekin)\s|\s[-–—]\s/gi;

function claimClause(sentence: string, start: number, end: number): string {
  let from = 0;
  let to = sentence.length;
  for (const b of sentence.matchAll(CLAUSE_BOUNDARY)) {
    const at = b.index ?? 0;
    if (at + b[0].length <= start) from = at + b[0].length;
    else if (at >= end) { to = at; break; }
  }
  return sentence.slice(from, to);
}

function conditionalClaim(sentence: string, pattern: RegExp): boolean {
  const m = pattern.exec(sentence);
  if (!m) return false;
  const clause = claimClause(sentence, m.index, m.index + m[0].length);
  return CONDITIONAL.test(clause) || /\?\s*$/.test(clause);
}

export interface ClaimCheck {
  /** True when any claim was found. */
  blocked: boolean;
  categories: ClaimCategory[];
  /** The text with each offending sentence replaced (for staff summaries). */
  sanitized: string;
}

export const STATUS_PLACEHOLDER = '[check the order/payment/appointment record]';
export const MEDICAL_PLACEHOLDER = '[medical content removed: route to qualified staff]';

// A period that does not end a sentence: after a common abbreviation
// ("Rs. 1500", "order no. 4521"), inside a number ("2.5") or before a digit.
const PROTECTED_PERIOD = /\b(Rs|No|Nr|Mr|Mrs|Ms|Dr|St|Inc|Ltd|Co|vs|etc|approx)\.(?=\s*\S)|(?<=\d)\.(?=\d)|\.(?=\s+\d)/gi;
const HELD = '․';

/** Sentences with protected periods held as HELD, so the patterns read across them. */
function sentences(text: string): string[] {
  const held = text.replace(PROTECTED_PERIOD, (_m, abbr?: string) => (abbr ?? '') + HELD);
  return held.match(/[^.!?\n。]+(?:[.!?。]+|\n|$)/g) ?? [held];
}
const restore = (part: string) => part.replaceAll(HELD, '.');

/** Checks AI output for forbidden medical advice and unconditional status claims. */
export function checkOutputClaims(text: string): ClaimCheck {
  const found = new Set<ClaimCategory>();
  const sanitized = sentences(text).map((sentence) => {
    let hit: 'status' | 'medical' | null = null;
    for (const [category, pattern] of PATTERNS) {
      if (!pattern.test(sentence)) continue;
      if (STATUS.has(category)) {
        if (conditionalClaim(sentence, pattern)) continue;
        hit ??= 'status';
      } else hit = 'medical';
      found.add(category);
    }
    if (!hit) return restore(sentence);
    const leading = /^\s*/.exec(sentence)?.[0] ?? '';
    const trailing = /\s*$/.exec(sentence)?.[0] ?? '';
    return leading + (hit === 'medical' ? MEDICAL_PLACEHOLDER : STATUS_PLACEHOLDER) + trailing;
  }).join('').trim();
  const categories = CLAIM_CATEGORIES.filter((c) => found.has(c));
  return { blocked: categories.length > 0, categories, sanitized: categories.length ? sanitized : text };
}

/**
 * Fail closed for scripts the lexicons cannot read: customer-facing output in
 * such a script is withheld (handed off) when the workspace is health-type
 * (appointments feature on, or a health business_type in its agent profile).
 */
export function failClosedForScript(text: string, healthWorkspace: boolean): boolean {
  return healthWorkspace && hasUncoveredScript(text);
}

const HEALTH_BUSINESS = /\b(?:clinic|clinical|hospital|doctor|dental|dentist|physio|therapy|therapist|ayurved|homeopath|pharma|pharmacy|chemist|medical|health|healthcare|wellness|diagnostic|lab|nutrition|dermatolog|skin ?care clinic|ivf|fertility|psycholog|counsel)/i;

/** True for an agent-profile business_type that looks health-related. */
export function isHealthBusinessType(businessType: string | null | undefined): boolean {
  return !!businessType && HEALTH_BUSINESS.test(businessType);
}
