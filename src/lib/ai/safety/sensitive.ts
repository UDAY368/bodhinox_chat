// Deterministic classifier for health, medical and safety-sensitive customer
// messages, in English, Spanish, Portuguese, Korean and common Hinglish
// transliterations. Runs before any provider call: a sensitive latest
// customer turn gets no AI reply text; it is routed to qualified staff.
//
// Precision matters (a salon's "hair treatment" or a shop's "baby clothes" is
// not medical), so bare words that are common in ordinary commerce are left
// out and only clearly medical phrases are listed: "do I have to pay in
// advance", "can I take it as cabin luggage", "which size should I take",
// "is delivery guaranteed", "newborn sizes", "lump sum" or a dose of fun are
// shop questions, so "do i have", "can/should i take", "dose", "cure" and
// "newborn" count only next to a medical word. Recall gaps go to staff anyway
// through the claim guard on the output side.

export const SENSITIVE_CATEGORIES = [
  'medical_symptom_or_diagnosis',
  'treatment_or_dosage',
  'medicinal_claim',
  'emergency_self_harm',
  'pregnancy_child_health',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export interface SensitiveResult {
  sensitive: boolean;
  categories: SensitiveCategory[];
}

const b = (words: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${words})(?=$|[^\\p{L}\\p{N}])`, 'iu');
const any = (words: string) => new RegExp(`(?:${words})`, 'iu'); // scripts without word spacing (Korean)

const LEXICON: Record<SensitiveCategory, RegExp[]> = {
  medical_symptom_or_diagnosis: [
    b('symptoms?|diagnos(?:e|is|ed)|fever|rash|chest pain|headaches?|migraine|infection|infected|diabetes|diabetic|blood pressure|high bp|low bp|cancer|tumou?r|allerg(?:y|ic)|asthma|covid|swelling|swollen|bleeding|vomit(?:ing)?|nausea|dizz(?:y|iness)|cough(?:ing)?|sore throat|lump (?:in|on) my|thyroid|cholesterol|stomach (?:ache|pain)|back pain|pain in my|do i have (?:a |an )?(?:disease|infection|fever|cancer|diabetes|covid|the flu|flu|asthma|symptoms?)|what disease|is it serious|blurred vision|shortness of breath'),
    b('s[ií]ntomas?|diagn[oó]stico|fiebre|sarpullido|infecci[oó]n|alergia|sangrado|v[oó]mitos?|mareos?|tos|dolor de (?:cabeza|pecho|est[oó]mago|espalda)|presi[oó]n alta|diabetes'),
    b('sintomas?|diagn[oó]stico|febre|infec[cç][aã]o|alergia|sangramento|v[oô]mito|tontura|tosse|dor de (?:cabe[cç]a|peito|est[oô]mago|barriga)|press[aã]o alta'),
    any('증상|진단|열이 나|열이 있|통증|두통|감염|알레르기|출혈|구토|기침|어지러'),
    b('bukhar|bukhaar|sar ?dard|sir ?dard|pet ?dard|kamar ?dard|seene mein dard|khansi|khaansi|ulti|chakkar|bimari|beemari|tabiyat (?:kharab|theek nahi)|sugar (?:badh|high)|bp (?:badh|high)'),
  ],
  treatment_or_dosage: [
    b('dosage|dose of (?:medicines?|medication|tablets?|pills?|capsules?|syrup|paracetamol|ibuprofen|aspirin|antibiotics?|painkillers?|steroids?|supplements?)|how many (?:tablets|pills|mg)|which (?:medicine|tablet|pill)|what (?:medicine|tablet|pill)|prescri(?:be|ption)|antibiotics?|painkillers?|paracetamol|ibuprofen|aspirin|steroids?|side effects?|medication|medicine for|tablet for|cure for|(?:should|can) i take (?:this |these |that |the |my |a |an |any |some )?(?:medicines?|medication|tablets?|pills?|capsules?|syrup|paracetamol|ibuprofen|aspirin|antibiotics?|painkillers?|steroids?|supplements?)'),
    b('dosis|medicamentos?|receta m[eé]dica|antibi[oó]ticos?|tratamiento m[eé]dico|cura para|efectos secundarios|qu[eé] pastilla|puedo tomar (?:este |esta |el |la |un |una |unas? )?(?:medicamentos?|medicinas?|pastillas?|antibi[oó]ticos?|ibuprofeno|paracetamol|jarabe)'),
    b('dosagem|rem[eé]dio para|medicamentos?|receita m[eé]dica|antibi[oó]ticos?|tratamento m[eé]dico|cura para|efeitos colaterais|posso tomar (?:este |esta |o |a |um |uma )?(?:rem[eé]dios?|medicamentos?|comprimidos?|antibi[oó]ticos?|ibuprofeno|paracetamol|xarope)'),
    any('복용량|약을 먹|무슨 약|처방|항생제|치료법|부작용|진통제'),
    b('dawai|dawa|dawaai|kaunsi dawai|ilaa?j|tablet kitni|kitni goli'),
  ],
  medicinal_claim: [
    b('cures? (?:diabetes|cancer|acne|psoriasis|eczema|pcos|thyroid|arthritis|hair loss|baldness|infections?)|clinically proven|100% cure|reverses? (?:diabetes|ageing|aging|hair loss)|treats? (?:diabetes|cancer|acne|psoriasis|eczema|pcos|thyroid|arthritis)'),
    b('cura (?:la|el|para)|cl[ií]nicamente probado'),
    b('cura (?:a|o|para)|clinicamente comprovado'),
    any('완치|치료 효과|효능이 입증'),
    b('jadi ?buti|pakka ilaa?j|guaranteed ilaa?j'),
  ],
  emergency_self_harm: [
    b('suicid(?:e|al)|kill myself|self[- ]harm|want to die|end my life|overdose|can(?:no|\'?)t breathe|heart attack|stroke|unconscious|medical emergency|poison(?:ed|ing)?|hurt myself'),
    b('suicid(?:io|arme)|quitarme la vida|sobredosis|no puedo respirar|emergencia m[eé]dica|ataque al coraz[oó]n'),
    b('suic[ií]dio|me matar|overdose|n[aã]o consigo respirar|emerg[eê]ncia m[eé]dica|ataque card[ií]aco'),
    any('자살|죽고 싶|응급|숨을 못|심장마비'),
    b('marna chahta|marna chahti|mar jaana|khudkushi|atmahatya|saans nahi'),
  ],
  pregnancy_child_health: [
    b('pregnan(?:t|cy)|miscarriage|breastfeed(?:ing)?|(?:newborn|infant) (?:has|is)|my baby (?:has|is) (?:sick|ill|not|a fever)|missed (?:my )?period|period (?:is )?late|ivf|fertility'),
    b('embarazad[ao]|embarazo|aborto espont[aá]neo|lactancia|reci[eé]n nacido (?:tiene|est[aá]) (?:fiebre|enfermo)'),
    b('gr[aá]vida|gravidez|aborto espont[aâ]neo|amamenta[cç][aã]o|rec[eé]m[- ]nascido (?:tem|est[aá]) (?:febre|doente)'),
    any('임신|유산|모유 수유|신생아가 (?:아파|열이)'),
    b('pregnant hu|pregnant hoon|garbh|period miss|bachche ko bukhar|baby ko bukhar'),
  ],
};

/** Which sensitive categories `text` touches. Empty text is never sensitive. */
export function classifySensitive(text: string): SensitiveResult {
  const categories = SENSITIVE_CATEGORIES.filter((c) => LEXICON[c].some((re) => re.test(text)));
  return { sensitive: categories.length > 0, categories };
}

// Scripts the lexicons cover: Latin (en, es, pt, Hinglish) and Hangul (ko).
const UNCOVERED_SCRIPT = /[\p{Script=Telugu}\p{Script=Devanagari}\p{Script=Tamil}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Bengali}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Oriya}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Greek}]/u;

/** True when `text` uses a script the sensitive and claim lexicons do not cover. */
export function hasUncoveredScript(text: string): boolean {
  return UNCOVERED_SCRIPT.test(text);
}
