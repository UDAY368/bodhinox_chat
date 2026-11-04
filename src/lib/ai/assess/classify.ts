// Deterministic pre-classifier and lead score for advisory assessments.
//
// The keyword classifier always runs, so a conversation gets an intent even
// when the model is unavailable (that result is stored with
// source='deterministic' and no lead score). The lead score is computed HERE,
// in code, from qualification flags plus CRM facts; the model never outputs
// the number. Nothing in this module reads or writes anything.

import { classifySensitive, type SensitiveCategory } from '../safety/sensitive';

export const ASSESS_INTENTS = [
  'pricing', 'purchase', 'booking', 'support', 'order_status', 'complaint', 'sensitive_health', 'other', 'unknown',
] as const;
export type AssessIntent = (typeof ASSESS_INTENTS)[number];

export const QUALIFICATION_FLAGS = [
  'asked_price', 'purchase_intent', 'booking_intent', 'timeline_mentioned', 'budget_mentioned', 'decision_maker', 'complaint',
] as const;
export type QualificationFlag = (typeof QUALIFICATION_FLAGS)[number];
export type QualificationFlags = Record<QualificationFlag, boolean>;

const b = (words: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${words})(?=$|[^\\p{L}\\p{N}])`, 'iu');
const any = (words: string) => new RegExp(`(?:${words})`, 'iu'); // Korean has no word spacing to anchor on

type KeywordIntent = Exclude<AssessIntent, 'sensitive_health' | 'other' | 'unknown'>;

// en, es, pt, ko and common Hinglish. Checked in this order: the first match wins.
const INTENT_LEXICON: [KeywordIntent, RegExp[]][] = [
  ['complaint', [
    b('complain(?:t|ts|ing|ed)?|refund|money back|not happy|unhappy|terrible|worst|disappointed|bad service|damaged|broken|defective|wrong (?:item|product|order|size)|cheated|fraud|scam|angry|never again'),
    b('queja|reclamo|reembolso|mal servicio|da[ñn]ado|defectuoso|decepcionad[oa]|estafa'),
    b('reclama[cç][aã]o|reembolso|p[eé]ssimo|danificado|com defeito|decepcionad[oa]|golpe'),
    any('환불|불만|불량|실망|파손'),
    b('bekar|bakwas|paisa wapas|refund chahiye|kharab (?:aaya|hai|nikla)|dhokha'),
  ]],
  ['order_status', [
    b('where is my (?:order|parcel|package|delivery)|order status|track(?:ing)?(?: (?:id|number|link))?|delivery status|not (?:yet )?(?:delivered|received|arrived)|when will (?:it|my order|my parcel) (?:arrive|come|be delivered)|shipped yet|dispatched yet|awb'),
    b('mi pedido|estado del pedido|seguimiento|no ha llegado|cu[aá]ndo llega'),
    b('meu pedido|status do pedido|rastreio|rastreamento|n[aã]o chegou|quando chega'),
    any('배송 조회|배송 언제|주문 상태|언제 도착|송장'),
    b('order kab|parcel kab|delivery kab|order kahan|abhi tak nahi aaya'),
  ]],
  ['purchase', [
    b('buy|purchase|order (?:now|it|this|one|two)|i want to order|i(?:\'d| would) like to order|place an order|add to cart|checkout|in stock|cash on delivery|cod available|ship (?:it )?to'),
    b('comprar|quiero (?:pedir|ordenar|uno|este|esta)|hacer un pedido|en stock'),
    b('comprar|quero (?:pedir|encomendar|um|uma|esse|essa)|fazer um pedido|em estoque'),
    any('구매|주문하고 싶|살게요|사고 싶'),
    b('lena hai|order karna|kharidna|bhej do'),
  ]],
  ['booking', [
    b('book(?:ing)?|appointment|reserve|reservation|schedule a|reschedule|slot|availability|available (?:on|at|tomorrow|today|this)'),
    b('cita|reservar|reserva|agendar|horario disponible'),
    b('agendar|agendamento|marcar (?:uma )?(?:hora|consulta|hor[aá]rio)|reserva|hor[aá]rio dispon[ií]vel'),
    any('예약|일정 잡'),
    b('appointment chahiye|slot milega|book karna|book kar do'),
  ]],
  ['pricing', [
    b('price|prices|pricing|cost|costs|how much|rates?|fees?|charges?|quote|quotation|discount|offer|cheaper|mrp'),
    b('precio|precios|cu[aá]nto (?:cuesta|vale)|costo|tarifa|descuento|oferta'),
    b('pre[cç]os?|quanto custa|valor|custo|desconto|or[cç]amento|promo[cç][aã]o'),
    any('가격|얼마|비용|할인|견적'),
    b('kitne ka|kitna (?:hai|price|lagega|padega)|rate kya|price kya|kya rate|daam'),
  ]],
  ['support', [
    b('help|issue|problem|not working|doesn\'?t work|error|how (?:do|can) i|can you help|support|question'),
    b('ayuda|problema|no funciona|c[oó]mo puedo'),
    b('ajuda|problema|n[aã]o funciona|como (?:eu )?posso'),
    any('도움|문제|작동하지|오류|어떻게 하'),
    b('madad|problem hai|kaam nahi kar'),
  ]],
];

const TIMELINE = [
  b('today|tomorrow|tonight|this (?:week|weekend|month)|next (?:week|month)|asap|urgent(?:ly)?|right away|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|within \\d+ days?'),
  b('hoy|ma[ñn]ana|esta semana|urgente|lo antes posible'),
  b('hoje|amanh[aã]|esta semana|urgente|o quanto antes'),
  any('오늘|내일|이번 주|급해'),
  b('aaj|kal tak|jaldi|turant'),
];
const BUDGET = [
  b('budget|under (?:rs\\.? ?|₹ ?)?\\d+|within (?:rs\\.? ?|₹ ?)?\\d+|\\d+ ?(?:rs|rupees|inr|k budget)'),
  /₹\s?\d/u,
  b('presupuesto|or[cç]amento de'),
  any('예산'),
];
const DECISION_MAKER = [
  b('i (?:will|can) decide|i(?:\'m| am) the owner|for my (?:shop|store|clinic|salon|business|company)|we (?:need|want) \\d+|bulk order|wholesale'),
];

const matches = (lexicon: RegExp[], text: string) => lexicon.some((re) => re.test(text));

export interface TranscriptMessage {
  id: string;
  sender: 'customer' | 'agent' | 'bot';
  text: string;
  createdAt: string;
}

export interface DeterministicAssessment {
  intent: AssessIntent;
  confidence: number;
  flags: QualificationFlags;
  /** Health categories found in the latest customer turns (routes to staff). */
  sensitiveCategories: SensitiveCategory[];
  /** Ids of the customer messages the intent came from. */
  evidenceIds: string[];
}

/** Customer turns considered for intent, newest first. */
export const INTENT_WINDOW = 5;
/** Customer turns checked for health topics, newest first. */
export const SENSITIVE_WINDOW = 3;

/**
 * Keyword intent and qualification flags for a chronological transcript.
 * Health topics in the latest customer turns win (staff must answer those);
 * otherwise the newest customer turn with a keyword match decides.
 */
export function classifyDeterministic(messages: readonly TranscriptMessage[]): DeterministicAssessment {
  const customer = messages.filter((m) => m.sender === 'customer' && m.text.trim());
  const newest = [...customer].reverse();
  const flags = qualificationFlags(customer.map((m) => m.text));
  if (!newest.length) return { intent: 'unknown', confidence: 0, flags, sensitiveCategories: [], evidenceIds: [] };

  const sensitive = new Set<SensitiveCategory>();
  const sensitiveIds: string[] = [];
  for (const m of newest.slice(0, SENSITIVE_WINDOW)) {
    const r = classifySensitive(m.text);
    if (!r.sensitive) continue;
    r.categories.forEach((c) => sensitive.add(c));
    sensitiveIds.push(m.id);
  }
  if (sensitive.size)
    return { intent: 'sensitive_health', confidence: 90, flags, sensitiveCategories: [...sensitive], evidenceIds: sensitiveIds };

  for (const m of newest.slice(0, INTENT_WINDOW)) {
    const hits = INTENT_LEXICON.filter(([, lexicon]) => matches(lexicon, m.text)).map(([intent]) => intent);
    if (hits.length) return { intent: hits[0], confidence: hits.length === 1 ? 70 : 55, flags, sensitiveCategories: [], evidenceIds: [m.id] };
  }
  return { intent: 'other', confidence: 30, flags, sensitiveCategories: [], evidenceIds: [] };
}

/** Qualification signals across the customer's turns. */
export function qualificationFlags(customerTexts: readonly string[]): QualificationFlags {
  const has = (intent: KeywordIntent) => customerTexts.some((t) => matches(INTENT_LEXICON.find(([i]) => i === intent)![1], t));
  return {
    asked_price: has('pricing'),
    purchase_intent: has('purchase'),
    booking_intent: has('booking'),
    timeline_mentioned: customerTexts.some((t) => matches(TIMELINE, t)),
    budget_mentioned: customerTexts.some((t) => matches(BUDGET, t)),
    decision_maker: customerTexts.some((t) => matches(DECISION_MAKER, t)),
    complaint: has('complaint'),
  };
}

export interface CrmFacts {
  openDeal: boolean;
  /** Customer messages in this conversation (capped by the query). */
  customerMessages: number;
  lastInboundAt: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * Lead score 0..100 from qualification flags plus CRM facts. Computed in code
 * only; a complaint or a health topic lowers it, recency and an open deal raise it.
 */
export function computeLeadScore(flags: QualificationFlags, intent: AssessIntent, facts: CrmFacts, now: number = Date.now()): number {
  let score = 10;
  if (flags.purchase_intent) score += 25;
  if (flags.asked_price) score += 15;
  if (flags.booking_intent) score += 20;
  if (flags.timeline_mentioned) score += 10;
  if (flags.budget_mentioned) score += 10;
  if (flags.decision_maker) score += 5;
  if (facts.openDeal) score += 10;
  if (facts.lastInboundAt) {
    const age = now - facts.lastInboundAt.getTime();
    if (age <= DAY_MS) score += 10;
    else if (age <= 7 * DAY_MS) score += 5;
  }
  if (facts.customerMessages >= 15) score += 10;
  else if (facts.customerMessages >= 5) score += 5;
  if (intent === 'complaint' || flags.complaint) score -= 15;
  if (intent === 'sensitive_health') score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}
